// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * TokenBilling v2: usage-based USDT/USDC debits, activated by ONE approval.
 *
 * How it works
 *  1. The customer approves this contract on the token contract (e.g. 100 USDT,
 *     or unlimited). That single confirmation is the whole setup: billing is
 *     active, and the approved amount is the most that can ever be collected.
 *  2. Optional: the customer sets their own limits with setLimits(maxPerCharge,
 *     maxPerPeriod) (per charge and per 30 days), and can change them any time.
 *  3. The service's keeper wallet calls charge(user, amount, invoiceId).
 *     The contract only allows it if:
 *       - the contract isn't paused and the customer hasn't cancelled,
 *       - the customer's own limits (if set) are respected,
 *       - the invoiceId was never used before (no double charging),
 *       - the token transfer succeeds (enough approval and balance).
 *     Money always goes to the treasury, never to the keeper.
 *  4. The customer can cancel() at any time, or simply revoke the approval in
 *     their wallet. After cancel(), enroll(...) turns billing on again.
 *
 * Roles
 *  - owner:    sets keeper/treasury, pauses. Keep it OFF the server (hardware wallet / Safe).
 *  - keeper:   the server's hot wallet. Can only call charge().
 *  - treasury: receives all payments.
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract TokenBilling {
    /// Contract version (version 1 needed a second "enroll" transaction).
    uint256 public constant version = 2;

    IERC20 public immutable token;
    address public owner;
    address public keeper;
    address public treasury;
    bool public paused;

    uint64 public constant PERIOD = 30 days;
    /// "No limit" value (also what accounts() reports when the customer set no limits).
    uint128 public constant NO_LIMIT = type(uint128).max >> 1;

    uint8 private constant APPROVAL_ONLY = 0;   // default: the approval is the only cap
    uint8 private constant OWN_LIMITS = 1;      // the customer set per-charge / 30-day limits
    uint8 private constant CANCELLED = 2;       // the customer cancelled; nothing can be charged

    struct Account {
        uint8 status;
        uint128 maxPerCharge;   // token base units (OWN_LIMITS only)
        uint128 maxPerPeriod;   // token base units per 30 days (OWN_LIMITS only)
        uint64 periodStart;
        uint128 spentInPeriod;
    }

    mapping(address => Account) private _accounts;
    mapping(bytes32 => bool) public invoiceUsed;

    event Enrolled(address indexed user, uint256 maxPerCharge, uint256 maxPerPeriod);
    event LimitsChanged(address indexed user, uint256 maxPerCharge, uint256 maxPerPeriod);
    event Cancelled(address indexed user);
    event Charged(address indexed user, uint256 amount, bytes32 indexed invoiceId);
    event KeeperChanged(address keeper);
    event TreasuryChanged(address treasury);
    event PausedSet(bool paused);
    event OwnershipTransferred(address from, address to);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _token, address _treasury, address _keeper) {
        require(_token != address(0) && _treasury != address(0) && _keeper != address(0), "zero address");
        token = IERC20(_token);
        owner = msg.sender;
        treasury = _treasury;
        keeper = _keeper;
        emit OwnershipTransferred(address(0), msg.sender);
        emit TreasuryChanged(_treasury);
        emit KeeperChanged(_keeper);
    }

    // ------------------------------------------------------------ user side

    /// Turn billing on again after cancel(), optionally with limits (NO_LIMIT, NO_LIMIT = approval only).
    function enroll(uint128 maxPerCharge, uint128 maxPerPeriod) external {
        _setLimits(_accounts[msg.sender], maxPerCharge, maxPerPeriod);
        emit Enrolled(msg.sender, maxPerCharge, maxPerPeriod);
    }

    /// Set or change your own limits (NO_LIMIT, NO_LIMIT = approval only).
    function setLimits(uint128 maxPerCharge, uint128 maxPerPeriod) external {
        Account storage a = _accounts[msg.sender];
        require(a.status != CANCELLED, "billing cancelled: use enroll to turn it on again");
        _setLimits(a, maxPerCharge, maxPerPeriod);
        emit LimitsChanged(msg.sender, maxPerCharge, maxPerPeriod);
    }

    function cancel() external {
        Account storage a = _accounts[msg.sender];
        require(a.status != CANCELLED, "already cancelled");
        a.status = CANCELLED;
        emit Cancelled(msg.sender);
    }

    // ------------------------------------------------------------ keeper side

    function charge(address user, uint256 amount, bytes32 invoiceId) external {
        require(msg.sender == keeper, "not keeper");
        require(!paused, "paused");
        require(!invoiceUsed[invoiceId], "invoice already charged");
        Account storage a = _accounts[user];
        require(a.status != CANCELLED, "user cancelled billing");
        require(amount > 0, "zero amount");

        if (block.timestamp >= uint256(a.periodStart) + PERIOD) {
            a.periodStart = uint64(block.timestamp);
            a.spentInPeriod = 0;
        }
        if (a.status == OWN_LIMITS) {
            require(amount <= a.maxPerCharge, "over per-charge limit");
            require(uint256(a.spentInPeriod) + amount <= a.maxPerPeriod, "over 30-day limit");
        }

        // effects before the external call
        uint256 spent = uint256(a.spentInPeriod) + amount;
        a.spentInPeriod = spent > type(uint128).max ? type(uint128).max : uint128(spent);
        invoiceUsed[invoiceId] = true;

        _safeTransferFrom(user, treasury, amount);
        emit Charged(user, amount, invoiceId);
    }

    // ------------------------------------------------------------ views

    /// Same shape as version 1. `active` = approved something and not cancelled.
    function accounts(address user) external view returns (
        bool active, uint128 maxPerCharge, uint128 maxPerPeriod, uint64 periodStart, uint128 spentInPeriod
    ) {
        Account storage a = _accounts[user];
        active = a.status != CANCELLED && token.allowance(user, address(this)) > 0;
        bool own = a.status == OWN_LIMITS;
        maxPerCharge = own ? a.maxPerCharge : NO_LIMIT;
        maxPerPeriod = own ? a.maxPerPeriod : NO_LIMIT;
        periodStart = a.periodStart;
        spentInPeriod = block.timestamp >= uint256(a.periodStart) + PERIOD ? 0 : a.spentInPeriod;
    }

    /// How much more can be charged in the current 30-day window (before approval and balance).
    function remainingInPeriod(address user) external view returns (uint256) {
        Account storage a = _accounts[user];
        if (a.status == CANCELLED) return 0;
        if (a.status != OWN_LIMITS) return NO_LIMIT;
        if (block.timestamp >= uint256(a.periodStart) + PERIOD) return a.maxPerPeriod;
        return a.maxPerPeriod - a.spentInPeriod;
    }

    /// 0 = approval only (no own limits), 1 = own limits, 2 = cancelled.
    function statusOf(address user) external view returns (uint8) { return _accounts[user].status; }

    // ------------------------------------------------------------ owner

    function setKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "zero address");
        keeper = _keeper;
        emit KeeperChanged(_keeper);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "zero address");
        treasury = _treasury;
        emit TreasuryChanged(_treasury);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero address");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    // ------------------------------------------------------------ internal

    function _setLimits(Account storage a, uint128 maxPerCharge, uint128 maxPerPeriod) private {
        require(maxPerCharge > 0 && maxPerPeriod > 0, "limits must be > 0");
        require(maxPerCharge <= maxPerPeriod, "per-charge limit above 30-day limit");
        if (maxPerCharge >= NO_LIMIT && maxPerPeriod >= NO_LIMIT) {
            a.status = APPROVAL_ONLY;
            a.maxPerCharge = 0;
            a.maxPerPeriod = 0;
        } else {
            a.status = OWN_LIMITS;
            a.maxPerCharge = maxPerCharge;
            a.maxPerPeriod = maxPerPeriod;
        }
        if (a.periodStart == 0 || block.timestamp >= uint256(a.periodStart) + PERIOD) {
            a.periodStart = uint64(block.timestamp);
            a.spentInPeriod = 0;
        }
    }

    /// Works with tokens that return bool and with ones that return nothing.
    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "token transfer failed (balance or approval too low)");
    }
}
