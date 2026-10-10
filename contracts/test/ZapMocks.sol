// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey, SwapParams, IUnlockCallback} from "../interfaces/IUniswapV4.sol";

/// @dev Test-only stand-in for the v4 PoolManager: just the unlock/swap/sync/settle/take surface PulpZap uses.
///      Fills ETH -> PULP at a fixed price, minus a hook-style tax on the output, and enforces that every
///      delta is settled before unlock() returns (like the real CurrencyNotSettled check).
///      sync/settle follow v4-core: sync is permissionless, settle pays the synced currency (msg.value for
///      native, reverting NonzeroNativeValue if an ERC-20 is synced and value is sent) and then resets it.
///      v4 keeps the synced currency in transient storage; here it is cleared when unlock() returns.
///      Price limits: the pool has a sqrtPriceX96 (readable through extsload at the v4 StateLibrary slot) that
///      falls by `sqrtDropPerWei` per wei sold (0 = flat, the default). A swap reverts
///      PriceLimitAlreadyExceeded if the limit is at/above the price (as v4 does), and stops at the limit
///      (partial fill) if selling everything would cross it. The PULP output still uses the flat pulpPerEth.
contract MockPoolManager {
    address public immutable pulp;
    address public immutable hooks;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;

    uint256 public pulpPerEth; // WAD
    uint256 public taxBps = 300;
    bool public partialFill;

    address public reenterTarget;
    bytes public reenterData;
    bool public reenterAttempted;
    bool public reenterSucceeded;
    /// @dev Like a v4 hook call: if the re-entry fails, the swap reverts (v4 wraps it in WrappedError).
    bool public reenterMustSucceed;

    uint160 public sqrtPriceX96 = uint160(1414 << 96); // ~2,000,000 PULP per ETH
    uint256 public sqrtDropPerWei;

    bool private _unlocked;
    address private _locker;
    int256 private _delta0;
    int256 private _delta1;

    address public syncedCurrency; // address(0) = native
    uint256 public syncedReserves;

    error AlreadyUnlocked();
    error ManagerLocked();
    error CurrencyNotSettled();
    error BadKey();
    error BadSwap();
    error NonzeroNativeValue();
    error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96);
    error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96);
    error HookCallFailed();

    constructor(address pulp_, address hooks_, uint24 fee_, int24 tickSpacing_, uint256 pulpPerEth_) {
        pulp = pulp_;
        hooks = hooks_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        pulpPerEth = pulpPerEth_;
    }

    function setPrice(uint256 p) external { pulpPerEth = p; }
    function setTaxBps(uint256 t) external { taxBps = t; }
    function setPartialFill(bool on) external { partialFill = on; }
    function setSqrtPrice(uint160 p) external { sqrtPriceX96 = p; }
    function setSqrtDropPerWei(uint256 d) external { sqrtDropPerWei = d; }
    function setReenterMustSucceed(bool on) external { reenterMustSucceed = on; }

    function poolId() public view returns (bytes32) {
        return keccak256(abi.encode(address(0), pulp, fee, tickSpacing, hooks));
    }

    /// @dev Only the pool's slot0 is modelled (sqrtPriceX96 in the low 160 bits); every other slot reads 0.
    function extsload(bytes32 slot) external view returns (bytes32) {
        if (slot == keccak256(abi.encodePacked(poolId(), bytes32(uint256(6))))) return bytes32(uint256(sqrtPriceX96));
        return bytes32(0);
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
        reenterAttempted = false;
        reenterSucceeded = false;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (_unlocked) revert AlreadyUnlocked();
        _unlocked = true;
        _locker = msg.sender;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        if (_delta0 != 0 || _delta1 != 0) revert CurrencyNotSettled();
        _unlocked = false;
        _locker = address(0);
        syncedCurrency = address(0);
        syncedReserves = 0;
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external returns (int256) {
        if (!_unlocked || msg.sender != _locker) revert ManagerLocked();
        if (
            key.currency0 != address(0) || key.currency1 != pulp || key.fee != fee ||
            key.tickSpacing != tickSpacing || key.hooks != hooks
        ) revert BadKey();
        if (!params.zeroForOne || params.amountSpecified >= 0) revert BadSwap();
        uint256 amountIn = uint256(-params.amountSpecified);
        uint160 limit = params.sqrtPriceLimitX96;
        if (limit >= sqrtPriceX96) revert PriceLimitAlreadyExceeded(sqrtPriceX96, limit);
        if (limit <= 4295128739) revert PriceLimitOutOfBounds(limit);
        uint256 consumed = partialFill ? amountIn / 2 : amountIn;
        if (sqrtDropPerWei != 0) {
            uint256 room = (sqrtPriceX96 - limit) / sqrtDropPerWei; // wei that can be sold before the limit
            if (consumed > room) {
                consumed = room;
                sqrtPriceX96 = limit; // like v4: a swap stopped by its limit ends exactly at it
            } else {
                sqrtPriceX96 -= uint160(consumed * sqrtDropPerWei);
            }
        }
        uint256 gross = consumed * pulpPerEth / 1e18;
        uint256 net = gross - gross * taxBps / 10_000;
        _delta0 -= int256(consumed);
        _delta1 += int256(net);

        if (reenterTarget != address(0)) {
            reenterAttempted = true;
            (bool ok,) = reenterTarget.call(reenterData);
            reenterSucceeded = ok;
            if (!ok && reenterMustSucceed) revert HookCallFailed();
        }
        return (int256(-int128(int256(consumed))) << 128) | int256(uint256(uint128(net)));
    }

    /// @dev Anyone, any time (as in v4-core). Used with setReenter(pm, sync(PULP)) to play a hook, or a party
    ///      the hook forwards ETH to, that leaves a dangling sync inside the zap's unlock window.
    function sync(address currency) external {
        if (currency == address(0)) {
            syncedCurrency = address(0);
            syncedReserves = 0;
        } else {
            syncedCurrency = currency;
            syncedReserves = IERC20(currency).balanceOf(address(this));
        }
    }

    function settle() external payable returns (uint256 paid) {
        if (!_unlocked) revert ManagerLocked();
        address currency = syncedCurrency;
        if (currency == address(0)) {
            paid = msg.value;
            _delta0 += int256(paid);
        } else {
            if (msg.value > 0) revert NonzeroNativeValue();
            paid = IERC20(currency).balanceOf(address(this)) - syncedReserves;
            if (currency == pulp) _delta1 += int256(paid);
        }
        syncedCurrency = address(0);
        syncedReserves = 0;
    }

    function take(address currency, address to, uint256 amount) external {
        if (!_unlocked) revert ManagerLocked();
        if (currency != pulp) revert BadSwap();
        _delta1 -= int256(amount);
        IERC20(pulp).transfer(to, amount);
    }

    /// @dev Used to prove the zap refuses ETH from anyone but WETH.
    function sendEth(address to, uint256 amount) external {
        (bool ok, bytes memory ret) = to.call{value: amount}("");
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }

    receive() external payable {}
}

