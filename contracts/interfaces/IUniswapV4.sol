// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Minimal local copies of the Uniswap v4-core types and PoolManager functions PulpZap uses.
///      Layouts match v4-core (PoolKey, IPoolManager.SwapParams, BalanceDelta as packed int256).
///      `Currency` is a plain address here; address(0) is native ETH, as in v4-core.

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    // Negative = exact input, positive = exact output (v4-core convention).
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);

    /// @return swapDelta Packed BalanceDelta: amount0 in the upper 128 bits, amount1 in the lower 128.
    ///         Caller's view: negative = caller owes the pool, positive = pool owes the caller.
    ///         Includes any hook deltas (beforeSwap/afterSwap return-delta hooks).
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);

    /// @dev Records the currency (and, for ERC-20s, its reserves) that the next settle() pays. address(0)
    ///      resets it to native ETH. Callable by anyone at any time, so a native settle must sync(address(0))
    ///      first (v4-periphery DeltaResolver does the same).
    function sync(address currency) external;

    /// @dev Pays the synced currency: msg.value for native ETH (reverts NonzeroNativeValue if an ERC-20 is
    ///      synced and msg.value > 0).
    function settle() external payable returns (uint256 paid);

    function take(address currency, address to, uint256 amount) external;

    /// @dev v4-core Extsload: read one storage slot of the PoolManager (used for a pool's slot0, see
    ///      StateLibrary: slot = keccak256(abi.encodePacked(poolId, bytes32(uint256(6))))).
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
