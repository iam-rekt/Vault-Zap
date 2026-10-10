// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev The subset of PulpVeVault that PulpZap calls.
interface IPulpVeVault {
    function pulp() external view returns (address);
    function minLockAmount() external view returns (uint256);
    function launchStart() external view returns (uint256);
    function locksPaused() external view returns (bool);
    function emergencyExit() external view returns (bool);
    function MIN_LOCK_TIME() external view returns (uint256);
    function locks(address user) external view returns (uint256 amount, uint256 boosted, uint256 end);
    function lockFor(address beneficiary, uint256 amount, uint256 daysLocked) external;
    function increaseAmountFor(address beneficiary, uint256 amount) external;
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
