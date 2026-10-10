// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockERC20} from "./Mocks.sol";

/// @dev Internal review (L-1): a normal ERC20 until switched. `balanceOf` then misbehaves:
///      1 = burn all the gas it is given, 2 = "return bomb" (returns as much data as the gas it was given can
///      pay for, so a caller that copies all returndata pays for it again, quadratically), 3 = return only 31
///      bytes (too short to be a balance), 4 = a correct balance followed by 4 KB of junk.
contract MockHostileERC20 is MockERC20 {
    uint8 public mode;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) MockERC20(name_, symbol_, decimals_) {}

    function setMode(uint8 m) external {
        mode = m;
    }

    function balanceOf(address account) public view override returns (uint256) {
        uint8 m = mode;
        if (m == 1) {
            uint256 x;
            while (gasleft() > 2_000) x = uint256(keccak256(abi.encode(x)));
            require(x == 0, "MockHostileERC20: out of gas"); // never returns normally
        } else if (m == 2) {
            uint256 g = gasleft();
            if (g > 8_000) {
                // Largest w (32-byte words) whose memory expansion (3w + w^2/512) fits in the gas left.
                uint256 w = Math.sqrt(589_824 + 512 * (g - 8_000)) - 768;
                assembly {
                    return(0, mul(w, 32))
                }
            }
        } else if (m == 3) {
            uint256 b = super.balanceOf(account);
            assembly {
                mstore(0, b)
                return(0, 31)
            }
        } else if (m == 4) {
            uint256 b = super.balanceOf(account);
            assembly {
                let p := mload(0x40)
                mstore(p, b)
                for { let i := 32 } lt(i, 4128) { i := add(i, 32) } { mstore(add(p, i), not(0)) }
                return(p, 4128)
            }
        }
        return super.balanceOf(account);
    }
}

interface IVaultReserved {
    function reserved(address token) external view returns (uint256);
}

/// @dev Internal review (H-1): an owner-registered "reward token" that vetoes recoveries. Its `balanceOf` works
///      while `watched` has excess in the vault and reverts once that excess is gone, i.e. right after a recovery
///      transfer of `watched`, so `_checkReserves` reports a breach and the sweep reverts.
contract MockReserveVeto is MockERC20 {
    address public vault;
    address public watched;
    bool public armed;

    constructor() MockERC20("VETO", "VETO", 18) {}

    function arm(address vault_, address watched_, bool armed_) external {
        (vault, watched, armed) = (vault_, watched_, armed_);
    }

    function balanceOf(address account) public view override returns (uint256) {
        if (armed && MockERC20(watched).balanceOf(vault) <= IVaultReserved(vault).reserved(watched)) revert("veto");
        return super.balanceOf(account);
    }
}
