// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _mockDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _mockDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _mockDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockWETH is MockERC20 {
    constructor() MockERC20("Wrapped Ether", "WETH", 18) {}

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    receive() external payable {
        deposit();
    }
}

contract MockBlockingERC20 is MockERC20 {
    mapping(address => bool) public blockedRecipients;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_)
    {}

    function setBlockedRecipient(address recipient, bool blocked) external {
        blockedRecipients[recipient] = blocked;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            require(!blockedRecipients[to], "MockBlockingERC20: blocked recipient");
        }
        super._update(from, to, amount);
    }
}

contract MockFeeToken is MockERC20 {
    uint16 public feeBps;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_)
    {}

    function setFeeBps(uint16 feeBps_) external {
        require(feeBps_ <= 10_000, "MockFeeToken: fee exceeds 100%");
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, amount);
            return;
        }

        uint256 fee = (amount / 10_000) * feeBps + ((amount % 10_000) * feeBps) / 10_000;
        super._update(from, to, amount - fee);
        if (fee != 0) super._update(from, address(0), fee);
    }
}

contract MockFalseReturnToken is MockERC20 {
    bool public returnFalse;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_)
    {}

    function setReturnFalse(bool enabled) external {
        returnFalse = enabled;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (returnFalse) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (returnFalse) return false;
        return super.transferFrom(from, to, amount);
    }
}

contract MockReentrantToken is MockERC20 {
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackEnabled;
    uint256 public attemptedCallbacks;
    uint256 public succeededCallbacks;
    bool private _inCallback;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_)
    {}

    function configureCallback(address target, bytes calldata data, bool enabled) external {
        callbackTarget = target;
        callbackData = data;
        callbackEnabled = enabled;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool transferred = super.transfer(to, amount);
        _tryCallback();
        return transferred;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool transferred = super.transferFrom(from, to, amount);
        _tryCallback();
        return transferred;
    }

    function _tryCallback() private {
        if (!callbackEnabled || _inCallback || callbackTarget == address(0)) return;

        _inCallback = true;
        attemptedCallbacks++;
        (bool success,) = callbackTarget.call(callbackData);
        if (success) succeededCallbacks++;
        _inCallback = false;
    }
}

contract MockPausableERC20 is MockERC20 {
    bool public paused;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        MockERC20(name_, symbol_, decimals_)
    {}

    function setPaused(bool paused_) external {
        paused = paused_;
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(!paused, "MockPausableERC20: paused");
        super._update(from, to, amount);
    }
}

interface IAliasedToken {
    function balanceOf(address account) external view returns (uint256);
    function aliasTransfer(address from, address to, uint256 amount) external;
}

/// @dev A token reachable at two addresses (audit EF-1): `alias_` moves the same balances.
contract MockDualToken is MockERC20 {
    address public immutable alias_;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) MockERC20(name_, symbol_, decimals_) {
        alias_ = address(new MockTokenAlias(IAliasedToken(address(this))));
    }

    function aliasTransfer(address from, address to, uint256 amount) external {
        require(msg.sender == alias_, "MockDualToken: alias only");
        _transfer(from, to, amount);
    }
}

contract MockTokenAlias {
    IAliasedToken public immutable main;

    constructor(IAliasedToken main_) {
        main = main_;
    }

    function balanceOf(address account) external view returns (uint256) {
        return main.balanceOf(account);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        main.aliasTransfer(msg.sender, to, amount);
        return true;
    }
}

/// @dev Forces native ETH into `to` without calling it (selfdestruct in the creating transaction).
contract MockForceSend {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/// @dev A token whose `balanceOf` can be made to revert (a broken or self-destructed token).
contract MockBreakableERC20 is MockERC20 {
    bool public broken;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) MockERC20(name_, symbol_, decimals_) {}

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function balanceOf(address account) public view override returns (uint256) {
        require(!broken, "MockBreakableERC20: broken");
        return super.balanceOf(account);
    }
}

/// @dev A two-address token (like MockDualToken) whose `balanceOf` can fail or burn all the gas it is given,
///      and whose alias transfer can repair or break `balanceOf` mid-call (review I-3).
contract MockFlakyDualToken is MockERC20 {
    address public immutable alias_;
    bool public broken;
    bool public guzzle;
    uint8 public onAliasTransfer; // 0: nothing, 1: repair balanceOf, 2: break balanceOf

    constructor(string memory name_, string memory symbol_, uint8 decimals_) MockERC20(name_, symbol_, decimals_) {
        alias_ = address(new MockTokenAlias(IAliasedToken(address(this))));
    }

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function setGuzzle(bool guzzle_) external {
        guzzle = guzzle_;
    }

    function setOnAliasTransfer(uint8 mode) external {
        onAliasTransfer = mode;
    }

    function balanceOf(address account) public view override returns (uint256) {
        require(!broken, "MockFlakyDualToken: broken");
        if (guzzle) {
            uint256 x;
            while (gasleft() > 2_000) x = uint256(keccak256(abi.encode(x)));
            require(x == 0, "MockFlakyDualToken: out of gas"); // never returns normally
        }
        return super.balanceOf(account);
    }

    function aliasTransfer(address from, address to, uint256 amount) external {
        require(msg.sender == alias_, "MockFlakyDualToken: alias only");
        _transfer(from, to, amount);
        if (onAliasTransfer == 1) broken = false;
        else if (onAliasTransfer == 2) broken = true;
    }
}
