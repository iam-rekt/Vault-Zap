// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface IWrappedNative {
    function deposit() external payable;
}

/**
 * @title PulpVeVault
 * @notice Exact 10/20/30-day PULP locks with linearly decaying reward power.
 * @dev Not a voting token and not an upgradeable proxy. Power is
 *      amount * savedEntryMultiplier * remainingTime / 30 days.
 *
 *      Rewards settle by UTC day, proportional to the INTEGRAL of power during
 *      that day, not a single snapshot or the integral of instantaneous shares.
 *      Funding is additive across seven full FUTURE days. Closed-day weights
 *      and reward budgets cannot be changed by deposits or extensions.
 *
 *      Each position change schedules at most 31 days of exact integer areas.
 *      Twice the area is stored, including the 1e18 multiplier scale, so no
 *      rounding occurs in area bookkeeping. Only final payouts round down.
 *
 *      The owner's one-way `enableEmergencyExit` lets every lock withdraw at once and stops new
 *      principal, extensions and funding. It moves no tokens. Rewards stop at the switch second
 *      `exitTimestamp`: every day before the exit day is paid as usual; the exit day is paid as if it
 *      had ended at the switch (its budget times the elapsed fraction of the day, split by the area each
 *      lock accrued before the switch); the rest of the exit day and every later day go back to the
 *      treasury (`releasePostExitRewards`/`releaseEmptyRewards`, then `recoverExcess`). Everything the
 *      owner can recover goes only to `treasury`, which changes only by a two-step handover that the new
 *      address can complete no sooner than TREASURY_DELAY (8 days) after the proposal and after the last
 *      release, and only once no reward token has a budget left that is not yet earned (see `acceptTreasury`).
 *      So a new treasury never receives rewards funded before it took over, except budgets of days on which
 *      no lock had any power and unclaimed rewards whose claim deadline ends after the change. The treasury
 *      itself may also trigger recoveries, so a sweep of what was already released can never be held back
 *      until a new treasury takes over.
 *
 *      A removed reward token that is still owed is "retired": still claimable, for CLAIM_DEADLINE (120
 *      days). Then anyone can `expireRewardToken` it: what is still unclaimed goes to the treasury and the
 *      token can never be a reward token again.
 */
