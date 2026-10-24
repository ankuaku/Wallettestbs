# Contracts

| File | What it is |
|---|---|
| `TokenBilling.sol` | The billing contract (version 2) for EVM networks. **One approval activates billing**: the customer approves the token for this contract and nothing else is needed. The approved amount is the most that can ever be collected. Customers can add their own per-charge / 30-day limits with `setLimits`, `cancel` at any time, and `enroll` again after cancelling. The keeper calls `charge`; the owner can `setKeeper`, `setTreasury`, `setPaused`, `transferOwnership`. Money can only ever move from a customer to the treasury. |
| `MockUSDT.sol` | A test token with a `faucet()` for local or testnet development. Not used on mainnet. |

You don't need any Solidity tools: the compiled bytecode is in `admin/src/billing-build.json` (EVM) and `admin/src/billing-build-tron.json` (TRON) and the admin **Deploy contract** page deploys it from your own wallet (see the main README, section 7).

## Verify on the explorer (recommended)

BscScan → your contract → **Contract** → **Verify and Publish**:
- Compiler type: Solidity (Single file), version **v0.8.26**, license MIT
- Optimization: **Yes**, runs **200**, EVM version **paris**
- Code: the full contents of `TokenBilling.sol`
- Constructor arguments: detected automatically


## Functions

| Function | Who | Does |
|---|---|---|
| `approve(contract, amount)` on the token | Customer | **This is the setup.** With an approval above 0 (and not cancelled) billing is active. The approval is the cap. |
| `setLimits(maxPerCharge, maxPerPeriod)` | Customer | Optional own limits (both > 0, per-charge ≤ per-30-days). `2^127−1` for both = back to "approval only". |
| `cancel()` | Customer | Stops all charges, even while an approval is still in place. |
| `enroll(maxPerCharge, maxPerPeriod)` | Customer | Turns billing on again after `cancel()` (with limits, or `2^127−1` for none). |
| `charge(user, amount, invoiceId)` | Keeper | Needs: not paused, invoice not used before, user not cancelled, within the user's own limits if set; then `transferFrom(user, treasury, amount)`, which also enforces the approval and balance. |
| `accounts(user)` | Anyone | `active` (approved > 0 and not cancelled), limits (`2^127−1` = none), period start, spent in the last 30 days. Same shape as version 1. |
| `remainingInPeriod(user)`, `statusOf(user)`, `version()` | Anyone | What the own 30-day limit still allows; 0 = approval only, 1 = own limits, 2 = cancelled; `2`. |
| `setKeeper`, `setTreasury`, `setPaused`, `transferOwnership` | Owner | Admin controls. |

Events: `Enrolled`, `LimitsChanged`, `Cancelled`, `Charged`, `KeeperChanged`, `TreasuryChanged`, `PausedSet`, `OwnershipTransferred`. Each invoice ID can be charged once, so a retry can never double-charge.

## Version 1 contracts

Contracts deployed with Wallet Billing 1.x (no `version()` function) keep working: the server detects them and the billing page uses the two-step flow (approve, then `enroll`). To give customers the one-step setup, deploy a new contract on the Deploy page, put its address in `.env`, and ask existing customers to approve the new contract once.

> Have the contracts reviewed by an experienced Solidity developer before large volumes.
> A deployed contract cannot be changed.


