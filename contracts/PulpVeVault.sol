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
 * @notice Lock PULP for exactly 10, 20 or 30 days and earn a share of the reward tokens (the trading tax).
 *         Reward power = amount * entry multiplier * remaining time / 30 days, decaying linearly.
 * @dev Not a voting token, not upgradeable. Rewards are funded over the next seven full UTC days and each
 *      day's budget is split by the exact integral of power over that day. Closed days never change.
 *
 *      Roles: owner (Ownable2Step, cannot renounce): reward tokens, distributors, pause of new principal,
 *      compound fee (<= 2%), treasury proposals, one-way emergency exit, recoveries. Distributors: fund
 *      rewards. Treasury: receives compound fees and everything recovered; may trigger recoveries itself.
 *
 *      Guarantees:
 *      - principal is always withdrawable at lock end (after an emergency exit: at any time);
 *      - earned rewards stay claimable forever, also for removed ("retired") reward tokens;
 *      - recoveries never touch principal or owed rewards (`reserved`);
 *      - the treasury changes only by a two-step handover, accepted at least TREASURY_DELAY (8 days) after
 *        the public proposal.
 *
 *      Design and proofs: docs/TECHNICAL.md.
 */
contract PulpVeVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DAY = 1 days;
    uint256 public constant MIN_LOCK_TIME = 10 days;
    uint256 public constant MAX_LOCK_TIME = 30 days;
    uint256 public constant WAD = 1e18;
    // Days a funding is spread over, starting tomorrow (or the launch day).
    uint256 public constant REWARD_DAYS = 7;
    // Active reward tokens (paid by claimAll, fundable).
    uint256 public constant MAX_REWARD_TOKENS = 5;
    // Removed but still owed tokens (claimable with claim/claimTo).
    uint256 public constant MAX_RETIRED_REWARD_TOKENS = 10;
    // Max recorded days settled per claim page.
    uint256 public constant MAX_CLAIM_EPOCHS = 64;
    // Keeps boosted principal and all area arithmetic far below uint256.
    uint256 public constant MAX_TOTAL_LOCKED = type(uint128).max;
    // Hard cap on the compound fee, in bps (2%).
    uint16 public constant MAX_COMPOUND_FEE_BPS = 200;
    // Minimum time between proposeTreasury and acceptTreasury.
    uint256 public constant TREASURY_DELAY = 8 days;
    uint256 private constant BPS = 10_000;
    // Seconds per bucket of the lock-end index read by enableEmergencyExit. Divides DAY.
    uint256 private constant END_BUCKET = 600;
    // Gas cap for each balanceOf read in the recovery reserve check.
    uint256 private constant BALANCE_READ_GAS = 100_000;

    struct Config {
        address pulp;
        address weth; // zero disables native funding
        address owner;
        address distributor;
        uint256 launchStart; // 00:00 UTC of some day
        uint256 earlyWindow; // seconds over which the entry multiplier falls from 2x to 1x
        uint256 minLockAmount;
        uint16 compoundFeeBps; // <= MAX_COMPOUND_FEE_BPS
        address treasury; // required
    }

    struct Lock {
        uint256 amount; // PULP principal
        // Sum of amount_i * entryMultiplier_i (WAD-scaled), unrounded.
        uint256 boosted;
        uint256 end; // unlock timestamp
    }

    // A lock's trajectory at the emergency exit, kept if it is withdrawn while it would still have run.
    struct ExitLock {
        uint192 boosted;
        uint64 end;
    }

    // Sums over live trajectories ending in one END_BUCKET (r = end % END_BUCKET) or one day (r = end % DAY).
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
    // Receives compound fees and all recoveries. Changes only via proposeTreasury + acceptTreasury.
    address public treasury;
    // Fee on compound only, in bps.
    uint16 public compoundFeeBps;
    // One-way switch, see enableEmergencyExit.
    bool public emergencyExit;
    // Second the emergency exit was enabled; 0 while off.
    uint64 public exitTimestamp;
    address public pendingTreasury;
    // When pendingTreasury was proposed (0 if none). Cleared on acceptance, cancellation and ownership change.
    uint64 public treasuryProposedAt;
    // Total area accrued on the exit day before exitTimestamp (denominator for that day's payouts).
    uint256 public exitDayTotalArea;
    mapping(address => bool) public isDistributor;

    // Areas, in units of 2 * integral(boosted * remainingSeconds dt), keyed by epoch = timestamp / DAY.
    // Frozen once the emergency exit is on.
    mapping(uint256 => uint256) public totalEpochArea;
    mapping(address => mapping(uint256 => uint256)) public userEpochArea;
    mapping(address => uint256[]) private _userEpochs;

    address[] public rewardTokens;
    mapping(address => bool) public isRewardToken;
    // Removed while still owed: claimable, reserved and protected, not fundable.
    address[] private _retiredRewardTokens;
    mapping(address => bool) public isRetiredRewardToken;
    mapping(address => mapping(uint256 => uint256)) public epochRewards;
    mapping(address => mapping(address => uint256)) public claimCursor;
    mapping(address => uint256) public totalNotified;
    mapping(address => uint256) public totalPaid;
    // Budgets taken off the books after the emergency exit (unearned or empty days).
    mapping(address => uint256) public totalReleased;

    mapping(address => ExitLock) private _exitLocks;
    // Index of live lock trajectories by end second, read only by enableEmergencyExit.
    mapping(uint256 => uint256) private _endsAt;
    mapping(uint256 => BucketEnds) private _endsInBucket;
    mapping(uint256 => DayEnds) private _endsOnDay;

    event Locked(address indexed user, uint256 amount, uint256 daysLocked, uint256 end, uint256 power);
    event Increased(address indexed user, uint256 amount, uint256 entryMultiplier, uint256 power);
    event Extended(address indexed user, uint256 oldEnd, uint256 newEnd, uint256 power, bool restarted);
    event Withdrawn(address indexed user, uint256 amount);
    // After the emergency exit, a lock withdrawn before its end (also logs Withdrawn).
    event EarlyWithdrawn(address indexed user, uint256 amount, uint256 oldEnd);
    // From lockFor/increaseAmountFor, after Locked/Increased.
    event DepositedFor(address indexed payer, address indexed beneficiary, uint256 amount);
    // `amount` was re-locked, `fee` sent to the treasury; the preceding RewardPaid logs amount + fee.
    event Compounded(address indexed user, uint256 amount, uint256 fee, uint256 nextCursor);
    event RewardNotified(address indexed token, address indexed funder, uint256 amount);
    event RewardsScheduled(address indexed token, uint256 amount, uint256 firstEpoch, uint256 lastEpoch);
    event EmptyRewardsRecycled(address indexed token, uint256 indexed emptyEpoch, uint256 amount);
    event RewardPaid(address indexed user, address indexed token, uint256 amount, uint256 nextCursor);
    // claimTo/claimAllTo: the page logged by RewardPaid for `user` was sent to `to`.
    event RewardSentTo(address indexed user, address indexed token, address indexed to, uint256 amount);
    event RewardTokenAdded(address indexed token);
    event RewardTokenRemoved(address indexed token, bool retired);
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

    /// @dev Calls that would add principal, area or reward budget.
    modifier whenNotExited() {
        if (emergencyExit) revert EmergencyExitActive();
        _;
    }

    /// @dev Recoveries: the owner, or the treasury (their only destination).
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

    /// @notice Entry multiplier (WAD) at `timestamp`: 2e18 at launch, falling linearly to 1e18 over earlyWindow.
    function entryMultiplier(uint256 timestamp) public view returns (uint256) {
        if (timestamp <= launchStart) return 2 * WAD;
        uint256 elapsed = timestamp - launchStart;
        if (elapsed >= earlyWindow) return WAD;
        return WAD + Math.mulDiv(WAD, earlyWindow - elapsed, earlyWindow);
    }

    /// @notice Current reward power of `user`'s lock (0 once it has ended).
    function powerOf(address user) public view returns (uint256) {
        Lock memory l = locks[user];
        if (block.timestamp >= l.end) return 0;
        return Math.mulDiv(l.boosted, l.end - block.timestamp, MAX_LOCK_TIME * WAD);
    }

    /// @notice Power a new lock of `amount` for `daysLocked` days would start with now.
    function previewPower(uint256 amount, uint256 daysLocked) external view returns (uint256) {
        _checkDuration(daysLocked);
        if (amount > MAX_TOTAL_LOCKED) revert LockCapExceeded();
        return Math.mulDiv(amount * entryMultiplier(block.timestamp), daysLocked * DAY, MAX_LOCK_TIME * WAD);
    }

    /// @notice Lock `amount` PULP for exactly 10, 20 or 30 days at today's entry multiplier. One lock per address.
    function lock(uint256 amount, uint256 daysLocked) external nonReentrant whenLocksOpen {
        _lock(msg.sender, amount, daysLocked);
    }

    /// @notice Open a lock for `beneficiary`, paid with the caller's PULP. Same rules as `lock`; the lock
    ///         belongs wholly to `beneficiary`.
    function lockFor(address beneficiary, uint256 amount, uint256 daysLocked)
        external nonReentrant whenLocksOpen
    {
        _checkBeneficiary(beneficiary);
        _lock(beneficiary, amount, daysLocked);
        emit DepositedFor(msg.sender, beneficiary, amount);
    }

    /// @notice Add PULP to the caller's lock at today's entry multiplier. The lock must have 10+ days left
    ///         (extend first otherwise); the unlock time does not change.
    function increaseAmount(uint256 amount) external nonReentrant whenLocksOpen {
        _increase(msg.sender, amount);
    }

    /// @notice Add the caller's PULP to `beneficiary`'s lock. Same rules as `increaseAmount`.
    function increaseAmountFor(address beneficiary, uint256 amount) external nonReentrant whenLocksOpen {
        _checkBeneficiary(beneficiary);
        _increase(beneficiary, amount);
        emit DepositedFor(msg.sender, beneficiary, amount);
    }

    /// @notice Re-lock one claim page of the caller's PULP rewards into their lock (rules of `increaseAmount`),
    ///         minus `compoundFeeBps` sent to the treasury. Reverts FeeAboveMax if that fee exceeds `maxFeeBps`.
    ///         `claim(pulp, n)` + `increaseAmount` does the same with no fee.
    /// @dev The page leaves the reward books (totalPaid) and `amount` joins principal; only `fee` is
    ///      transferred, so `reserved(pulp)` and the PULP balance both drop by exactly `fee`.
    /// @return amount PULP added to the caller's principal (page minus fee).
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
        if (amount == 0) revert NothingToCompound();
        _checkCapacity(amount);
        _addPrincipal(msg.sender, l, amount);
        emit Compounded(msg.sender, amount, fee, nextCursor);
        if (fee != 0) pulp.safeTransfer(treasury, fee);
    }

    /// @notice Set the caller's remaining lock time to 10/20/30 days from now (must be later than the current
    ///         end). An active lock keeps its multiplier; an expired one restarts at today's.
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

    /// @notice Withdraw the caller's whole principal once the lock has ended (any time after an emergency
    ///         exit). Independent of reward claims.
    /// @dev After the exit, a lock that ran past the switch leaves its trajectory in `_exitLocks` so its
    ///      exit-day share stays computable.
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

    /// @notice Distributor: fund `amount` of `token`, spread over the next seven full UTC days.
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

    /// @notice Distributor: fund with native ETH, wrapped and paid out as WETH.
    function notifyRewardETH() external payable nonReentrant onlyDistributor whenNotExited {
        _fundNative();
    }

    /// @notice A plain ETH transfer from a distributor funds rewards like `notifyRewardETH`.
    receive() external payable nonReentrant onlyDistributor whenNotExited {
        _fundNative();
    }

    /// @notice Reschedule a closed day's budget over the next seven days if nobody had any power that day.
    ///         Permissionless; not after the emergency exit.
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

    /// @notice After the emergency exit, take a day's budget nobody can earn off the books (a day after the
    ///         exit day, or a day with zero area). Permissionless. Released budgets become recoverable.
    function releaseEmptyRewards(address token, uint256 epoch) external nonReentrant {
        if (!emergencyExit) revert EmergencyExitOff();
        if (!_hasBooks(token)) revert NotRewardToken();
        uint256 exitDay = exitEpoch();
        if (epoch < exitDay ? totalEpochArea[epoch] != 0 : (epoch == exitDay && exitDayTotalArea != 0)) {
            revert EpochHasPower();
        }
        if (_release(token, epoch) == 0) revert NothingToFund();
    }

    /// @notice After the emergency exit, release every budget of `token` after the exit day in one call.
    /// @dev All budgets were scheduled on or before the exit day, so any after it lie in the seven days from
    ///      max(exitEpoch + 1, launch day).
    /// @return amount Total released.
    function releasePostExitRewards(address token) external nonReentrant returns (uint256 amount) {
        if (!emergencyExit) revert EmergencyExitOff();
        if (!_hasBooks(token)) revert NotRewardToken();
        uint256 first = Math.max(uint256(exitEpoch()) + 1, Math.ceilDiv(launchStart, DAY));
        for (uint256 i; i < REWARD_DAYS; ++i) amount += _release(token, first + i);
        if (amount == 0) revert NothingToFund();
    }

    /// @notice Claim the caller's `token` rewards for up to `maxEpochs` (<= 64) recorded days; repeat for more.
    ///         Works for retired tokens too.
    function claim(address token, uint256 maxEpochs) external nonReentrant returns (uint256 amount) {
        if (!_hasBooks(token)) revert NotRewardToken();
        _checkClaimLimit(maxEpochs);
        return _claim(msg.sender, token, maxEpochs, msg.sender);
    }

    /// @notice Like `claim`, but sends the caller's page to `to`.
    function claimTo(address token, uint256 maxEpochs, address to) external nonReentrant returns (uint256 amount) {
        if (!_hasBooks(token)) revert NotRewardToken();
        _checkClaimLimit(maxEpochs);
        _checkBeneficiary(to);
        amount = _claim(msg.sender, token, maxEpochs, to);
        emit RewardSentTo(msg.sender, token, to, amount);
    }

    /// @notice Claim one page of every active reward token. Retired tokens: use `claim`.
    function claimAll(uint256 maxEpochs) external nonReentrant {
        _checkClaimLimit(maxEpochs);
        for (uint256 i; i < rewardTokens.length; ++i) _claim(msg.sender, rewardTokens[i], maxEpochs, msg.sender);
    }

    /// @notice Like `claimAll`, but sends everything to `to`.
    function claimAllTo(uint256 maxEpochs, address to) external nonReentrant {
        _checkClaimLimit(maxEpochs);
        _checkBeneficiary(to);
        for (uint256 i; i < rewardTokens.length; ++i) {
            address token = rewardTokens[i];
            emit RewardSentTo(msg.sender, token, to, _claim(msg.sender, token, maxEpochs, to));
        }
    }

    /// @notice Final amount the next claim page would pay (closed days only; after the emergency exit, up to
    ///         and including the exit day).
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
        // First unpayable day: today, or after the exit the day after the exit day.
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

    /// @notice UTC day of the emergency exit; 0 while it is off.
    function exitEpoch() public view returns (uint64) {
        return exitTimestamp / uint64(DAY);
    }

    /// @notice Area `user` accrued on the exit day before the switch (0 while the exit is off).
    /// @dev The day's scheduled area minus the part after the switch, from the live lock or, if withdrawn,
    ///      the trajectory it left in `_exitLocks`.
    function exitDayArea(address user) public view returns (uint256) {
        if (!emergencyExit) return 0;
        uint256 x = exitTimestamp;
        uint256 day = x / DAY;
        uint256 area = userEpochArea[user][day];
        if (area == 0) return 0;
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

    /// @notice Number of days with recorded area for `user`.
    function userEpochCount(address user) external view returns (uint256) {
        return _userEpochs[user].length;
    }

    /// @notice The `index`-th recorded day of `user`.
    function userEpochAt(address user, uint256 index) external view returns (uint256) {
        return _userEpochs[user][index];
    }

    /// @notice Active reward tokens.
    function getRewardTokens() external view returns (address[] memory) {
        return rewardTokens;
    }

    /// @notice Retired reward tokens (removed but still owed).
    function getRetiredRewardTokens() external view returns (address[] memory) {
        return _retiredRewardTokens;
    }

    /// @notice Owner: register a reward token, or reactivate a retired one.
    function addRewardToken(address token) external onlyOwner nonReentrant {
        _addRewardToken(token);
    }

    /// @notice Owner: stop paying and funding `token`. Only once no open or future day holds a budget. If
    ///         anything is still owed the token is retired (still claimable with `claim`/`claimTo` and
    ///         reserved, forever), otherwise dropped.
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
            _retiredRewardTokens.push(token);
        }
        emit RewardTokenRemoved(token, retired);
    }

    /// @notice Owner: allow or revoke a reward distributor.
    function setDistributor(address distributor, bool allowed) external onlyOwner {
        if (distributor == address(0)) revert ZeroAddress();
        isDistributor[distributor] = allowed;
        emit DistributorSet(distributor, allowed);
    }

    /// @notice Owner: pause new principal (lock, increase, compound). Extend, withdraw and claims stay open.
    function setLocksPaused(bool paused) external onlyOwner {
        locksPaused = paused;
        emit LocksPausedSet(paused);
    }

    /// @notice Owner: set the compound fee in bps, at most MAX_COMPOUND_FEE_BPS.
    function setCompoundFee(uint16 feeBps) external onlyOwner {
        if (feeBps > MAX_COMPOUND_FEE_BPS) revert FeeTooHigh();
        compoundFeeBps = feeBps;
        emit CompoundFeeSet(feeBps);
    }

    /// @notice Owner: propose a new treasury, acceptable by it after TREASURY_DELAY (8 days). Each proposal
    ///         restarts the clock; zero cancels.
    function proposeTreasury(address newTreasury) external onlyOwner {
        if (newTreasury != address(0)) _checkTreasury(newTreasury);
        pendingTreasury = newTreasury;
        treasuryProposedAt = newTreasury == address(0) ? 0 : SafeCast.toUint64(block.timestamp);
        emit TreasuryProposed(newTreasury);
    }

    /// @notice The proposed treasury takes over, once TREASURY_DELAY has passed since the proposal.
    function acceptTreasury() external {
        address next = pendingTreasury;
        if (msg.sender != next) revert NotPendingTreasury();
        uint256 acceptableAt = uint256(treasuryProposedAt) + TREASURY_DELAY;
        if (block.timestamp < acceptableAt) revert TreasuryDelayNotOver(acceptableAt);
        _checkTreasury(next); // a reward token may have been registered since the proposal
        emit TreasuryChanged(treasury, next);
        treasury = next;
        pendingTreasury = address(0);
        treasuryProposedAt = 0;
    }

    /// @notice Owner, one-way: every lock may withdraw now and no new principal, extensions or funding are
    ///         accepted. Rewards stop at this second; moves no tokens.
    /// @dev Earlier days pay as usual. Today pays budget * elapsed / DAY, split by area accrued before now;
    ///      the unearned rest is released here and later days can be released. See docs/TECHNICAL.md.
    function enableEmergencyExit() external onlyOwner {
        if (emergencyExit) revert EmergencyExitActive();
        uint256 x = block.timestamp;
        uint256 day = x / DAY;
        // Area accrued before now. Saturating only so the switch can never revert.
        uint256 total = _zeroFloorSub(totalEpochArea[day], _scheduledAfter(x));
        emergencyExit = true;
        exitTimestamp = SafeCast.toUint64(x);
        exitDayTotalArea = total;
        uint256 elapsed = x - day * DAY;
        _scaleExitDay(rewardTokens, day, elapsed, total);
        _scaleExitDay(_retiredRewardTokens, day, elapsed, total);
        emit EmergencyExitEnabled(day, x, total);
    }

    /// @notice Disabled: ownership can be transferred but not renounced.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @dev Every ownership change cancels a pending treasury proposal.
    function _transferOwnership(address newOwner) internal override {
        if (pendingTreasury != address(0)) {
            pendingTreasury = address(0);
            treasuryProposedAt = 0;
            emit TreasuryProposed(address(0));
        }
        super._transferOwnership(newOwner);
    }

    /// @notice Owner or treasury: send an unrelated token sent here by mistake to the treasury. PULP and
    ///         reward tokens are refused.
    function recoverERC20(address token, uint256 amount) external onlyOwnerOrTreasury nonReentrant {
        if (token == address(pulp) || _hasBooks(token)) revert ProtectedToken();
        address to = treasury;
        (address[] memory protectedTokens, uint256[] memory before) = _protectedBalances();
        IERC20(token).safeTransfer(to, amount);
        _checkReserves(protectedTokens, before);
        emit Recovered(token, to, amount);
    }

    /// @notice What the vault owes in `token`: locked PULP principal plus notified rewards not yet paid or
    ///         released. Never recoverable.
    function reserved(address token) public view returns (uint256 amount) {
        if (token == address(pulp)) amount = totalLocked;
        if (_hasBooks(token)) amount += totalNotified[token] - totalPaid[token] - totalReleased[token];
    }

    /// @notice Owner or treasury: send the balance above `reserved(token)` to the treasury
    ///         (token = address(0): the native ETH balance).
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

    /// @dev Adds (or removes) the area of trajectory (boosted, end) from now on, per day. At most 31 days.
    function _schedulePower(address user, uint256 boosted, uint256 end, bool add) private {
        uint256 from = block.timestamp;
        uint256[] storage epochs = _userEpochs[user];
        _indexEnd(boosted, end, add);
        while (from < end) {
            uint256 epoch = from / DAY;
            uint256 to = Math.min((epoch + 1) * DAY, end);
            // Exactly twice the trapezoid area, so no rounding.
            uint256 area = boosted * (to - from) * ((end - from) + (end - to));
            if (add) {
                totalEpochArea[epoch] += area;
                userEpochArea[user][epoch] += area;
                // Schedules are contiguous; only later epochs are appended.
                if (epochs.length == 0 || epoch > epochs[epochs.length - 1]) epochs.push(epoch);
            } else {
                totalEpochArea[epoch] -= area;
                userEpochArea[user][epoch] -= area;
            }
            from = to;
        }
    }

    /// @dev Indexes each scheduled trajectory by its end second, so the switch can sum the area scheduled
    ///      after it in bounded time. Ended trajectories are never removed; the switch only reads future ends.
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

    /// @dev Sum of `_areaAfter` over every live trajectory at `x` = now: the part of totalEpochArea[today]
    ///      scheduled after now. Ends on later days: per-day sums (30 days). Ends later today: 10-minute
    ///      bucket sums, plus per-second sums for the bucket holding `x`. At most ~1,100 storage reads.
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
        emit EmptyRewardsReleased(token, epoch, amount);
    }

    function _claim(address user, address token, uint256 maxEpochs, address to) private returns (uint256 amount) {
        (amount,) = _settle(user, token, maxEpochs);
        if (amount != 0) IERC20(token).safeTransfer(to, amount);
    }

    /// @dev Books one claim page as paid and moves the cursor; the caller delivers the tokens.
    function _settle(address user, address token, uint256 maxEpochs)
        private returns (uint256 amount, uint256 nextCursor)
    {
        (amount, nextCursor,) = claimable(user, token, maxEpochs);
        claimCursor[user][token] = nextCursor;
        if (amount != 0) totalPaid[token] += amount;
        emit RewardPaid(user, token, amount, nextCursor);
    }

    /// @dev PULP always comes from msg.sender, never `user`.
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

    /// @dev PULP always comes from msg.sender, never `user`.
    function _increase(address user, uint256 amount) private {
        Lock storage l = locks[user];
        _checkTopUpWindow(l);
        if (amount == 0) revert AmountTooSmall();
        _checkCapacity(amount);
        _pullExact(pulp, amount);
        _addPrincipal(user, l, amount);
    }

    /// @dev Adds principal to an existing lock. Callers check the window and capacity.
    function _addPrincipal(address user, Lock storage l, uint256 amount) private {
        uint256 multiplier = entryMultiplier(block.timestamp);
        uint256 addedBoost = amount * multiplier;
        l.amount += amount;
        l.boosted += addedBoost;
        totalLocked += amount;
        _schedulePower(user, addedBoost, l.end, true);
        emit Increased(user, amount, multiplier, powerOf(user));
    }

    /// @dev Never the vault itself, the treasury or a pending treasury. Reactivation keeps the token's books.
    function _addRewardToken(address token) private {
        if (token == address(this)) revert InvalidRewardToken();
        if (token.code.length == 0) revert NotAContract();
        if (isRewardToken[token]) revert RewardTokenExists();
        if (token == treasury || token == pendingTreasury) revert InvalidTreasury();
        if (rewardTokens.length >= MAX_REWARD_TOKENS) revert TooManyRewardTokens();
        if (isRetiredRewardToken[token]) {
            isRetiredRewardToken[token] = false;
            _removeFrom(_retiredRewardTokens, token);
        }
        isRewardToken[token] = true;
        rewardTokens.push(token);
        emit RewardTokenAdded(token);
    }

    /// @dev Order-preserving removal from a short list.
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

    /// @dev First day that may still hold an unearned budget: today (after the exit: the day after the exit
    ///      day), or the launch day if later. Every budget on or after it lies in the REWARD_DAYS + 1 days
    ///      from it.
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

    /// @dev PULP and every token with reward books, with their balances now (type(uint256).max if unreadable).
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

    /// @dev After a recovery transfer, no protected balance may fall below min(before, reserved). Catches a
    ///      token reachable at two addresses. Unreadable before: floor is all of `reserved`; readable before
    ///      but not after: breach; unreadable both times: skipped.
    function _checkReserves(address[] memory list, uint256[] memory before) private view {
        for (uint256 i; i < list.length; ++i) {
            uint256 floor = Math.min(before[i], reserved(list[i]));
            (bool ok, uint256 balance) = _tryBalance(list[i]);
            if (ok ? balance < floor : before[i] != type(uint256).max) revert ReserveBreached(list[i]);
        }
    }

    /// @dev Return-bomb-safe balanceOf: gas capped at BALANCE_READ_GAS and only the first 32 bytes of the
    ///      answer are copied. Succeeds only if the call succeeded and returned at least 32 bytes.
    function _tryBalance(address token) private view returns (bool ok, uint256 value) {
        bytes4 selector = IERC20.balanceOf.selector;
        assembly ("memory-safe") {
            let ptr := mload(0x40) // calldata built past the free memory pointer, never allocated
            mstore(ptr, selector)
            mstore(add(ptr, 0x04), address())
            // Answer goes to scratch space at 0x00.
            let success := staticcall(BALANCE_READ_GAS, token, ptr, 0x24, 0x00, 0x20)
            ok := and(success, gt(returndatasize(), 0x1f))
            if ok { value := mload(0x00) }
        }
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

    /// @dev Not the vault (it can never withdraw, and tokens claimed to it would become recoverable), PULP,
    ///      WETH or a reward token (typo protection: token contracts can't move what they receive).
    function _checkBeneficiary(address beneficiary) private view {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (
            beneficiary == address(this) || beneficiary == address(pulp) || beneficiary == weth ||
            _hasBooks(beneficiary)
        ) revert InvalidBeneficiary();
    }

    /// @dev Not the vault, PULP, WETH (even after removal as a reward token) or a reward token.
    function _checkTreasury(address t) private view {
        if (t == address(0)) revert ZeroAddress();
        if (t == address(this) || t == address(pulp) || t == weth || _hasBooks(t)) revert InvalidTreasury();
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
