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
 * @dev Swaps exact input directly on the v4 PoolManager (unlock -> swap -> sync + settle ETH -> take PULP).
 *
 *      Roles: owner (Ownable2Step, cannot renounce) sets the fee (<= MAX_ZAP_FEE_BPS, 2%) and its recipient
 *      (the treasury) and can `sweep` strays to that recipient; it cannot touch user funds, locks or the pool.
 *      The fee is taken from the input before the swap and is rolled back when an *OrRefund call refunds.
 *
 *      Caller bounds: minPulpOut, minSqrtPriceX96 (optional price limit), maxUnlockTime, maxFeeBps, deadline.
 *      The lock owner is always the explicit `beneficiary`, never msg.sender (bridge-friendly).
 *      No funds stay here between transactions: every path locks everything, reverts or refunds the input.
 *      Must be called at top level, not inside another v4 unlock.
 *
 *      Design: docs/ZAP.md.
 */
contract PulpZap is IUnlockCallback, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @dev TickMath.MIN_SQRT_PRICE / MAX_SQRT_PRICE (v4-core).
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    /// @dev Swap limit when the caller gives none (minSqrtPriceX96 == 0).
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = MIN_SQRT_PRICE + 1;
    /// @dev v4-core StateLibrary.POOLS_SLOT (PoolManager `_pools`); a pool's first word is slot0.
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    /// @notice Hard cap on the zap fee: 2% of the input.
    uint16 public constant MAX_ZAP_FEE_BPS = 200;
    uint256 internal constant BPS = 10_000;
    /// @dev Gas forwarded with an ETH fee payment; a recipient that reverts or needs more is paid in WETH.
    uint256 internal constant FEE_ETH_GAS = 50_000;
    /// @dev Gas forwarded with an ETH refund; a beneficiary that reverts or needs more gets WETH.
    uint256 internal constant REFUND_ETH_GAS = 50_000;
    /// @dev Gas kept back from the selfZap hop so the catch branch can always finish (worst case: ETH refund
    ///      burning REFUND_ETH_GAS, then the WETH fallback). Measured ~137k on a fork; re-measure after any
    ///      WETH `Upgraded` event (docs/ZAP.md, "Gas").
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

    // Vault immutables, cached at construction.
    uint256 public immutable minLockAmount;
    uint256 public immutable launchStart;
    uint256 public immutable minLockTime;

    /// @notice Fee on the input, in basis points (<= MAX_ZAP_FEE_BPS).
    uint16 public zapFeeBps;
    /// @notice Receives the fee. Non-zero whenever zapFeeBps > 0.
    address public feeRecipient;

    /// @dev One zap order, bundled to keep the stack shallow (entry points take flat arguments).
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
    /// @notice *OrRefund only: the lock failed and `amount` of `token` (address(0) = ETH) went to `beneficiary`.
    ///         `reason` is the selector of the failure (0x00000000 if the revert carried no data).
    event Refunded(
        address indexed caller,
        address indexed beneficiary,
        address indexed token, // address(0) = native ETH, else WETH
        uint256 amount,
        bytes4 reason
    );
    /// @notice The owner moved a stray balance to the fee recipient (`token` address(0) = ETH).
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
    /// @dev *OrRefund given too little gas for the lock. Nothing is taken; retry with more gas.
    error InsufficientGas();
    /// @dev minSqrtPriceX96 outside (MIN_SQRT_PRICE, MAX_SQRT_PRICE).
    error InvalidPriceLimit(uint160 minSqrtPriceX96);
    /// @dev The pool price is at or below the caller's limit (before the swap), or the swap stopped at it.
    error PriceLimitReached(uint160 sqrtPriceX96, uint160 minSqrtPriceX96);
    /// @dev Pool id from the constructor arguments differs from the expected one.
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
    // Owner
    // ------------------------------------------------------------------------------------------------

    /// @notice Owner: set the zap fee in bps (<= MAX_ZAP_FEE_BPS). Callers are bounded by their maxFeeBps.
    function setZapFee(uint16 newBps) external onlyOwner {
        _setZapFee(newBps);
    }

    /// @notice Owner: set the fee recipient (the treasury; also the only `sweep` destination).
    function setFeeRecipient(address newRecipient) external onlyOwner {
        _setFeeRecipient(newRecipient);
    }

    /// @notice Owner: send this contract's whole balance of `token` (address(0) = ETH) to `feeRecipient`.
    /// @dev Outside a zap any balance is a stray (no user funds stay between transactions); nonReentrant, so it
    ///      cannot run mid-zap.
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

    /// @notice Disabled: ownership can be transferred but not renounced (set the fee to 0 instead).
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------------------------------------
    // Strict entry points: lock everything bought, or revert.
    // ------------------------------------------------------------------------------------------------

    /// @notice Pay the fee out of msg.value, buy PULP with the rest and lock it for `beneficiary` (a new lock
    ///         of `daysLocked` days, or added to the existing lock, ignoring `daysLocked`).
    /// @param minPulpOut Minimum PULP locked, net of fee and hook tax. > 0, and >= minLockAmount for a new lock.
    /// @param minSqrtPriceX96 Lowest pool price the swap may reach, or 0 for none. Reverts PriceLimitReached
    ///        if the price is already at/below it or the swap would cross it (no partial fills).
    /// @param maxUnlockTime Latest acceptable end of the beneficiary's lock after the zap (else UnlockTooLate).
    /// @param maxFeeBps Highest zap fee accepted (else FeeAboveMax).
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

    /// @notice Like zapETH, paid with `wethAmount` WETH pulled from msg.sender (needs approval);
    ///         type(uint256).max means the caller's whole WETH balance.
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
        // Validate before pulling so bad calls fail cheaply.
        _preflight(p, 1);
        uint256 amountIn = _pullWETH(wethAmount);
        return _zap(msg.sender, p, amountIn, true);
    }

    // ------------------------------------------------------------------------------------------------
    // Non-reverting entry points for bridge destination calls: lock, or hand the input to the beneficiary.
    // ------------------------------------------------------------------------------------------------

    /// @notice Like zapETH, but if the zap fails the whole msg.value (fee included) goes to `beneficiary`
    ///         (as WETH if it cannot take ETH). Reverts for a zero amount, an unusable beneficiary or too
    ///         little gas (InsufficientGas), so eth_estimateGas sizes the lock path; add ~10% headroom.
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

    /// @notice Like zapWETH, but if the zap fails the whole pulled WETH (fee included) goes to `beneficiary`.
    ///         Reverts as zapETHOrRefund, or if the pull fails.
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

    /// @notice Internal hop of the *OrRefund entry points; callable only by this contract.
    /// @dev Lets a failure roll back atomically and be caught. `caller` is the outer msg.sender.
    ///      wethIn == 0: sell msg.value ETH; otherwise unwrap that much WETH already held here.
    function selfZap(address caller, uint256 wethIn, ZapParams calldata p) external payable returns (uint256) {
        if (msg.sender != address(this)) revert OnlySelf();
        if (wethIn == 0) return _zap(caller, p, msg.value, false);
        if (msg.value != 0) revert UnexpectedETH();
        return _zap(caller, p, wethIn, true);
    }

    // ------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------

    /// @notice Dry-run of the pre-swap checks (except deadline and fee bound); reverts with the zap's error.
    /// @return newLock True if a zap would open a new lock, false if it would add to the existing one.
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

    /// @notice The native-ETH/PULP pool key.
    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(address(0), address(pulp), fee, tickSpacing, hooks);
    }

    /// @notice The pool's current sqrtPriceX96 (PULP per ETH, Q64.96). Selling ETH lowers it.
    function sqrtPriceX96() public view returns (uint160) {
        return uint160(uint256(poolManager.extsload(keccak256(abi.encodePacked(poolId, POOLS_SLOT)))));
    }

    // ------------------------------------------------------------------------------------------------
    // Uniswap v4 callback
    // ------------------------------------------------------------------------------------------------

    /// @notice PoolManager callback; performs the swap. Only the PoolManager may call it.
    /// @dev The exact input must be consumed in full and PULP must come out (delta check).
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
        // No partial fill, no extra charge, PULP out. A stop at the caller's price limit reports as such.
        if (int256(delta0) != -int256(amountIn) || delta1 <= 0) {
            if (limit != 0) {
                uint160 price = sqrtPriceX96();
                if (price <= limit) revert PriceLimitReached(price, limit);
            }
            revert UnexpectedSwapDelta();
        }
        uint256 pulpOut = uint256(int256(delta1));

        // Re-sync native first: another party may have synced a different currency in this unlock.
        poolManager.sync(address(0));
        poolManager.settle{value: amountIn}();
        poolManager.take(address(pulp), address(this), pulpOut);
        return abi.encode(pulpOut);
    }

    /// @notice Accepts ETH only from WETH (unwraps). Must stay within WETH9's 2300-gas stipend.
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

        // Re-check the bound on the end the vault actually recorded.
        (,, uint256 end) = vault.locks(p.beneficiary);
        if (end > p.maxUnlockTime) revert UnlockTooLate(end, p.maxUnlockTime);
        emit Zapped(caller, p.beneficiary, fromWETH ? weth : address(0), amountIn, feeAmount, pulpOut, newLock, end);
    }

    /// @dev Pays the fee out of the input and leaves exactly `swapIn` ETH to sell (unwrapping WETH if needed).
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

    /// @dev Sends ETH with a gas cap and no returndata copy; if the recipient refuses, sends WETH instead.
    ///      Never reverts because of the recipient.
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

    /// @dev Same deny-list as beneficiaries (see _isProtocolAddress).
    function _setFeeRecipient(address newRecipient) private {
        if (_isProtocolAddress(newRecipient)) revert InvalidFeeRecipient();
        emit FeeRecipientSet(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// @dev Balance delta check uses `<`, not `!=`: extra PULP pushed in during the swap must not block zaps;
    ///      only `pulpOut` is locked and any surplus is a stray for `sweep`.
    /// @return pulpOut PULP received from the pool (net of the hook tax).
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

    /// @dev Pre-swap checks: PulpVeVault's lock/increase rules plus the caller's bounds.
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
            // Fail before the fee and the swap (v4 would revert PriceLimitAlreadyExceeded).
            if (price <= limit) revert PriceLimitReached(price, limit);
        }
    }

    /// @dev Locks or refunds to protocol addresses would be stranded.
    function _checkBeneficiary(address beneficiary) private view {
        if (_isProtocolAddress(beneficiary)) revert InvalidBeneficiary();
    }

    /// @dev Zero, this zap, the vault, WETH, PULP, the PoolManager or the hook.
    function _isProtocolAddress(address a) private view returns (bool) {
        return a == address(0) || a == address(this) || a == address(vault) || a == weth || a == address(pulp)
            || a == address(poolManager) || a == hooks;
    }

    /// @dev Runs the zap in a selfZap hop with all gas but REFUND_GAS_RESERVE; on failure refunds the input.
    ///      A hop that ran out of gas reverts InsufficientGas instead, so gas estimators size the lock, not
    ///      the refund. Out-of-gas test: less than hop/8 left unused. By the 63/64 rule an out-of-gas k frames
    ///      deep leaves at most hop * (1 - (63/64)^k) unused, so 1/8 covers up to 8 frames (swap path ~6).
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
            bytes4 reason = _returnedSelector(); // before any call overwrites the returndata
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

    /// @dev First 4 bytes of the last call's revert data (0 if shorter), without copying the rest
    ///      (return-bomb safe). Call first in a catch block.
    function _returnedSelector() private pure returns (bytes4 sel) {
        assembly {
            if gt(returndatasize(), 3) {
                returndatacopy(0, 0, 4)
                sel := and(mload(0), 0xffffffff00000000000000000000000000000000000000000000000000000000)
            }
        }
    }
}