/// @dev Proves the mock models v4's dangling-sync failure: unlock, sync(PULP), then settle{value}() reverts
///      NonzeroNativeValue. This is what PulpZap did before it re-synced native ETH before settling.
contract NaiveSettler is IUnlockCallback {
    MockPoolManager public immutable pm;

    constructor(MockPoolManager pm_) {
        pm = pm_;
    }

    function run() external payable {
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        pm.sync(pm.pulp());
        pm.settle{value: address(this).balance}(); // run() forwarded its msg.value here
        return "";
    }

    receive() external payable {}
}

/// @dev Plays an expensive hook: burn(n) does n SSTOREs to fresh slots (~22k gas each). Called from the mock
///      pool's swap with setReenterMustSucceed(true), it puts most of a zap's gas four calls below the OrRefund
///      hop (hop -> unlock -> unlockCallback -> swap -> burn), where an out-of-gas leaves ~6% of the hop unused.
contract GasHog {
    mapping(uint256 => uint256) public s;
    uint256 public next;

    function burn(uint256 n) external {
        uint256 start = next;
        for (uint256 i = start; i < start + n; ++i) s[i] = i + 1;
        next = start + n;
    }
}

/// @dev Beneficiary contract that cannot receive ETH (refund must fall back to WETH).
contract EthRejecter {
    receive() external payable {
        revert("no eth");
    }
}

/// @dev Fee recipient that burns all gas it is given on receiving ETH (fee must fall back to WETH).
contract GasBurner {
    uint256 public n;

    receive() external payable {
        while (true) {
            n++;
        }
    }
}

/// @dev Beneficiary / caller that tries to re-enter the zap when it receives ETH.
contract ReentrantReceiver {
    address public target;
    bytes public data;
    uint256 public attempts;
    uint256 public successes;

    function configure(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    receive() external payable {
        if (target == address(0)) return;
        attempts++;
        (bool ok,) = target.call(data);
        if (ok) successes++;
    }
}

/// @dev Plays a bridge executor (Across MulticallHandler / Relay multicaller): receives funds, then calls the zap
///      in the same transaction with an arbitrary payload, forwarding its whole ETH balance as value.
contract MockBridgeExecutor {
    function execute(address target, bytes calldata data) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call{value: address(this).balance}(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }

    function executeWithToken(address token, address target, bytes calldata data) external returns (bytes memory) {
        IERC20(token).approve(target, type(uint256).max);
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        IERC20(token).approve(target, 0);
        return ret;
    }

    receive() external payable {}
}

/// @dev WETH9-faithful enough for the zap: deposit/withdraw, and withdraw pays with a 2300-gas transfer.
contract MockWETH9 {
    string public constant name = "Wrapped Ether";
    string public constant symbol = "WETH";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    receive() external payable { deposit(); }

    /// @dev Robinhood WETH's implementation has this too: unwrap to any address. msg.sender at the recipient
    ///      is WETH, so it passes PulpZap's receive() check; that is how strays can reach the zap.
    function withdrawTo(address to, uint256 wad) external {
        require(balanceOf[msg.sender] >= wad);
        balanceOf[msg.sender] -= wad;
        payable(to).transfer(wad);
        emit Transfer(msg.sender, address(0), wad);
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad);
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
        emit Transfer(msg.sender, address(0), wad);
    }

    function totalSupply() external view returns (uint256) { return address(this).balance; }

    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad);
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad);
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}