contract PulpVeVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DAY = 1 days;
    uint256 public constant MIN_LOCK_TIME = 10 days;
    uint256 public constant MAX_LOCK_TIME = 30 days;
    uint256 public constant WAD = 1e18;
    uint256 public constant REWARD_DAYS = 7;
    // Active reward tokens (claimAll pays them; only they can be funded).
    uint256 public constant MAX_REWARD_TOKENS = 5;
    // Removed tokens still owed (retired). Each can be expired CLAIM_DEADLINE after it was retired.
    uint256 public constant MAX_RETIRED_REWARD_TOKENS = 10;
    // How long a retired token stays claimable. Afterwards `expireRewardToken` closes its books.
    uint256 public constant CLAIM_DEADLINE = 120 days;
    uint256 public constant MAX_CLAIM_EPOCHS = 64;
    // Bounds boosted principal and all 31-day area arithmetic well below uint256.
    uint256 public constant MAX_TOTAL_LOCKED = type(uint128).max;
    // Hard cap on the compound fee: 2%. The owner can lower or raise it within this, never past it.
    uint16 public constant MAX_COMPOUND_FEE_BPS = 200;
    // A proposed treasury can accept only this long after the proposal, so the community has 8 days to react
    // to `TreasuryProposed`. On its own the delay does not protect funded rewards (a budget can lie far ahead,
    // before launch, or be re-scheduled by recycling): acceptance also waits until nothing is left unearned.
    uint256 public constant TREASURY_DELAY = 8 days;
    uint256 private constant BPS = 10_000;
    // Granularity of the lock-end index used once, at the switch (see `_scheduledAfter`). Divides DAY.
    uint256 private constant END_BUCKET = 600;
    // Gas for each `balanceOf` read in the recovery reserve check (a hostile token can't eat the rest).
    uint256 private constant BALANCE_READ_GAS = 100_000;

    struct Config {
        address pulp;
        address weth; // zero disables native funding
        address owner;
        address distributor;
        uint256 launchStart; // 00:00 UTC of some day
        uint256 earlyWindow;
        uint256 minLockAmount;
        uint16 compoundFeeBps; // <= MAX_COMPOUND_FEE_BPS
        address treasury; // receives compound fees and everything recovered; required
    }

    struct Lock {
        uint256 amount;
        // Sum of amount_i * entryMultiplier_i (WAD), with no division/rounding.
        uint256 boosted;
        uint256 end;
    }

    // A lock's trajectory at the switch, kept when that lock is withdrawn after it (only if it ran past it).
    struct ExitLock {
        uint192 boosted;
        uint64 end;
    }

    // Sums over live lock trajectories ending in one END_BUCKET (r = end % END_BUCKET) or one day (r = end % DAY).
    struct BucketEnds {
        uint256 boosted;
        uint256 boostedR;
        uint256 boostedR2;
    }

    struct DayEnds {
        uint256 boosted;
        uint256 boostedR;
    }

    IERC20 public immutable pulp;
    address public immutable weth;
    uint256 public immutable launchStart;
    uint256 public immutable earlyWindow;
    uint256 public immutable minLockAmount;

    mapping(address => Lock) public locks;
    uint256 public totalLocked;
    bool public locksPaused;
    // Packed with locksPaused. Receives compound fees and everything `recoverERC20`/`recoverExcess` move.
    // Set at deploy; changes only by `proposeTreasury` (owner) + `acceptTreasury` (the new address,
    // TREASURY_DELAY later).
    address public treasury;
    // Also packed. Only `compound` charges this; `claim` never does.
    uint16 public compoundFeeBps;
    // Also packed. One-way: once true, never false again. See `enableEmergencyExit`.
    bool public emergencyExit;
    // Also packed. The second the exit was enabled; 0 while `emergencyExit` is off.
    uint64 public exitTimestamp;
    address public pendingTreasury;
    // Packed with pendingTreasury. When the pending proposal was made (0 if none); it can be accepted from
    // treasuryProposedAt + TREASURY_DELAY. Cleared on acceptance, cancellation and every ownership change.
    uint64 public treasuryProposedAt;
    // Total area accrued on the exit day before `exitTimestamp` (the denominator for that day's payouts).
    uint256 public exitDayTotalArea;
    // The last time rewards left the books (`enableEmergencyExit`, a release, `expireRewardToken`). A pending
    // treasury can accept only TREASURY_DELAY after it too, so the current treasury always has 8 days to sweep
    // released funds before a new one could.
    uint256 public lastReleasedAt;
    mapping(address => bool) public isDistributor;

    // Units: 2 * integral(boosted * remainingSeconds dt). Common normalization
    // factors cancel in userArea / totalArea. Epoch number = timestamp / DAY.
    // Frozen once the emergency exit is on: nothing writes them after the switch.
    mapping(uint256 => uint256) public totalEpochArea;
    mapping(address => mapping(uint256 => uint256)) public userEpochArea;
    mapping(address => uint256[]) private _userEpochs;

    // Active reward tokens: claimAll pays these, only these can be funded.
    address[] public rewardTokens;
    mapping(address => bool) public isRewardToken;
    // Removed while something was still owed: still claimable, reserved and protected, never fundable.
    address[] private _retiredRewardTokens;
    mapping(address => bool) public isRetiredRewardToken;
    // When a retired token was retired (0 otherwise). It can be expired from retiredAt + CLAIM_DEADLINE.
    mapping(address => uint256) public retiredAt;
    // Expired: no books any more (claims revert NotRewardToken), and never a reward token again, so its old
    // `epochRewards` and cursors can never be read as an entitlement again.
    mapping(address => bool) public isExpiredRewardToken;
    mapping(address => mapping(uint256 => uint256)) public epochRewards;
    mapping(address => mapping(address => uint256)) public claimCursor;
    mapping(address => uint256) public totalNotified;
    mapping(address => uint256) public totalPaid;
    // Budgets taken off the books after emergency exit: the unearned part of the exit day, every later
    // day, and closed zero-area days.
    mapping(address => uint256) public totalReleased;

    mapping(address => ExitLock) private _exitLocks;
    // Index of live lock trajectories by end second, used only by `enableEmergencyExit`.
    mapping(uint256 => uint256) private _endsAt;
    mapping(uint256 => BucketEnds) private _endsInBucket;
    mapping(uint256 => DayEnds) private _endsOnDay;

    event Locked(address indexed user, uint256 amount, uint256 daysLocked, uint256 end, uint256 power);
    event Increased(address indexed user, uint256 amount, uint256 entryMultiplier, uint256 power);
    event Extended(address indexed user, uint256 oldEnd, uint256 newEnd, uint256 power, bool restarted);
    event Withdrawn(address indexed user, uint256 amount);
    // After the emergency exit, a lock withdrawn before its end: also logs Withdrawn.
    event EarlyWithdrawn(address indexed user, uint256 amount, uint256 oldEnd);
    // From lockFor/increaseAmountFor, after Locked/Increased (whose `user` stays the lock owner).
    event DepositedFor(address indexed payer, address indexed beneficiary, uint256 amount);
    // Extra to RewardPaid/Increased: `amount` was re-locked, not transferred; `fee` went to the treasury.
    // RewardPaid carries the whole page (amount + fee). See docs/TECHNICAL.md (compound fee).
    event Compounded(address indexed user, uint256 amount, uint256 fee, uint256 nextCursor);
    event RewardNotified(address indexed token, address indexed funder, uint256 amount);
    event RewardsScheduled(address indexed token, uint256 amount, uint256 firstEpoch, uint256 lastEpoch);
    event EmptyRewardsRecycled(address indexed token, uint256 indexed emptyEpoch, uint256 amount);
    event RewardPaid(address indexed user, address indexed token, uint256 amount, uint256 nextCursor);
    // claimTo/claimAllTo: the page RewardPaid logged for `user` was sent to `to`.
    event RewardSentTo(address indexed user, address indexed token, address indexed to, uint256 amount);
    event RewardTokenAdded(address indexed token);
    event RewardTokenRemoved(address indexed token, bool retired);
    // Unclaimed `forfeited` left the books (into totalReleased): sweepable to the treasury by `recoverExcess`.
    event RewardTokenExpired(address indexed token, uint256 forfeited);
    event DistributorSet(address indexed distributor, bool allowed);
    event LocksPausedSet(bool paused);
    event CompoundFeeSet(uint16 feeBps);
    event TreasuryProposed(address indexed proposed);
    event TreasuryChanged(address indexed previous, address indexed current);
    event Recovered(address indexed token, address indexed to, uint256 amount);
    event EmergencyExitEnabled(uint256 indexed exitEpoch, uint256 exitTimestamp, uint256 exitDayTotalArea);
    event EmptyRewardsReleased(address indexed token, uint256 indexed epoch, uint256 amount);

    error BadConfig();
    error NotAContract();
    error ZeroAddress();
    error NotLaunched();
    error LocksArePaused();
    error LockExists();
    error NoLock();
    error LockExpired();
    error LockActive();
    error BadDuration();
    error AmountTooSmall();
    error LockCapExceeded();
    error ExtendFirst();
    error InvalidBeneficiary();
    error NothingToCompound();
    error UnsupportedTransfer();
    error NotDistributor();
    error NotRewardToken();
    error RewardTokenExists();
    error TooManyRewardTokens();
    error RewardsStillScheduled();
    error UnearnedRewardsScheduled(address token, uint256 epoch);
    error NotRetiredRewardToken();
    error ClaimDeadlineNotReached(uint256 expiresAt);
    error ExpiredRewardToken();
    error InvalidRewardToken();
    error NothingToFund();
    error NativeDisabled();
    error BadClaimLimit();
    error EpochNotClosed();
    error EpochHasPower();
    error ProtectedToken();
    error NothingToRecover();
    error ReserveBreached(address token);
    error NativeTransferFailed();
    error RenounceDisabled();
    error FeeTooHigh();
    error InvalidTreasury();
    error NotPendingTreasury();
    error TreasuryDelayNotOver(uint256 acceptableAt);
    error EmergencyExitActive();
    error EmergencyExitOff();
    error FeeAboveMax();

    modifier onlyDistributor() {
        if (!isDistributor[msg.sender]) revert NotDistributor();
        _;
    }

    /// @dev Calls that would add principal, area or reward budget. Emergency exit is checked first.
    modifier whenNotExited() {
        if (emergencyExit) revert EmergencyExitActive();
        _;
    }

    /// @dev Recoveries: the owner, or the treasury (their only destination) pulling what is its own.
    modifier onlyOwnerOrTreasury() {
        if (msg.sender != owner() && msg.sender != treasury) revert OwnableUnauthorizedAccount(msg.sender);
        _;
    }

    modifier whenLocksOpen() {
        if (emergencyExit) revert EmergencyExitActive();
        if (locksPaused) revert LocksArePaused();
        _;
    }

    constructor(Config memory c) Ownable(c.owner) {
        if (c.pulp.code.length == 0) revert NotAContract();
        if (c.weth != address(0) && c.weth.code.length == 0) revert NotAContract();
        if (c.distributor == address(0)) revert ZeroAddress();
        if (
            c.pulp == c.weth || c.launchStart < block.timestamp || c.launchStart % DAY != 0 ||
            c.launchStart > type(uint64).max - MAX_LOCK_TIME ||
            c.earlyWindow == 0 || c.earlyWindow > MAX_LOCK_TIME ||
            c.minLockAmount == 0 || c.minLockAmount > MAX_TOTAL_LOCKED
        ) revert BadConfig();
        if (c.compoundFeeBps > MAX_COMPOUND_FEE_BPS) revert FeeTooHigh();
        pulp = IERC20(c.pulp);
        weth = c.weth;
        launchStart = c.launchStart;
        earlyWindow = c.earlyWindow;
        minLockAmount = c.minLockAmount;
        isDistributor[c.distributor] = true;
        emit DistributorSet(c.distributor, true);
        compoundFeeBps = c.compoundFeeBps;
        emit CompoundFeeSet(c.compoundFeeBps);
        if (c.weth != address(0)) _addRewardToken(c.weth);
        // After WETH is registered, so the treasury cannot be a reward token.
        _checkTreasury(c.treasury);
        treasury = c.treasury;
        emit TreasuryChanged(address(0), c.treasury);
    }

    /// @notice Entry multiplier, from 2e18 at launch immediately down to 1e18.
    /// @dev A quote before launch does not make deposits possible before launch.
    function entryMultiplier(uint256 timestamp) public view returns (uint256) {
        if (timestamp <= launchStart) return 2 * WAD;
        uint256 elapsed = timestamp - launchStart;
        if (elapsed >= earlyWindow) return WAD;
        return WAD + Math.mulDiv(WAD, earlyWindow - elapsed, earlyWindow);
    }

    function powerOf(address user) public view returns (uint256) {
        Lock memory l = locks[user];
        if (block.timestamp >= l.end) return 0;
        return Math.mulDiv(l.boosted, l.end - block.timestamp, MAX_LOCK_TIME * WAD);
    }

    function previewPower(uint256 amount, uint256 daysLocked) external view returns (uint256) {
        _checkDuration(daysLocked);
        if (amount > MAX_TOTAL_LOCKED) revert LockCapExceeded();
        return Math.mulDiv(amount * entryMultiplier(block.timestamp), daysLocked * DAY, MAX_LOCK_TIME * WAD);
    }

    /// @notice Deposit for exactly 10, 20 or 30 days, with no calendar rounding.
    function lock(uint256 amount, uint256 daysLocked) external nonReentrant whenLocksOpen {
        _lock(msg.sender, amount, daysLocked);
    }

    /// @notice Open `beneficiary`'s one lock with the caller's PULP. Same rules as `lock`.
    /// @dev The position belongs wholly to `beneficiary`; the payer keeps no claim on it. Permissionless,
    ///      so an address with no lock can be given one, after which its own `lock` reverts LockExists:
    ///      add to it with `increaseAmount`/`extend` instead. See docs/TECHNICAL.md (delegated deposits).
    function lockFor(address beneficiary, uint256 amount, uint256 daysLocked)
        external nonReentrant whenLocksOpen
    {
        _checkBeneficiary(beneficiary);
        _lock(beneficiary, amount, daysLocked);
        emit DepositedFor(msg.sender, beneficiary, amount);
    }

    /// @notice New principal gets today's entry multiplier, not the old bonus.
    /// @dev New capital must still commit for at least 10 days; extend first if needed.
    function increaseAmount(uint256 amount) external nonReentrant whenLocksOpen {
        _increase(msg.sender, amount);
    }

    /// @notice Add the caller's PULP to `beneficiary`'s lock. Same rules as `increaseAmount`;
    ///         it cannot move the unlock time or reprice the existing principal.
    function increaseAmountFor(address beneficiary, uint256 amount) external nonReentrant whenLocksOpen {
        _checkBeneficiary(beneficiary);
        _increase(beneficiary, amount);
        emit DepositedFor(msg.sender, beneficiary, amount);
    }

    /// @notice Re-lock one claim page of the caller's closed-day PULP rewards into their own lock,
    ///         exactly like `increaseAmount` (today's multiplier, 10+ days left, not while paused),
    ///         minus a fee of `compoundFeeBps` (at most 2%, rounded down) paid to the treasury.
    ///         Reverts `FeeAboveMax` if the fee is above the caller's `maxFeeBps`, so a fee raised
    ///         between the quote and the transaction cannot be charged. It is a convenience fee:
    ///         `claim(pulp, n)` + `increaseAmount` does the same with no fee.
    /// @dev The whole page leaves the reward books (totalPaid); `amount` joins principal (totalLocked)
    ///      and stays in the vault; only `fee` is transferred, last. So `reserved(pulp)` and the PULP
    ///      balance both drop by exactly `fee`. A page worth zero after the fee reverts
    ///      NothingToCompound; `claim(pulp, n)` pages past it, fee-free.
    /// @return amount PULP added to the caller's principal (the page minus the fee).
    function compound(uint256 maxEpochs, uint16 maxFeeBps)
        external nonReentrant whenLocksOpen returns (uint256 amount)
    {
        address token = address(pulp);
        if (!isRewardToken[token]) revert NotRewardToken();
        _checkClaimLimit(maxEpochs);
        if (compoundFeeBps > maxFeeBps) revert FeeAboveMax();
        Lock storage l = locks[msg.sender];
        _checkTopUpWindow(l);
        (uint256 rewards, uint256 nextCursor) = _settle(msg.sender, token, maxEpochs);
        uint256 fee = Math.mulDiv(rewards, compoundFeeBps, BPS);
        amount = rewards - fee;
        // Both checks revert the whole settlement above, including cursor and totalPaid.
        if (amount == 0) revert NothingToCompound();
        _checkCapacity(amount);
        _addPrincipal(msg.sender, l, amount);
        emit Compounded(msg.sender, amount, fee, nextCursor);
        // The only external call, after every state change.
        if (fee != 0) pulp.safeTransfer(treasury, fee);
    }

    /// @notice Reset remaining time to 10/20/30 days from now, not an addition.
    /// @dev Active extensions keep the saved bonus. At/after expiry, restart at
    ///      today's entry multiplier. Neither path rewrites already accrued area.
    ///      Blocked after emergency exit: a lock that no longer binds earns no new area.
    function extend(uint256 daysLocked) external nonReentrant whenNotExited {
        Lock storage l = locks[msg.sender];
        if (l.amount == 0) revert NoLock();
        _checkDuration(daysLocked);
        uint256 oldEnd = l.end;
        uint256 newEnd = block.timestamp + daysLocked * DAY;
        bool restarted = block.timestamp >= oldEnd;
        if (restarted) {
            l.boosted = l.amount * entryMultiplier(block.timestamp);
        } else {
            if (newEnd <= oldEnd) revert BadDuration();
            _schedulePower(msg.sender, l.boosted, oldEnd, false);
        }
        l.end = newEnd;
        _schedulePower(msg.sender, l.boosted, newEnd, true);
        emit Extended(msg.sender, oldEnd, newEnd, powerOf(msg.sender), restarted);
    }

    /// @notice Principal exit does not process, discard, or depend on reward claims.
    /// @dev After emergency exit an active lock can leave too. No area is touched: areas are frozen at
    ///      the switch, and only area accrued before the switch is ever paid. A lock that ran past the
    ///      switch leaves its trajectory (boosted, end) behind so its exit-day share stays computable.
    function withdraw() external nonReentrant {
        Lock memory l = locks[msg.sender];
        if (l.amount == 0) revert NoLock();
        bool early = block.timestamp < l.end;
        if (emergencyExit) {
            if (l.end > exitTimestamp) {
                _exitLocks[msg.sender] = ExitLock(SafeCast.toUint192(l.boosted), SafeCast.toUint64(l.end));
            }
        } else if (early) {
            revert LockActive();
        }
        totalLocked -= l.amount;
        delete locks[msg.sender];
        pulp.safeTransfer(msg.sender, l.amount);
        emit Withdrawn(msg.sender, l.amount);
        if (early) emit EarlyWithdrawn(msg.sender, l.amount, l.end);
    }

    /// @notice Fund the next seven full UTC days. Existing schedules never move.
    function notifyRewardAmount(address token, uint256 amount)
        external nonReentrant onlyDistributor whenNotExited
    {
        if (!isRewardToken[token]) revert NotRewardToken();
        if (amount == 0) revert NothingToFund();
        _pullExact(IERC20(token), amount);
        totalNotified[token] += amount;
        emit RewardNotified(token, msg.sender, amount);
        _scheduleRewards(token, amount);
    }

    /// @notice Native fees are wrapped and paid to lockers as the configured wrapped token.
    function notifyRewardETH() external payable nonReentrant onlyDistributor whenNotExited {
        _fundNative();
    }

    /// @notice A normal native transfer from an authorized distributor also funds rewards.
    receive() external payable nonReentrant onlyDistributor whenNotExited {
        _fundNative();
    }

    /// @notice Re-use a closed day's budget ONLY if nobody accumulated any power.
    /// @dev Permissionless and single-use. Never recycles rounding dust or unclaimed rewards.
    ///      After emergency exit future days can only lose area, so use `releaseEmptyRewards` instead.
    function recycleEmptyRewards(address token, uint256 epoch) external nonReentrant whenNotExited {
        if (!isRewardToken[token]) revert NotRewardToken();
        if (epoch >= block.timestamp / DAY) revert EpochNotClosed();
        if (totalEpochArea[epoch] != 0) revert EpochHasPower();
        uint256 amount = epochRewards[token][epoch];
        if (amount == 0) revert NothingToFund();
        epochRewards[token][epoch] = 0;
        _scheduleRewards(token, amount);
        emit EmptyRewardsRecycled(token, epoch, amount);
    }

    /// @notice After emergency exit, take a day's budget off the books that nobody can ever be paid:
    ///         any day after the exit day, or an earlier day with zero power.
    /// @dev Permissionless and single-use. The unearned part of the exit day was already released by
    ///      the switch; its earned part is owed (`EpochHasPower`) unless nobody accrued area before the
    ///      switch, in which case the switch released it all. Days before the exit day were all closed
    ///      before the switch, so their areas are final; one with zero total area can never be earned.
    ///      The budget leaves `reserved` and only then becomes reachable by `recoverExcess`.
    function releaseEmptyRewards(address token, uint256 epoch) external nonReentrant {
        if (!emergencyExit) revert EmergencyExitOff();
        if (!_hasBooks(token)) revert NotRewardToken();
        uint256 exitDay = exitEpoch();
        if (epoch < exitDay ? totalEpochArea[epoch] != 0 : (epoch == exitDay && exitDayTotalArea != 0)) {
            revert EpochHasPower();
        }
        if (_release(token, epoch) == 0) revert NothingToFund();
    }

    /// @notice After emergency exit, release every funded day after the exit day for `token` in one call.
    /// @dev Permissionless. Every budget was scheduled before the switch, on some day `t <= exitEpoch`, over
    ///      the seven days from `max(t + 1, launch day)`. So every budget after `exitEpoch` lies in the seven
    ///      days from `max(exitEpoch + 1, launch day)`. Reverts NothingToFund if none is left.
    /// @return amount Total released.
    function releasePostExitRewards(address token) external nonReentrant returns (uint256 amount) {
        if (!emergencyExit) revert EmergencyExitOff();
        if (!_hasBooks(token)) revert NotRewardToken();
        uint256 first = Math.max(uint256(exitEpoch()) + 1, Math.ceilDiv(launchStart, DAY));
        for (uint256 i; i < REWARD_DAYS; ++i) amount += _release(token, first + i);
        if (amount == 0) revert NothingToFund();
    }

    /// @notice Claim up to 64 recorded days. Repeat for longer histories.
    /// @dev Individual-token claiming prevents one bad reward token blocking another. Works for retired
    ///      (removed but still owed) tokens too, until they are expired (CLAIM_DEADLINE after retirement).
    ///      `RewardPaid` is logged for every settled page, also when it pays 0 (the cursor still moves).
    function claim(address token, uint256 maxEpochs) external nonReentrant returns (uint256 amount) {
        if (!_hasBooks(token)) revert NotRewardToken();
        _checkClaimLimit(maxEpochs);
        return _claim(msg.sender, token, maxEpochs, msg.sender);
    }

    /// @notice Like `claim`, but the caller's own page is sent to `to` (for example when the caller's
    ///         address is blocked by the reward token).
    function claimTo(address token, uint256 maxEpochs, address to) external nonReentrant returns (uint256 amount) {
        if (!_hasBooks(token)) revert NotRewardToken();
        _checkClaimLimit(maxEpochs);
        _checkBeneficiary(to);
        amount = _claim(msg.sender, token, maxEpochs, to);
        emit RewardSentTo(msg.sender, token, to, amount);
    }

    /// @notice One page of every active reward token. Retired tokens: use `claim`.
    function claimAll(uint256 maxEpochs) external nonReentrant {
        _checkClaimLimit(maxEpochs);
        for (uint256 i; i < rewardTokens.length; ++i) _claim(msg.sender, rewardTokens[i], maxEpochs, msg.sender);
    }

    /// @notice `claimAll`, sent to `to`.
    function claimAllTo(uint256 maxEpochs, address to) external nonReentrant {
        _checkClaimLimit(maxEpochs);
        _checkBeneficiary(to);
        for (uint256 i; i < rewardTokens.length; ++i) {
            address token = rewardTokens[i];
            emit RewardSentTo(msg.sender, token, to, _claim(msg.sender, token, maxEpochs, to));
        }
    }

    /// @notice FINAL entitlement on the next bounded page; not open-day estimates. Before the exit only
    ///         closed days; after it every day up to and including the exit day (paid up to the switch).
    /// @return amount Tokens payable for the page.
    /// @return nextCursor Index after processing the page.
    /// @return caughtUp True if no further payable recorded days remain.
    function claimable(address user, address token, uint256 maxEpochs)
        public view returns (uint256 amount, uint256 nextCursor, bool caughtUp)
    {
        if (!_hasBooks(token)) revert NotRewardToken();
        _checkClaimLimit(maxEpochs);
        uint256[] storage epochs = _userEpochs[user];
        nextCursor = claimCursor[user][token];
        uint256 limit = Math.min(epochs.length, nextCursor + maxEpochs);
        bool exited = emergencyExit;
        uint256 exitDay = exitEpoch();
        // First unpayable day: today (still open) or, after the exit, the day after the exit day. Before the
        // switch a page stopped before today, which is at most the exit day, so no cursor is past it.
        uint256 stop = exited ? exitDay + 1 : block.timestamp / DAY;
        while (nextCursor < limit && epochs[nextCursor] < stop) {
            uint256 epoch = epochs[nextCursor];
            uint256 budget = epochRewards[token][epoch];
            if (budget != 0) {
                if (exited && epoch == exitDay) {
                    uint256 area = exitDayArea(user);
                    if (area != 0) amount += Math.mulDiv(budget, area, exitDayTotalArea);
                } else {
                    uint256 area = userEpochArea[user][epoch];
                    if (area != 0) amount += Math.mulDiv(budget, area, totalEpochArea[epoch]);
                }
            }
            ++nextCursor;
        }
        caughtUp = nextCursor == epochs.length || epochs[nextCursor] >= stop;
    }

    /// @notice The UTC day of the switch (`exitTimestamp / DAY`); 0 while the exit is off.
    function exitEpoch() public view returns (uint64) {
        return exitTimestamp / uint64(DAY);
    }

    /// @notice Area `user` accrued on the exit day before the switch (0 while the exit is off). That day
    ///         pays `epochRewards(token, exitEpoch)` (already scaled to the elapsed part of the day) times
    ///         this over `exitDayTotalArea`.
    function exitDayArea(address user) public view returns (uint256) {
        if (!emergencyExit) return 0;
        uint256 x = exitTimestamp;
        uint256 day = x / DAY;
        uint256 area = userEpochArea[user][day];
        if (area == 0) return 0;
        // The trajectory that ran at the switch: the lock itself, or what it left behind when withdrawn.
        Lock storage l = locks[user];
        uint256 boosted;
        uint256 end;
        if (l.amount != 0) {
            (boosted, end) = (l.boosted, l.end);
        } else {
            ExitLock memory s = _exitLocks[user];
            (boosted, end) = (s.boosted, s.end);
        }
        return _zeroFloorSub(area, _areaAfter(boosted, end, x, (day + 1) * DAY));
    }

    function userEpochCount(address user) external view returns (uint256) {
        return _userEpochs[user].length;
    }

    function userEpochAt(address user, uint256 index) external view returns (uint256) {
        return _userEpochs[user][index];
    }

    function getRewardTokens() external view returns (address[] memory) {
        return rewardTokens;
    }

    function getRetiredRewardTokens() external view returns (address[] memory) {
        return _retiredRewardTokens;
    }

    /// @notice Register a reward token, or reactivate a retired one.
    function addRewardToken(address token) external onlyOwner nonReentrant {
        _addRewardToken(token);
    }

    /// @notice Stop paying `token` in `claimAll` and stop funding it. Allowed only once no budget is left on
    ///         any open or future day (before the exit: today and later; after it: every day after the exit
    ///         day, which can be released first), so every entitlement is final. If nothing is owed any more
    ///         (notified == paid + released) the token is dropped entirely. Otherwise it is retired (at most
    ///         MAX_RETIRED_REWARD_TOKENS at once): still claimable with `claim`/`claimTo`, still in `reserved`,
    ///         still protected from recovery, for CLAIM_DEADLINE; then anyone can `expireRewardToken` it.
    function removeRewardToken(address token) external onlyOwner nonReentrant {
        if (!isRewardToken[token]) revert NotRewardToken();
        (bool scheduled,) = _scheduledDay(token, _firstUnsettledDay());
        if (scheduled) revert RewardsStillScheduled();
        _removeFrom(rewardTokens, token);
        isRewardToken[token] = false;
        bool retired = totalNotified[token] != totalPaid[token] + totalReleased[token];
        if (retired) {
            if (_retiredRewardTokens.length >= MAX_RETIRED_REWARD_TOKENS) revert TooManyRewardTokens();
            isRetiredRewardToken[token] = true;
            retiredAt[token] = block.timestamp;
            _retiredRewardTokens.push(token);
        }
        emit RewardTokenRemoved(token, retired);
    }

    /// @notice The claim deadline: CLAIM_DEADLINE (120 days) after `token` was retired, anyone may close its
    ///         books. Whatever is still unclaimed (notified - paid - released: unclaimed rewards, rounding dust,
    ///         budgets of days nobody had power on) moves to `totalReleased`, so it leaves `reserved` and
    ///         `recoverExcess` sweeps it to the treasury. The token leaves the retired list and loses its books:
    ///         `claim`/`claimable` for it revert NotRewardToken. It can never be added again (ExpiredRewardToken),
    ///         so no old day budget or cursor can ever pay out twice.
    /// @dev Permissionless: it only applies a published deadline, and only ever frees a retired slot.
    /// @return forfeited What was still owed and is now released.
    function expireRewardToken(address token) external nonReentrant returns (uint256 forfeited) {
        if (!isRetiredRewardToken[token]) revert NotRetiredRewardToken();
        uint256 expiresAt = retiredAt[token] + CLAIM_DEADLINE;
        if (block.timestamp < expiresAt) revert ClaimDeadlineNotReached(expiresAt);
        forfeited = totalNotified[token] - totalPaid[token] - totalReleased[token];
        totalReleased[token] += forfeited;
        if (forfeited != 0) lastReleasedAt = block.timestamp;
        isRetiredRewardToken[token] = false;
        delete retiredAt[token];
        isExpiredRewardToken[token] = true;
        _removeFrom(_retiredRewardTokens, token);
        emit RewardTokenExpired(token, forfeited);
    }

    function setDistributor(address distributor, bool allowed) external onlyOwner {
        if (distributor == address(0)) revert ZeroAddress();
        isDistributor[distributor] = allowed;
        emit DistributorSet(distributor, allowed);
    }

    /// @notice Pauses only incoming principal. Extensions, withdrawal and claims stay open.
    function setLocksPaused(bool paused) external onlyOwner {
        locksPaused = paused;
        emit LocksPausedSet(paused);
    }

    /// @notice Fee on `compound` only, in basis points, at most MAX_COMPOUND_FEE_BPS. Paid to the treasury.
    function setCompoundFee(uint16 feeBps) external onlyOwner {
        if (feeBps > MAX_COMPOUND_FEE_BPS) revert FeeTooHigh();
        compoundFeeBps = feeBps;
        emit CompoundFeeSet(feeBps);
    }

    /// @notice Step one of a treasury change: the new address may call `acceptTreasury` from
    ///         `treasuryProposedAt + TREASURY_DELAY` (8 days) on, once every funded budget has been earned.
    ///         Every proposal, even of the same address, restarts the clock; zero cancels. Watch
    ///         `TreasuryProposed`: there are 8 days to react. The distributor should stop funding meanwhile.
    function proposeTreasury(address newTreasury) external onlyOwner {
        if (newTreasury != address(0)) _checkTreasury(newTreasury);
        pendingTreasury = newTreasury;
        treasuryProposedAt = newTreasury == address(0) ? 0 : SafeCast.toUint64(block.timestamp);
        emit TreasuryProposed(newTreasury);
    }

    /// @notice Step two: the proposed treasury takes over, once TREASURY_DELAY has passed since the proposal
    ///         and since the last release (`lastReleasedAt`), and no reward token (active or retired) has a
    ///         budget on any day not yet earned: before the exit today or later (with funding before launch:
    ///         the 7 days from launch), after it every day after the exit day. So a new treasury can never
    ///         receive rewards funded before it took over: they must all have been earned first, or released
    ///         at least 8 days earlier, in which case the current treasury had those 8 days to sweep them.
    /// @dev The window is the one `removeRewardToken` scans: every such budget lies in the 8 days from
    ///      `_firstUnsettledDay()`. Reverts UnearnedRewardsScheduled(token, day) with the first one found.
    ///      Without the release clock, a compromised owner could exit, release and accept in one block.
    function acceptTreasury() external {
        address next = pendingTreasury;
        if (msg.sender != next) revert NotPendingTreasury();
        uint256 acceptableAt = Math.max(treasuryProposedAt, lastReleasedAt) + TREASURY_DELAY;
        if (block.timestamp < acceptableAt) revert TreasuryDelayNotOver(acceptableAt);
        uint256 first = _firstUnsettledDay();
        _checkNothingScheduled(rewardTokens, first);
        _checkNothingScheduled(_retiredRewardTokens, first); // none by construction; checked anyway
        _checkTreasury(next); // a reward token may have been registered since the proposal
        emit TreasuryChanged(treasury, next);
        treasury = next;
        pendingTreasury = address(0);
        treasuryProposedAt = 0;
    }

    /// @notice ONE-WAY: every lock may `withdraw` now, whatever its `end`. Cannot be turned off.
    /// @dev Moves no tokens and changes no lock or area. It lifts the time condition on `withdraw` and
    ///      blocks what would add principal, area or budget (lock, lockFor, increaseAmount(For), compound,
    ///      extend, funding and recycling). Rewards stop at this second: days before today stay payable by
    ///      area; today pays its budget times the elapsed fraction of the day, split by the area each lock
    ///      accrued before now (all of that is final: nothing can write before now); the unearned rest of
    ///      today is released here, and later days can be released. So no locker gains by staying or
    ///      leaving, and timing the switch only moves rewards nobody had earned yet. See docs/TECHNICAL.md.
    function enableEmergencyExit() external onlyOwner {
        if (emergencyExit) revert EmergencyExitActive();
        uint256 x = block.timestamp;
        uint256 day = x / DAY;
        // Exactly the area accrued before now (see `_scheduledAfter`). Saturating only so that the switch can
        // never revert: by construction the scheduled part after now is at most the day's total.
        uint256 total = _zeroFloorSub(totalEpochArea[day], _scheduledAfter(x));
        emergencyExit = true;
        exitTimestamp = SafeCast.toUint64(x);
        exitDayTotalArea = total;
        lastReleasedAt = x;
        uint256 elapsed = x - day * DAY;
        _scaleExitDay(rewardTokens, day, elapsed, total);
        _scaleExitDay(_retiredRewardTokens, day, elapsed, total); // none have a budget here; kept for safety
        emit EmergencyExitEnabled(day, x, total);
    }

    /// @notice Keep operational settings recoverable; transfer to a multisig/DAO instead.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @dev Every ownership change (`acceptOwnership`; also the constructor, with nothing pending) cancels a
    ///      pending treasury proposal, so one made by a previous owner (say, a deployer's hot key) can never
    ///      be accepted under the new one.
    function _transferOwnership(address newOwner) internal override {
        if (pendingTreasury != address(0)) {
            pendingTreasury = address(0);
            treasuryProposedAt = 0;
            emit TreasuryProposed(address(0));
        }
        super._transferOwnership(newOwner);
    }

    /// @notice Send an unrelated token sent here by mistake to the treasury. PULP and every token with
    ///         reward books are refused, and no protected balance may fall below what is owed.
    ///         Owner or treasury.
    function recoverERC20(address token, uint256 amount) external onlyOwnerOrTreasury nonReentrant {
        if (token == address(pulp) || _hasBooks(token)) revert ProtectedToken();
        address to = treasury;
        (address[] memory protectedTokens, uint256[] memory before) = _protectedBalances();
        IERC20(token).safeTransfer(to, amount);
        _checkReserves(protectedTokens, before);
        emit Recovered(token, to, amount);
    }

    /// @notice What the vault owes in `token`: locked PULP principal, plus every notified reward not yet
    ///         paid (scheduled, claimable or unclaimed, including rounding dust) and not released after
    ///         emergency exit. Never sweepable. The balance is always at least this; it is higher only by
    ///         tokens sent in by mistake and released budgets not yet swept by `recoverExcess`.
    function reserved(address token) public view returns (uint256 amount) {
        if (token == address(pulp)) amount = totalLocked;
        if (_hasBooks(token)) amount += totalNotified[token] - totalPaid[token] - totalReleased[token];
    }

    /// @notice Send the balance above `reserved(token)` to the treasury: PULP or reward tokens sent straight
    ///         to the vault, released budgets, expired unclaimed rewards, or (token = address(0)) native ETH
    ///         forced into the vault. Owner or treasury: while a new treasury is pending, the current one can
    ///         sweep what was already released even if the owner holds it back for the new one.
    function recoverExcess(address token) external onlyOwnerOrTreasury nonReentrant returns (uint256 amount) {
        address to = treasury;
        if (token == address(0)) {
            amount = address(this).balance;
            if (amount == 0) revert NothingToRecover();
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            uint256 balance = IERC20(token).balanceOf(address(this));
            uint256 owed = reserved(token);
            if (balance <= owed) revert NothingToRecover();
            amount = balance - owed;
            (address[] memory protectedTokens, uint256[] memory before) = _protectedBalances();
            IERC20(token).safeTransfer(to, amount);
            _checkReserves(protectedTokens, before);
        }
        emit Recovered(token, to, amount);
    }

    // --- Internal accounting ---

    function _schedulePower(address user, uint256 boosted, uint256 end, bool add) private {
        uint256 from = block.timestamp;
        uint256[] storage epochs = _userEpochs[user];
        _indexEnd(boosted, end, add);
        while (from < end) {
            uint256 epoch = from / DAY;
            uint256 to = Math.min((epoch + 1) * DAY, end);
            // Exactly twice the trapezoid area. Remaining time is <= 30 days.
            uint256 area = boosted * (to - from) * ((end - from) + (end - to));
            if (add) {
                totalEpochArea[epoch] += area;
                userEpochArea[user][epoch] += area;
                // Position schedules are contiguous; only later epochs are appended.
                // Existing epochs survive withdrawal, restart, and remove/re-add on extension.
                if (epochs.length == 0 || epoch > epochs[epochs.length - 1]) epochs.push(epoch);
            } else {
                totalEpochArea[epoch] -= area;
                userEpochArea[user][epoch] -= area;
            }
            from = to;
        }
    }

    /// @dev Every trajectory scheduled from now to `end` (added, or removed by `extend`) is also indexed by
    ///      its end second, so the switch can find, in bounded time, how much scheduled area lies after it.
    ///      A trajectory that reaches its end is never removed: from then on its end is in the past, and
    ///      the switch only reads ends after itself.
    function _indexEnd(uint256 boosted, uint256 end, bool add) private {
        uint256 r = end % END_BUCKET;
        uint256 rd = end % DAY;
        BucketEnds storage b = _endsInBucket[end / END_BUCKET];
        DayEnds storage d = _endsOnDay[end / DAY];
        if (add) {
            _endsAt[end] += boosted;
            b.boosted += boosted;
            b.boostedR += boosted * r;
            b.boostedR2 += boosted * r * r;
            d.boosted += boosted;
            d.boostedR += boosted * rd;
        } else {
            _endsAt[end] -= boosted;
            b.boosted -= boosted;
            b.boostedR -= boosted * r;
            b.boostedR2 -= boosted * r * r;
            d.boosted -= boosted;
            d.boostedR -= boosted * rd;
        }
    }

    /// @dev Area one trajectory has scheduled on the day of `x` after `x` (`dayEnd` ends that day).
    function _areaAfter(uint256 boosted, uint256 end, uint256 x, uint256 dayEnd) private pure returns (uint256) {
        if (end <= x) return 0;
        uint256 to = end < dayEnd ? end : dayEnd;
        return boosted * ((end - x) * (end - x) - (end - to) * (end - to));
    }

    /// @dev Sum of `_areaAfter` over every live trajectory, at the switch (`x` = now): exactly the part of
    ///      `totalEpochArea[today]` scheduled after now. Every live trajectory started at or before now and
    ///      ends within 30 days. Ends on later days: (dayEnd - x)(2 end - x - dayEnd) per unit of boost,
    ///      from per-day sums (30 days). Ends later today: (end - x)^2, from 10-minute bucket sums and, for
    ///      the bucket holding `x`, per-second sums. At most ~1,100 storage reads.
    function _scheduledAfter(uint256 x) private view returns (uint256 r) {
        uint256 day = x / DAY;
        uint256 dayEnd = (day + 1) * DAY;
        uint256 span = dayEnd - x;
        for (uint256 d = day + 1; d <= day + 30; ++d) {
            DayEnds storage s = _endsOnDay[d];
            uint256 b = s.boosted;
            if (b != 0) r += span * (b * (2 * d * DAY - x - dayEnd) + 2 * s.boostedR);
        }
        uint256 bucket = x / END_BUCKET;
        if (_endsInBucket[bucket].boosted != 0) {
            uint256 bucketEnd = (bucket + 1) * END_BUCKET;
            for (uint256 t = x + 1; t < bucketEnd; ++t) {
                uint256 b = _endsAt[t];
                if (b != 0) r += b * (t - x) * (t - x);
            }
        }
        uint256 lastBucket = dayEnd / END_BUCKET;
        for (uint256 k = bucket + 1; k < lastBucket; ++k) {
            BucketEnds storage s = _endsInBucket[k];
            uint256 b = s.boosted;
            if (b != 0) {
                uint256 delta = k * END_BUCKET - x;
                r += s.boostedR2 + 2 * delta * s.boostedR + delta * delta * b;
            }
        }
    }

    /// @dev At the switch: keep floor(budget * elapsed / DAY) of the exit day payable (nothing if nobody
    ///      accrued area before the switch) and release the rest.
    function _scaleExitDay(address[] storage tokens, uint256 day, uint256 elapsed, uint256 total) private {
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            uint256 budget = epochRewards[token][day];
            if (budget == 0) continue;
            uint256 earned = total == 0 ? 0 : Math.mulDiv(budget, elapsed, DAY);
            epochRewards[token][day] = earned;
            uint256 unearned = budget - earned;
            if (unearned != 0) {
                totalReleased[token] += unearned;
                emit EmptyRewardsReleased(token, day, unearned);
            }
        }
    }

    function _scheduleRewards(address token, uint256 amount) private {
        uint256 first = Math.max(block.timestamp / DAY + 1, Math.ceilDiv(launchStart, DAY));
        uint256 daily = amount / REWARD_DAYS;
        for (uint256 i; i < REWARD_DAYS; ++i) {
            epochRewards[token][first + i] += daily + (i == REWARD_DAYS - 1 ? amount % REWARD_DAYS : 0);
        }
        emit RewardsScheduled(token, amount, first, first + REWARD_DAYS - 1);
    }

    function _fundNative() private {
        if (weth == address(0)) revert NativeDisabled();
        if (!isRewardToken[weth]) revert NotRewardToken();
        if (msg.value == 0) revert NothingToFund();
        uint256 beforeBalance = IERC20(weth).balanceOf(address(this));
        IWrappedNative(weth).deposit{value: msg.value}();
        if (IERC20(weth).balanceOf(address(this)) - beforeBalance != msg.value) revert UnsupportedTransfer();
        totalNotified[weth] += msg.value;
        emit RewardNotified(weth, msg.sender, msg.value);
        _scheduleRewards(weth, msg.value);
    }

    /// @dev Takes one day's budget off the books; returns 0 if there is none. Callers check eligibility.
    function _release(address token, uint256 epoch) private returns (uint256 amount) {
        amount = epochRewards[token][epoch];
        if (amount == 0) return 0;
        epochRewards[token][epoch] = 0;
        totalReleased[token] += amount;
        lastReleasedAt = block.timestamp;
        emit EmptyRewardsReleased(token, epoch, amount);
    }

    function _claim(address user, address token, uint256 maxEpochs, address to) private returns (uint256 amount) {
        (amount,) = _settle(user, token, maxEpochs);
        if (amount != 0) IERC20(token).safeTransfer(to, amount);
    }

    /// @dev Books one claim page as paid and moves the cursor. The caller delivers the tokens:
    ///      `_claim` transfers them, `compound` turns them into principal.
    function _settle(address user, address token, uint256 maxEpochs)
        private returns (uint256 amount, uint256 nextCursor)
    {
        (amount, nextCursor,) = claimable(user, token, maxEpochs);
        claimCursor[user][token] = nextCursor;
        if (amount != 0) totalPaid[token] += amount;
        emit RewardPaid(user, token, amount, nextCursor);
    }

    /// @dev Shared by `lock` and `lockFor`. PULP always comes from msg.sender, never `user`.
    function _lock(address user, uint256 amount, uint256 daysLocked) private {
        if (block.timestamp < launchStart) revert NotLaunched();
        if (locks[user].amount != 0) revert LockExists();
        _checkDuration(daysLocked);
        if (amount < minLockAmount) revert AmountTooSmall();
        _checkCapacity(amount);
        _pullExact(pulp, amount);

        uint256 end = block.timestamp + daysLocked * DAY;
        uint256 boosted = amount * entryMultiplier(block.timestamp);
        locks[user] = Lock(amount, boosted, end);
        totalLocked += amount;
        _schedulePower(user, boosted, end, true);
        emit Locked(user, amount, daysLocked, end, powerOf(user));
    }

    /// @dev Shared by `increaseAmount` and `increaseAmountFor`. PULP always comes from msg.sender.
    function _increase(address user, uint256 amount) private {
        Lock storage l = locks[user];
        _checkTopUpWindow(l);
        if (amount == 0) revert AmountTooSmall();
        _checkCapacity(amount);
        _pullExact(pulp, amount);
        _addPrincipal(user, l, amount);
    }

    /// @dev The one place principal is added to an existing lock (top-ups and compounding).
    ///      Callers check the window and capacity and account for where `amount` came from.
    function _addPrincipal(address user, Lock storage l, uint256 amount) private {
        uint256 multiplier = entryMultiplier(block.timestamp);
        uint256 addedBoost = amount * multiplier;
        l.amount += amount;
        l.boosted += addedBoost;
        totalLocked += amount;
        _schedulePower(user, addedBoost, l.end, true);
        emit Increased(user, amount, multiplier, powerOf(user));
    }

    /// @dev Never the vault itself (its balances are the books), the treasury or a pending treasury, or an
    ///      expired token (its old budgets must never be read again). Reactivating a retired token keeps its
    ///      books and clears its retirement time.
    function _addRewardToken(address token) private {
        if (token == address(this)) revert InvalidRewardToken();
        if (token.code.length == 0) revert NotAContract();
        if (isRewardToken[token]) revert RewardTokenExists();
        if (isExpiredRewardToken[token]) revert ExpiredRewardToken();
        if (token == treasury || token == pendingTreasury) revert InvalidTreasury();
        if (rewardTokens.length >= MAX_REWARD_TOKENS) revert TooManyRewardTokens();
        if (isRetiredRewardToken[token]) {
            isRetiredRewardToken[token] = false;
            delete retiredAt[token];
            _removeFrom(_retiredRewardTokens, token);
        }
        isRewardToken[token] = true;
        rewardTokens.push(token);
        emit RewardTokenAdded(token);
    }

    /// @dev Order-preserving removal from a list of at most MAX_RETIRED_REWARD_TOKENS (10).
    function _removeFrom(address[] storage list, address token) private {
        uint256 n = list.length;
        uint256 i;
        while (list[i] != token) ++i;
        for (; i + 1 < n; ++i) list[i] = list[i + 1];
        list.pop();
    }

    function _hasBooks(address token) private view returns (bool) {
        return isRewardToken[token] || isRetiredRewardToken[token];
    }

    /// @dev First day that may still hold a budget nobody has fully earned: before the exit today (still open)
    ///      or, before launch, the launch day; after the exit the day after the exit day (or the launch day).
    ///      Every budget was scheduled by `_scheduleRewards` over the seven days from `max(t + 1, launch day)`
    ///      for some funding/recycling day `t` (before the switch, if exited), so every budget on a day >= this
    ///      one lies in the REWARD_DAYS + 1 days from it.
    function _firstUnsettledDay() private view returns (uint256) {
        return Math.max(
            emergencyExit ? uint256(exitEpoch()) + 1 : block.timestamp / DAY, Math.ceilDiv(launchStart, DAY)
        );
    }

    /// @dev The first day in the REWARD_DAYS + 1 days from `first` with a budget of `token`, if any.
    function _scheduledDay(address token, uint256 first) private view returns (bool found, uint256 epoch) {
        for (uint256 i; i <= REWARD_DAYS; ++i) {
            if (epochRewards[token][first + i] != 0) return (true, first + i);
        }
    }

    /// @dev At most 15 tokens x 8 days of reads (`acceptTreasury`).
    function _checkNothingScheduled(address[] storage tokens, uint256 first) private view {
        for (uint256 i; i < tokens.length; ++i) {
            (bool found, uint256 epoch) = _scheduledDay(tokens[i], first);
            if (found) revert UnearnedRewardsScheduled(tokens[i], epoch);
        }
    }

    /// @dev PULP and every token with reward books, with their balances now. A failed read is recorded as
    ///      type(uint256).max, so `_checkReserves` holds that token to all of `reserved` (see there).
    function _protectedBalances() private view returns (address[] memory list, uint256[] memory balances) {
        uint256 a = rewardTokens.length;
        uint256 r = _retiredRewardTokens.length;
        list = new address[](1 + a + r);
        balances = new uint256[](list.length);
        list[0] = address(pulp);
        for (uint256 i; i < a; ++i) list[1 + i] = rewardTokens[i];
        for (uint256 i; i < r; ++i) list[1 + a + i] = _retiredRewardTokens[i];
        for (uint256 i; i < list.length; ++i) {
            (bool ok, uint256 balance) = _tryBalance(list[i]);
            balances[i] = ok ? balance : type(uint256).max;
        }
    }

    /// @dev After a recovery transfer, no protected balance may be below what is owed (or, if it already
    ///      was, below what it was). Catches a token reachable at two addresses.
    ///      Reads that fail are treated conservatively: unreadable before (an unknown balance) means the
    ///      floor is all of `reserved`, not zero; readable before but not after (the transfer broke it) is a
    ///      breach. Only a token unreadable both times, i.e. broken for this whole call, is skipped, so a
    ///      broken token can't block recovering the others, and a token can't dodge the check by failing
    ///      one of the two reads.
    function _checkReserves(address[] memory list, uint256[] memory before) private view {
        for (uint256 i; i < list.length; ++i) {
            uint256 floor = Math.min(before[i], reserved(list[i]));
            (bool ok, uint256 balance) = _tryBalance(list[i]);
            if (ok ? balance < floor : before[i] != type(uint256).max) revert ReserveBreached(list[i]);
        }
    }

    /// @dev At most BALANCE_READ_GAS for the call, so a token can't consume the caller's whole gas.
    function _tryBalance(address token) private view returns (bool ok, uint256 balance) {
        (bool success, bytes memory data) =
            token.staticcall{gas: BALANCE_READ_GAS}(abi.encodeCall(IERC20.balanceOf, (address(this))));
        if (success && data.length >= 32) return (true, abi.decode(data, (uint256)));
    }

    function _zeroFloorSub(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    function _pullExact(IERC20 token, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedTransfer();
    }

    function _checkTopUpWindow(Lock storage l) private view {
        if (l.amount == 0) revert NoLock();
        if (block.timestamp >= l.end) revert LockExpired();
        if (l.end - block.timestamp < MIN_LOCK_TIME) revert ExtendFirst();
    }

    /// @dev The vault can never call withdraw, so a lock it owned would strand principal forever; tokens
    ///      claimed to it would leave the books and become sweepable. PULP, WETH and reward tokens (active,
    ///      retired or expired) are token contracts that can't withdraw or move what they receive either: a
    ///      pasted token address instead of a wallet (typo protection).
    function _checkBeneficiary(address beneficiary) private view {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (
            beneficiary == address(this) || beneficiary == address(pulp) || beneficiary == weth ||
            _hasBooks(beneficiary) || isExpiredRewardToken[beneficiary]
        ) revert InvalidBeneficiary();
    }

    /// @dev Never the vault (fees would stay in the balance but leave `reserved`), PULP or a reward token.
    function _checkTreasury(address t) private view {
        if (t == address(0)) revert ZeroAddress();
        if (t == address(this) || t == address(pulp) || _hasBooks(t)) revert InvalidTreasury();
    }

    function _checkCapacity(uint256 amount) private view {
        if (amount > MAX_TOTAL_LOCKED - totalLocked) revert LockCapExceeded();
    }

    function _checkDuration(uint256 daysLocked) private pure {
        if (daysLocked != 10 && daysLocked != 20 && daysLocked != 30) revert BadDuration();
    }

    function _checkClaimLimit(uint256 maxEpochs) private pure {
        if (maxEpochs == 0 || maxEpochs > MAX_CLAIM_EPOCHS) revert BadClaimLimit();
    }
}
