// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "./interfaces/IUniswapV4.sol";
import {IPulpVeVault, IWETH9} from "./interfaces/IPulpVeVault.sol";

/**
 * @title PulpZap
 * @notice One transaction: buy $pulp with ETH (or WETH) on the native-ETH/$pulp Uniswap v4 pool and lock it
 *         in PulpVeVault for `beneficiary`, or add it to the beneficiary's existing lock.
 * @dev Swaps directly against the v4 PoolManager (unlock -> swap -> sync + settle ETH -> take PULP). Exact input:
 *      the whole msg.value (or the whole pulled WETH), minus the zap fee, is sold, nothing else.
 *
 *      Zap fee: `zapFeeBps` of the input (floor), hard-capped at MAX_ZAP_FEE_BPS (2%), is sent to
 *      `feeRecipient` before the swap, in the input asset (ETH, or WETH if the recipient refuses ETH; WETH for
 *      zapWETH). The owner (Ownable2Step, renounce disabled) can only change the fee within the cap and the
 *      recipient, and sweep stray balances (see `sweep`); it cannot touch user funds, locks or the pool.
 *      When an *OrRefund call refunds, the fee is rolled back with everything else: no fee is charged when
 *      nothing gets locked.
 *
 *      Caller bounds, all checked before the swap where possible and the lock end again after the vault call:
 *      - minPulpOut: the PULP locked, after fee and hook tax.
 *      - minSqrtPriceX96: optional price limit for the swap (0 = none). The pool price may not be pushed
 *        below it; if it already is, or the swap would cross it, the zap reverts (or refunds) instead of
 *        filling at a worse price. Caps what a sandwich can take independently of minPulpOut.
 *      - maxUnlockTime: the latest acceptable unlock time of the beneficiary's lock (new or existing). A lock
 *        planted or extended by someone else cannot silently absorb the zap for longer than the caller agreed.
 *      - maxFeeBps: the highest zap fee the caller accepts, so a fee raised after the quote cannot be taken
 *        inside the caller's slippage margin.
 *      - deadline.
 *
 *      Funds never stay here between transactions: every path either locks all PULP bought (fee paid out)
 *      or reverts, or (the *OrRefund entry points) sends the full input back to the beneficiary. Vault
 *      allowance is set to the exact amount and reset to zero in the same call. Strays pushed in from outside
 *      (WETH withdrawTo, direct transfers, selfdestruct, extra PULP pushed in during a swap) never enter a
 *      zap's amounts; the owner can sweep them, to the fee recipient (treasury) only.
 *
 *      Must be called at top level, not from inside another contract's v4 unlock (the PoolManager allows one
 *      unlock at a time, so the zap's own unlock would revert).
 *
 *      Permissionless and caller-agnostic: the lock owner is always the explicit `beneficiary`, never
 *      msg.sender, so a bridge executor can be the caller. Anyone can give anyone a lock; that is the vault's
 *      own `lockFor` semantics.
 */
contract PulpZap is IUnlockCallback, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @dev TickMath.MIN_SQRT_PRICE / MAX_SQRT_PRICE (v4-core).
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    /// @dev MIN_SQRT_PRICE + 1: the swap's limit when the caller gives none (minSqrtPriceX96 == 0). Slippage is
    ///      then enforced on the output via minPulpOut only, and a partial fill reverts (see unlockCallback).
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = MIN_SQRT_PRICE + 1;
    /// @dev v4-core StateLibrary.POOLS_SLOT: PoolManager storage slot of `mapping(PoolId => Pool.State) _pools`.
    ///      slot0 (sqrtPriceX96 in the low 160 bits) is the first word of a pool's state.
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    /// @notice Hard cap on the zap fee: 2% of the input.
    uint16 public constant MAX_ZAP_FEE_BPS = 200;
    uint256 internal constant BPS = 10_000;
    /// @dev Gas forwarded with an ETH fee payment. Enough for a Safe/proxy wallet's receive; a recipient that
    ///      reverts or needs more is paid in WETH instead, so it can never block or grief a zap beyond this.
    uint256 internal constant FEE_ETH_GAS = 50_000;
    /// @dev Gas forwarded with an ETH refund to the beneficiary. Same reasoning as FEE_ETH_GAS: enough for a
    ///      Safe, 4337 or 7702 wallet's receive; a beneficiary that reverts or needs more gets WETH instead
    ///      (no loss), and a gas-burning or returndata-bombing beneficiary cannot make the refund revert.
    uint256 internal constant REFUND_ETH_GAS = 50_000;
    /// @dev Gas kept back from the selfZap hop in the *OrRefund entry points, so the catch branch can always
    ///      finish: either the InsufficientGas revert (the hop ran out of gas, see _orRefund) or the refund of a
    ///      genuine failure. Worst case is the ETH refund to a beneficiary that burns all of REFUND_ETH_GAS
    ///      (plus cold access 2,600 and value transfer 9,000), then the WETH fallback (deposit + transfer to a
    ///      fresh holder; Robinhood WETH is a proxy) and the Refunded event. Measured on a Robinhood fork with
    ///      the real WETH: the catch branch used 137,000 gas, so 250k keeps ~110k of headroom for a WETH upgrade
    ///      (it is an upgradeable proxy) or gas repricing. The figure depends on WETH's current implementation:
    ///      re-measure the catch path after any WETH `Upgraded` event (README, "Monitoring").
    uint256 internal constant REFUND_GAS_RESERVE = 250_000;
    /// @dev A failed hop that left less than hop/OOG_MARGIN_DIVISOR unused ran out of gas (see _orRefund).
    uint256 internal constant OOG_MARGIN_DIVISOR = 8;
    uint256 internal constant DAY = 1 days;

    IPoolManager public immutable poolManager;
    IPulpVeVault public immutable vault;
    IERC20 public immutable pulp;
    address public immutable weth;
    address public immutable hooks;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    bytes32 public immutable poolId;

    // Vault immutables cached at construction (they are immutable in PulpVeVault too).
    uint256 public immutable minLockAmount;
    uint256 public immutable launchStart;
    uint256 public immutable minLockTime;

    /// @notice Fee on the input, in basis points (<= MAX_ZAP_FEE_BPS).
    uint16 public zapFeeBps;
    /// @notice Receives the fee. Non-zero whenever zapFeeBps > 0.
    address public feeRecipient;

    /// @dev One zap order as the caller signed it. Passed around whole to keep the stack shallow; the
    ///      external entry points still take flat arguments (simplest for bridge calldata).
    struct ZapParams {
        address beneficiary;
        uint256 daysLocked;
        uint256 minPulpOut;
        uint160 minSqrtPriceX96; // 0 = no price limit
        uint256 maxUnlockTime;
        uint16 maxFeeBps;
        uint256 deadline;
    }

    event Zapped(
        address indexed caller,
        address indexed beneficiary,
        address indexed tokenIn, // address(0) = native ETH, else WETH
        uint256 amountIn, // gross input, fee included
        uint256 feeAmount, // part of amountIn paid to feeRecipient; amountIn - feeAmount was swapped
        uint256 pulpLocked,
        bool newLock,
        uint256 lockEnd
    );
    /// @notice The zap fee went to `recipient` as `token` (address(0) = ETH, else WETH).
    event FeePaid(address indexed recipient, address indexed token, uint256 amount);
    event ZapFeeSet(uint16 oldBps, uint16 newBps);
    event FeeRecipientSet(address indexed oldRecipient, address indexed newRecipient);
    /// @notice *OrRefund only: the lock could not happen, `amount` of `token` went to `beneficiary` instead.
    ///         `reason` is the 4-byte selector of the hop's revert (e.g. InsufficientOutput, PriceLimitReached,
    ///         UnlockTooLate, or a PoolManager/hook error), or 0x00000000 when the revert carried no data (an
    ///         inner call that ran out of gas or reverted without a reason). A hop that ran out of gas itself
    ///         is never refunded: the call reverts InsufficientGas instead.
    event Refunded(
        address indexed caller,
        address indexed beneficiary,
        address indexed token, // address(0) = native ETH, else WETH
        uint256 amount,
        bytes4 reason
    );
    /// @notice The owner moved a stray balance out to the fee recipient (`token` address(0) = ETH). See `sweep`.
    event Swept(address indexed token, address indexed to, uint256 amount);

    error NotAContract();
    error BadConfig();
    error ZeroAmount();
    error ZeroMinOut();
    error DeadlineExpired();
    error InvalidBeneficiary();
    error LocksPaused();
    error NotLaunched();
    error BadDuration();
    error MinOutBelowMinLock();
    error LockExpiredWithdrawFirst();
    error LockEndsTooSoon();
    error UnlockTooLate(uint256 lockEnd, uint256 maxUnlockTime);
    error FeeAboveMax(uint16 feeBps, uint16 maxFeeBps);
    /// @dev Same signature (and selector) as PulpVeVault's error, so callers see one reason either way.
    error EmergencyExitActive();
    /// @dev OrRefund called with less than REFUND_GAS_RESERVE gas, or the hop ran out of gas (the caller
    ///      supplied too little for the lock). Nothing is taken; retry with more gas.
    error InsufficientGas();
    /// @dev minSqrtPriceX96 outside (MIN_SQRT_PRICE, MAX_SQRT_PRICE).
    error InvalidPriceLimit(uint160 minSqrtPriceX96);
    /// @dev The pool price is at or below the caller's limit (before the swap), or the swap stopped at it.
    error PriceLimitReached(uint160 sqrtPriceX96, uint160 minSqrtPriceX96);
    /// @dev The pool id computed from the constructor arguments is not the one the deployer expected.
    error PoolIdMismatch(bytes32 computed, bytes32 expected);
    error InvalidRecipient();
    error InsufficientOutput(uint256 pulpOut, uint256 minPulpOut);
    error NotPoolManager();
    error OnlySelf();
    error UnexpectedSwapDelta();
    error UnexpectedBalance();
    error UnexpectedETH();
    error FeeTooHigh(uint16 bps);
    error InvalidFeeRecipient();
    error RenounceDisabled();

    constructor(
        IPoolManager poolManager_,
        IPulpVeVault vault_,
        address weth_,
        address hooks_,
        uint24 fee_,
        int24 tickSpacing_,
        bytes32 expectedPoolId_,
        address owner_,
        uint16 zapFeeBps_,
        address feeRecipient_
    ) Ownable(owner_) {
        if (address(poolManager_).code.length == 0 || address(vault_).code.length == 0 || weth_.code.length == 0) {
            revert NotAContract();
        }
        address pulp_ = vault_.pulp();
        if (pulp_ == address(0) || pulp_ == weth_) revert BadConfig();
        poolManager = poolManager_;
        vault = vault_;
        pulp = IERC20(pulp_);
        weth = weth_;
        hooks = hooks_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        bytes32 id = keccak256(abi.encode(address(0), pulp_, fee_, tickSpacing_, hooks_));
        if (id != expectedPoolId_) revert PoolIdMismatch(id, expectedPoolId_);
        poolId = id;
        minLockAmount = vault_.minLockAmount();
        launchStart = vault_.launchStart();
        minLockTime = vault_.MIN_LOCK_TIME();
        // Recipient first so the fee check sees it. A zero recipient is allowed only with a zero fee.
        if (feeRecipient_ != address(0)) _setFeeRecipient(feeRecipient_);
        _setZapFee(zapFeeBps_);
    }

    // ------------------------------------------------------------------------------------------------
    // Owner: fee within the hard cap, its recipient, and sweeping strays. Nothing else.
    // ------------------------------------------------------------------------------------------------

    /// @notice Set the fee. Applies to the next zap; callers are protected by their own maxFeeBps (and
    ///         minPulpOut).
    function setZapFee(uint16 newBps) external onlyOwner {
        _setZapFee(newBps);
    }

    /// @notice Set the fee recipient (the treasury; also the only `sweep` destination). Not zero, the zap, the
    ///         vault, WETH, PULP, the PoolManager or the hook.
    function setFeeRecipient(address newRecipient) external onlyOwner {
        _setFeeRecipient(newRecipient);
    }

    /// @notice Send this contract's whole balance of `token` (address(0) = ETH) to `feeRecipient` (the treasury).
    /// @dev Safe because the zap never holds user funds between transactions: every entry point locks, pays
    ///      out or refunds everything it received before returning, so any balance seen here outside a zap
    ///      is a stray (ETH pushed in through WETH `withdrawTo`, which passes the `msg.sender == weth` check in
    ///      receive(); direct token transfers; selfdestruct; PULP pushed in during a swap). nonReentrant, so it
    ///      cannot run inside a zap (from the fee recipient, the beneficiary, the hook or a token callback)
    ///      while the zap does hold the input in flight. The destination is fixed to the fee recipient, so a
    ///      compromised owner key cannot send strays anywhere new without first moving the fee recipient
    ///      (an event every monitor sees).
    function sweep(address token) external onlyOwner nonReentrant {
        address to = feeRecipient;
        if (to == address(0)) revert InvalidRecipient();
        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            Address.sendValue(payable(to), amount);
        } else {
            amount = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransfer(to, amount);
        }
        emit Swept(token, to, amount);
    }

    /// @dev Like the vault: ownership can be handed over (two-step) but not dropped. A renounced owner would
    ///      freeze the fee forever; to stop charging, set the fee to 0 instead.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------------------------------------
    // Strict entry points: lock everything bought, or revert (bridge refund logic then applies).
    // ------------------------------------------------------------------------------------------------

    /// @notice Pay the zap fee out of msg.value, sell the rest for PULP and lock it for `beneficiary` (new lock
    ///         of `daysLocked` days, or added to the existing lock, in which case `daysLocked` is ignored).
    /// @param minPulpOut Minimum PULP to lock, net of the zap fee and the pool hook's tax. Must be > 0, and
    ///        >= vault minLockAmount when a new lock is opened.
    /// @param minSqrtPriceX96 Lowest pool sqrtPriceX96 the swap may reach (ETH -> PULP lowers the price), or 0
    ///        for no limit. Must be in (MIN_SQRT_PRICE, MAX_SQRT_PRICE) and below the current price; reverts
    ///        PriceLimitReached if the price is already at/below it or the swap would cross it (no partial
    ///        fills). Frontends derive it from the quoted post-swap price minus a margin.
    /// @param maxUnlockTime Latest acceptable unlock time of the beneficiary's lock after the zap. Reverts
    ///        UnlockTooLate if the existing lock (or the new one) ends later. Frontends pass
    ///        `deadline + daysLocked days` for a new lock, or the displayed `end` for a top-up.
    /// @param maxFeeBps Highest zap fee accepted; reverts FeeAboveMax if zapFeeBps is higher.
    function zapETH(
        address beneficiary,
        uint256 daysLocked,
        uint256 minPulpOut,
        uint160 minSqrtPriceX96,
        uint256 maxUnlockTime,
        uint16 maxFeeBps,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 pulpLocked) {
        ZapParams memory p =
            ZapParams(beneficiary, daysLocked, minPulpOut, minSqrtPriceX96, maxUnlockTime, maxFeeBps, deadline);
        return _zap(msg.sender, p, msg.value, false);
    }

    /// @notice Pull `wethAmount` WETH from msg.sender (needs an approval), pay the fee in WETH, unwrap the rest,
    ///         buy PULP, lock it. Same bounds as zapETH.
    ///         `wethAmount == type(uint256).max` means "msg.sender's whole WETH balance" (exact input for
    ///         bridge executors and for reinvesting a vault WETH reward claim).
    function zapWETH(
        address beneficiary,
        uint256 wethAmount,
        uint256 daysLocked,
        uint256 minPulpOut,
        uint160 minSqrtPriceX96,
        uint256 maxUnlockTime,
        uint16 maxFeeBps,
        uint256 deadline
    ) external nonReentrant returns (uint256 pulpLocked) {
        ZapParams memory p =
            ZapParams(beneficiary, daysLocked, minPulpOut, minSqrtPriceX96, maxUnlockTime, maxFeeBps, deadline);
        // Validate before pulling so bad calls fail cheaply; pulling cannot change the outcome.
        _preflight(p, 1);
        uint256 amountIn = _pullWETH(wethAmount);
        return _zap(msg.sender, p, amountIn, true);
    }

    // ------------------------------------------------------------------------------------------------
    // Non-reverting entry points for bridge destination calls: lock, or hand the input to the beneficiary.
    // ------------------------------------------------------------------------------------------------

    /// @notice Like zapETH, but if the swap+lock fails for a genuine reason (deadline, slippage, price limit,
    ///         unlock time, fee bound, lock rules, pause, pool or hook revert) the whole msg.value, fee
    ///         included, is sent to `beneficiary` instead (as WETH if the beneficiary cannot take ETH within
    ///         REFUND_ETH_GAS). Reverts, taking nothing, for a zero amount, an unusable beneficiary, or too
    ///         little gas: less than REFUND_GAS_RESERVE, or not enough for the hop to finish (InsufficientGas).
    /// @dev Because running out of gas reverts instead of refunding, eth_estimateGas on this function sizes
    ///      the lock path (or a genuine refund). Use the estimate of this call itself, plus ~10% headroom.
    function zapETHOrRefund(
        address beneficiary,
        uint256 daysLocked,
        uint256 minPulpOut,
        uint160 minSqrtPriceX96,
        uint256 maxUnlockTime,
        uint16 maxFeeBps,
        uint256 deadline
    ) external payable nonReentrant returns (bool locked, uint256 pulpLocked) {
        _checkBeneficiary(beneficiary);
        if (msg.value == 0) revert ZeroAmount();
        ZapParams memory p =
            ZapParams(beneficiary, daysLocked, minPulpOut, minSqrtPriceX96, maxUnlockTime, maxFeeBps, deadline);
        return _orRefund(p, msg.value, false);
    }

    /// @notice Like zapWETH, but on a genuine failure after the pull the whole WETH amount (fee included) is
    ///         transferred to `beneficiary`.
    ///         Reverts only if the pull itself fails, the amount is zero, the beneficiary is unusable or the
    ///         gas is too little (InsufficientGas). Same gas-estimation note as above.
    function zapWETHOrRefund(
        address beneficiary,
        uint256 wethAmount,
        uint256 daysLocked,
        uint256 minPulpOut,
        uint160 minSqrtPriceX96,
        uint256 maxUnlockTime,
        uint16 maxFeeBps,
        uint256 deadline
    ) external nonReentrant returns (bool locked, uint256 pulpLocked) {
        _checkBeneficiary(beneficiary);
        uint256 amountIn = _pullWETH(wethAmount);
        ZapParams memory p =
            ZapParams(beneficiary, daysLocked, minPulpOut, minSqrtPriceX96, maxUnlockTime, maxFeeBps, deadline);
        return _orRefund(p, amountIn, true);
    }

    /// @dev Internal hop for the *OrRefund entry points so a failure rolls back atomically and can be caught.
    ///      Only callable by this contract (from inside a nonReentrant entry point). `caller` is the outer
    ///      msg.sender, so Zapped reports the real caller (e.g. the bridge executor), not the zap.
    ///      wethIn == 0: sell msg.value ETH. wethIn > 0: unwrap that much WETH already held by this contract.
    function selfZap(address caller, uint256 wethIn, ZapParams calldata p) external payable returns (uint256) {
        if (msg.sender != address(this)) revert OnlySelf();
        if (wethIn == 0) return _zap(caller, p, msg.value, false);
        if (msg.value != 0) revert UnexpectedETH();
        return _zap(caller, p, wethIn, true);
    }

    // ------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------

    /// @notice Dry-run of every check that can be done before swapping, except the fee bound (compare
    ///         `zapFeeBps()` with your maxFeeBps): deadline-free lock rules, beneficiary, unlock-time bound and
    ///         the price limit against the current pool price (0 = no limit).
    /// @return newLock True if a zap would open a new lock, false if it would add to the existing one.
    ///         Reverts with the same error the zap would.
    function checkBeneficiary(
        address beneficiary,
        uint256 daysLocked,
        uint256 minPulpOut,
        uint160 minSqrtPriceX96,
        uint256 maxUnlockTime
    ) external view returns (bool newLock) {
        return _preflight(
            ZapParams(
                beneficiary, daysLocked, minPulpOut, minSqrtPriceX96, maxUnlockTime, type(uint16).max, block.timestamp
            ),
            1
        );
    }

    /// @notice Fee and swapped amount for an input of `amountIn` (ETH or WETH) at the current fee.
    ///         Quote the pool with `net` to get the PULP that would be locked.
    function quoteFee(uint256 amountIn) public view returns (uint256 fee_, uint256 net) {
        fee_ = Math.mulDiv(amountIn, zapFeeBps, BPS);
        net = amountIn - fee_;
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(address(0), address(pulp), fee, tickSpacing, hooks);
    }

    /// @notice The pool's current sqrtPriceX96 (PULP per ETH, Q64.96), read from the PoolManager's storage.
    ///         Selling ETH lowers it; a caller's minSqrtPriceX96 must be below it.
    function sqrtPriceX96() public view returns (uint160) {
        return uint160(uint256(poolManager.extsload(keccak256(abi.encodePacked(poolId, POOLS_SLOT)))));
    }

    // ------------------------------------------------------------------------------------------------
    // Uniswap v4 callback
    // ------------------------------------------------------------------------------------------------

    /// @dev The PoolManager only calls back the address that called unlock(), and only _swap() calls unlock().
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 amountIn, uint160 limit) = abi.decode(data, (uint256, uint160));

        int256 delta = poolManager.swap(
            poolKey(),
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: limit == 0 ? MIN_SQRT_PRICE_LIMIT : limit
            }),
            ""
        );
        int128 delta0 = int128(delta >> 128); // ETH, caller view
        int128 delta1 = int128(delta); // PULP, caller view
        // Exact input must be consumed in full (no partial fill, no extra charge) and PULP must come out.
        // A swap that stopped at the caller's price limit is a partial fill: report it as such.
        if (int256(delta0) != -int256(amountIn) || delta1 <= 0) {
            if (limit != 0) {
                uint160 price = sqrtPriceX96();
                if (price <= limit) revert PriceLimitReached(price, limit);
            }
            revert UnexpectedSwapDelta();
        }
        uint256 pulpOut = uint256(int256(delta1));

        // settle() pays the globally synced currency. Anyone (the hook, or whoever the hook forwards ETH to)
        // can sync() another currency inside our unlock window and leave it dangling, which would make a
        // native settle revert. Re-sync native first, like v4-periphery's DeltaResolver.
        poolManager.sync(address(0));
        poolManager.settle{value: amountIn}();
        poolManager.take(address(pulp), address(this), pulpOut);
        return abi.encode(pulpOut);
    }

    /// @dev Accepts ETH only from WETH. That covers our own unwrap, but not only it: Robinhood WETH has
    ///      `withdrawTo(address,uint256)`, so anyone can push ETH in through WETH, and selfdestruct bypasses
    ///      receive() entirely. Such strays are harmless (every amount comes from msg.value or a measured
    ///      delta) and the owner can `sweep` them. WETH9.withdraw uses a 2300-gas transfer, so this must stay
    ///      a single comparison. Payments come in through the payable entry points instead.
    receive() external payable {
        if (msg.sender != weth) revert UnexpectedETH();
    }

    // ------------------------------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------------------------------

    function _zap(address caller, ZapParams memory p, uint256 amountIn, bool fromWETH)
        private
        returns (uint256 pulpOut)
    {
        bool newLock = _preflight(p, amountIn);

        (uint256 feeAmount, uint256 swapIn) = _takeFee(amountIn, fromWETH);
        pulpOut = _swap(swapIn, p.minSqrtPriceX96);
        if (pulpOut < p.minPulpOut) revert InsufficientOutput(pulpOut, p.minPulpOut);

        pulp.forceApprove(address(vault), pulpOut);
        if (newLock) vault.lockFor(p.beneficiary, pulpOut, p.daysLocked);
        else vault.increaseAmountFor(p.beneficiary, pulpOut);
        pulp.forceApprove(address(vault), 0);

        // Re-check the bound on what the vault actually recorded (the preflight checked the expected end).
        (,, uint256 end) = vault.locks(p.beneficiary);
        if (end > p.maxUnlockTime) revert UnlockTooLate(end, p.maxUnlockTime);
        emit Zapped(caller, p.beneficiary, fromWETH ? weth : address(0), amountIn, feeAmount, pulpOut, newLock, end);
    }

    /// @dev Pays the fee out of the input and leaves exactly `swapIn` ETH to sell (unwrapping WETH if needed).
    ///      Runs inside selfZap for the *OrRefund entry points, so a later failure rolls the payment back.
    function _takeFee(uint256 amountIn, bool fromWETH) private returns (uint256 feeAmount, uint256 swapIn) {
        (feeAmount, swapIn) = quoteFee(amountIn);
        address recipient = feeRecipient;
        if (fromWETH) {
            if (feeAmount != 0) {
                IERC20(weth).safeTransfer(recipient, feeAmount);
                emit FeePaid(recipient, weth, feeAmount);
            }
            uint256 ethBefore = address(this).balance;
            IWETH9(weth).withdraw(swapIn);
            if (address(this).balance - ethBefore != swapIn) revert UnexpectedBalance();
        } else if (feeAmount != 0) {
            emit FeePaid(recipient, _payETHOrWETH(recipient, feeAmount, FEE_ETH_GAS), feeAmount);
        }
    }

    /// @dev Sends ETH with a gas cap (no returndata copied); if the recipient refuses, wraps and sends WETH.
    ///      Never reverts because of the recipient, so a misconfigured or hostile recipient (fee) or
    ///      beneficiary (refund) cannot block a zap or a refund.
    /// @return token address(0) if paid in ETH, else WETH.
    function _payETHOrWETH(address to, uint256 amount, uint256 gasLimit) private returns (address token) {
        bool ok;
        assembly {
            ok := call(gasLimit, to, amount, 0, 0, 0, 0)
        }
        if (ok) return address(0);
        IWETH9(weth).deposit{value: amount}();
        IERC20(weth).safeTransfer(to, amount);
        return weth;
    }

    function _setZapFee(uint16 newBps) private {
        if (newBps > MAX_ZAP_FEE_BPS) revert FeeTooHigh(newBps);
        if (newBps != 0 && feeRecipient == address(0)) revert InvalidFeeRecipient();
        emit ZapFeeSet(zapFeeBps, newBps);
        zapFeeBps = newBps;
    }

    /// @dev Same deny-list as beneficiaries: the zap or WETH would leave funds in the zap (WETH mints to the
    ///      sender on receive); the vault, PULP, the PoolManager and the hook are sinks nobody can sweep from.
    function _setFeeRecipient(address newRecipient) private {
        if (_isProtocolAddress(newRecipient)) revert InvalidFeeRecipient();
        emit FeeRecipientSet(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// @return pulpOut PULP received from the pool (net of the hook tax), verified against our balance.
    /// @dev `<`, not `!=`: code that runs inside the swap (the hook, or a party it calls) could push extra PULP
    ///      in and would otherwise make every zap revert. Exactly `pulpOut` is locked; any surplus is a stray
    ///      for `sweep`.
    function _swap(uint256 amountIn, uint160 limit) private returns (uint256 pulpOut) {
        uint256 before = pulp.balanceOf(address(this));
        pulpOut = abi.decode(poolManager.unlock(abi.encode(amountIn, limit)), (uint256));
        if (pulp.balanceOf(address(this)) - before < pulpOut) revert UnexpectedBalance();
    }

    function _pullWETH(uint256 wethAmount) private returns (uint256 amount) {
        amount = wethAmount == type(uint256).max ? IERC20(weth).balanceOf(msg.sender) : wethAmount;
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(weth).balanceOf(address(this));
        IERC20(weth).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(weth).balanceOf(address(this)) - before != amount) revert UnexpectedBalance();
    }

    /// @dev Everything that can be checked before swapping. Mirrors PulpVeVault's lock/increase rules, plus
    ///      the caller's bounds (fee, unlock time, price limit).
    function _preflight(ZapParams memory p, uint256 amountIn) private view returns (bool newLock) {
        if (block.timestamp > p.deadline) revert DeadlineExpired();
        if (amountIn == 0) revert ZeroAmount();
        if (p.minPulpOut == 0) revert ZeroMinOut();
        _checkBeneficiary(p.beneficiary);
        if (vault.emergencyExit()) revert EmergencyExitActive();
        if (vault.locksPaused()) revert LocksPaused();
        if (block.timestamp < launchStart) revert NotLaunched();
        uint16 feeBps = zapFeeBps;
        if (feeBps > p.maxFeeBps) revert FeeAboveMax(feeBps, p.maxFeeBps);

        (uint256 lockedAmount,, uint256 end) = vault.locks(p.beneficiary);
        if (lockedAmount == 0) {
            if (p.daysLocked != 10 && p.daysLocked != 20 && p.daysLocked != 30) revert BadDuration();
            if (p.minPulpOut < minLockAmount) revert MinOutBelowMinLock();
            end = block.timestamp + p.daysLocked * DAY; // what the vault will record
            newLock = true;
        } else {
            if (block.timestamp >= end) revert LockExpiredWithdrawFirst();
            if (end - block.timestamp < minLockTime) revert LockEndsTooSoon();
        }
        if (end > p.maxUnlockTime) revert UnlockTooLate(end, p.maxUnlockTime);

        uint160 limit = p.minSqrtPriceX96;
        if (limit != 0) {
            if (limit <= MIN_SQRT_PRICE || limit >= MAX_SQRT_PRICE) revert InvalidPriceLimit(limit);
            uint160 price = sqrtPriceX96();
            // v4 would revert PriceLimitAlreadyExceeded; fail here first, before the fee and the swap.
            if (price <= limit) revert PriceLimitReached(price, limit);
        }
    }

    /// @dev A lock owned by the vault or by this zap could never be withdrawn. WETH, PULP, the PoolManager and
    ///      the hook cannot withdraw either, and a refund to WETH would be minted back to the zap (WETH
    ///      credits msg.sender on receive) and stranded.
    function _checkBeneficiary(address beneficiary) private view {
        if (_isProtocolAddress(beneficiary)) revert InvalidBeneficiary();
    }

    /// @dev Zero, this zap, the vault, WETH, PULP, the PoolManager or the hook: not a usable beneficiary or fee
    ///      recipient (see _checkBeneficiary / _setFeeRecipient).
    function _isProtocolAddress(address a) private view returns (bool) {
        return a == address(0) || a == address(this) || a == address(vault) || a == weth || a == address(pulp)
            || a == address(poolManager) || a == hooks;
    }

    /// @dev The *OrRefund core. Runs the zap in a selfZap hop with all gas but REFUND_GAS_RESERVE; on a genuine
    ///      failure the whole input goes to the beneficiary. A hop that failed because it ran out of gas
    ///      reverts InsufficientGas instead: otherwise the cheapest non-reverting outcome of the call would be
    ///      a refund, and every gas estimator (eth_estimateGas binary search, bridge simulators) would size
    ///      the refund instead of the lock (audit M-B).
    ///
    ///      Out-of-gas test: the hop used all but at most hop/OOG_MARGIN_DIVISOR of the gas it was given.
    ///      An out-of-gas k calls below the hop leaves at most hop * (1 - (63/64)^k) unused (each frame keeps
    ///      1/64 back and returns it when it bubbles the revert), so 1/8 covers out-of-gas up to 8 calls deep
    ///      (11.8%). The swap path is about 6 deep (hop -> unlock -> unlockCallback -> swap -> hook -> take ->
    ///      token). A bare `hop/63` margin would only catch the hop's own frame and its direct callees; an
    ///      out-of-gas inside the swap or the hook would then look like a genuine failure and be refunded,
    ///      which estimators could again settle on. Price: a genuine failure is refunded only if it used less
    ///      than 7/8 of the hop. Real failures (price, deadline, bounds, pause, pool or hook revert) happen at
    ///      or before the swap, far below a lock's gas, so with gas sized for the lock they always refund.
    function _orRefund(ZapParams memory p, uint256 amountIn, bool fromWETH)
        private
        returns (bool locked, uint256 pulpLocked)
    {
        uint256 g = gasleft();
        if (g <= REFUND_GAS_RESERVE) revert InsufficientGas();
        uint256 hop = g - REFUND_GAS_RESERVE;
        uint256 g0 = gasleft();
        try this.selfZap{value: fromWETH ? 0 : amountIn, gas: hop}(msg.sender, fromWETH ? amountIn : 0, p) returns (
            uint256 out
        ) {
            return (true, out);
        } catch {
            bytes4 reason = _returnedSelector(); // first: the refund call below overwrites the returndata
            if (g0 - gasleft() + hop / OOG_MARGIN_DIVISOR >= hop) revert InsufficientGas();
            address token;
            if (fromWETH) {
                IERC20(weth).safeTransfer(p.beneficiary, amountIn);
                token = weth;
            } else {
                token = _payETHOrWETH(p.beneficiary, amountIn, REFUND_ETH_GAS);
            }
            emit Refunded(msg.sender, p.beneficiary, token, amountIn, reason);
            return (false, 0);
        }
    }

    /// @dev First 4 bytes of the last call's revert data (0 if shorter, e.g. out of gas), read without copying
    ///      the rest: a hop that bubbles up a huge revert blob cannot make the catch branch run out of gas.
    ///      Must be the first thing in a catch block, before any other call overwrites the returndata.
    function _returnedSelector() private pure returns (bytes4 sel) {
        assembly {
            if gt(returndatasize(), 3) {
                returndatacopy(0, 0, 4)
                sel := and(mload(0), 0xffffffff00000000000000000000000000000000000000000000000000000000)
            }
        }
    }
}
