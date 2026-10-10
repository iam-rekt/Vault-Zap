# PulpVeVault: technical design

Design notes for `contracts/PulpVeVault.sol`: the reward model, daily settlement, delegated deposits and
compounding, the emergency exit, the withdrawal guarantee, roles and limits. The plain-language overview is in the
[README](../README.md); the zap that buys and locks in one transaction is in [ZAP.md](ZAP.md).

Finding IDs (M-A, EF-1, AC-2, L-1, I-1, ...) refer to the internal reviews and the 2026-10-10 audit, and
A1-n / A2-n to the two external audits; all are summarised in [SECURITY.md](SECURITY.md).

**Status: not deployed.** Two external audits reviewed the previous vault source; the fixes made after them
(treasury handover, claim deadline, typo protection) have not been externally reviewed yet.

## The model

Users lock a plain ERC20 for **exactly 10, 20, or 30 days**. The timestamp is not rounded to a week or day. There is no early withdrawal or transfer of the position, except after the owner's one-way **emergency exit** (below), which lets every lock out at once.

```text
power = sum(amount_i × savedEntryMultiplier_i) × remainingTime / 30 days
```

- At launch, the entry multiplier is 2×. It starts falling immediately, linearly, to 1× over `earlyWindow`. There is no first-hour plateau, and normal earning does not disappear when the launch promotion ends.
- The example configuration uses **24 hours** for `earlyWindow`. This is an explicit configurable deployment parameter, not a finalized launch commitment.
- Power decays with the remaining lock time. A 30-day lock starts with three times the power of a 10-day lock with the same principal and entry multiplier.
- `extend(30)` means **30 days remaining from now**, not another 30 days added to the old end. Extensions must move the unlock timestamp later.
- An extension **before expiry** preserves the saved entry multiplier on existing principal. Restarting at or after expiry reprices it at today's multiplier.
- The launch window limits **when the bonus can be obtained**, not how long it can be retained: keeping the same capital actively locked through extensions can preserve its bonus indefinitely.
- Top-ups get their own current entry multiplier. A small early deposit cannot pass its bonus to a large later deposit.
- New capital must commit for at least 10 days: top-ups require at least 10 days remaining, otherwise extend first.
- At expiry power is zero. Principal can be withdrawn without claiming first, and old rewards remain claimable after withdrawal or a later re-entry.
- This is reward weight, **not an ERC20 voting token or a governance system**. No rewards, price, demand, APY, or treasury redemption value are guaranteed.

Example: 1,000 PULP at the 2× launch multiplier for 30 days starts at 2,000 power. Ten days later it has about 1,333 power. Extending to 30 days remaining restores 2,000 power.

## Important accounting choice: daily settlement

This implementation uses **daily power-time accounting**. Live power decays continuously, but rewards become final and claimable after each UTC day closes. This is **not** continuously claimable per-second streaming.

For each day:

```text
user reward = floor(day's funded rewards × user's power-seconds / everyone's power-seconds)
```

Power-seconds are the area under the user's actual power curve during that day. Joining late earns only the part of the day actually locked. Extending or topping up changes the curve from that transaction forward; it does not rewrite the earlier part of the day or any closed day.

The **open day's final share is not fixed**: other deposits and extensions during that same day affect the denominator. `claimable()` therefore exposes closed-day amounts only. Daily integral-of-power shares are not mathematically identical to integrating instantaneous relative shares every second. This settlement choice avoids logarithmic approximation in the payout engine and should be confirmed before deployment.

Internally, the contract stores twice the unnormalized power area:

```text
area2 = boosted × ((end - from)^2 - (end - to)^2)
boosted = sum(amount_i × entryMultiplier_i_in_1e18_units)
```

The common `2 × 1e18 × 30 days` normalization cancels in the reward fraction. Area bookkeeping is exact integer arithmetic. Only the final daily payout rounds down using OpenZeppelin `Math.mulDiv`. Rounding dust remains protected in the vault. Fractional base units do not carry across days: if a day's budget is only one token base unit and two lockers have equal area, both receive zero and that unit stays in the vault. For very small budgets or low-decimal reward tokens, the entire budget can be rounding dust. Fund meaningful amounts; WETH has 18 decimals.

Public `userEpochArea` / `totalEpochArea` include the currently scheduled future curve for open/future days; those days may still change. Closed-day areas are final. They are **not** a current total voting-power measurement.

## Fee flow and funding

```text
v4 hook → fee-collector EOA → vault → WETH rewards for PULP lockers
```

No hook modification is required. The hook/pool is not called by this contract.

- An authorized distributor calls `notifyRewardETH()` with native currency. An ordinary native transfer from that distributor also works if enough gas is provided. Funds are wrapped into the configured WETH/wrapped-native contract; users claim that ERC20, not native ETH.
- For ERC20 rewards, approve the vault and call `notifyRewardAmount(token, amount)`. **Do not send ERC20 tokens directly:** those transfers are not notified rewards; the owner can only send them on to the treasury (`recoverExcess`).
- Every funding logs `RewardNotified(token, funder, amount)` (the distributor that paid) before `RewardsScheduled`.
- **Cadence and gas.** Each top-up covers seven days and adds to what is scheduled, so funding once a week keeps every day paid; more often only smooths it. `notifyRewardETH` costs about 100k gas when its seven days are already funded and up to about 275k when it is the first to reach them (fresh storage). Send it with the normal estimate; a hard-coded gas cap below that makes it revert (nothing is lost, it can be repeated).
- Every funding adds to **seven full future UTC days**, starting at the next midnight or the first full day at/after launch, whichever is later. The first post-launch-funded daily reward becomes claimable after that first day ends, normally 24–48 hours after funding.
- Funding top-ups are additive. They do not reset or delay existing reward budgets. The integer remainder goes to the seventh day, so all notified units are scheduled.
- A closed day with **zero power-seconds from everyone** can be recycled into seven future days with permissionless `recycleEmptyRewards(token, epoch)`. Recycling cannot touch any day with earned power, unclaimed entitlements, or rounding dust. Empty days do not roll forward automatically.
- After the emergency exit, funding and recycling revert (`EmergencyExitActive`); days that can no longer be paid are released instead (`releaseEmptyRewards`, `releasePostExitRewards`, see Emergency exit).
- Fees still held by the EOA are not vault rewards. Funding does not retroactively reward old days. This is not a historical PaperDAO campaign-credit system.

## Main calls

| Call | Meaning |
|---|---|
| `lock(amount, 10/20/30)` | Open one position per address; approve PULP first |
| `increaseAmount(amount)` | Add new capital at today's multiplier, keeping expiry |
| `lockFor(beneficiary, amount, 10/20/30)` | Open `beneficiary`'s lock with the caller's PULP |
| `increaseAmountFor(beneficiary, amount)` | Top up `beneficiary`'s lock with the caller's PULP |
| `compound(maxEpochs, maxFeeBps)` | Re-lock one page of your own PULP rewards into your lock, minus the compound fee; reverts `FeeAboveMax` if the fee is above `maxFeeBps` |
| `extend(10/20/30)` | Reset remaining time, but only if expiry moves later |
| `withdraw()` | Return all principal after expiry (or at any time once the emergency exit is on); leave reward history intact |
| `powerOf(user)` | Current decaying reward power in PULP base units |
| `claimable(user, token, maxEpochs)` | Final amount for the next page (closed days; after the exit also the exit day up to the switch), next cursor, whether caught up |
| `claim(token, maxEpochs)` | Claim a bounded page for one token (active, or retired until its claim deadline) |
| `claimTo(token, maxEpochs, to)` | Claim the caller's own page and send it to `to` (not zero, the vault, PULP, WETH or any reward token); logs `RewardSentTo` |
| `claimAll(maxEpochs)` / `claimAllTo(maxEpochs, to)` | Claim a page for each active reward token (retired ones are skipped) |
| `userEpochCount/At(user, ...)` | Enumerate a user's recorded reward days |
| `notifyRewardETH()` | Wrap and schedule native funding |
| `notifyRewardAmount(token, amount)` | Pull and schedule approved ERC20 funding |
| `recycleEmptyRewards(token, epoch)` | Reschedule a closed zero-power day's budget |
| `releaseEmptyRewards(token, epoch)` | After the emergency exit: take one unpayable day's budget off the books (any day after `exitEpoch`, or an earlier zero-power day) |
| `releasePostExitRewards(token)` | After the emergency exit: release every funded day after `exitEpoch` for `token` in one call (scans 7 days) |
| `enableEmergencyExit()` | Owner, one-way: every lock may withdraw now; nothing new can come in; rewards stop at this second (today is paid up to it) |
| `emergencyExit()`, `exitTimestamp()`, `exitEpoch()` | The switch; the second it was turned on; its UTC day (`exitTimestamp / 86400`; both 0 while off), the last day that pays |
| `exitDayTotalArea()`, `exitDayArea(user)` | Area accrued on the exit day before the switch, in total and per user (the exit day's split) |
| `totalReleased(token)` | Budgets released after the switch |
| `treasury()`, `pendingTreasury()`, `treasuryProposedAt()`, `lastReleasedAt()`, `TREASURY_DELAY()`, `proposeTreasury(addr)`, `acceptTreasury()` | Where the compound fee and every recovery go; two-step change: the owner proposes, the new address accepts no sooner than `max(treasuryProposedAt, lastReleasedAt) + TREASURY_DELAY` (8 days) and only once every funded reward has been earned (`UnearnedRewardsScheduled(token, day)` otherwise); a new proposal restarts the clock, zero cancels, an ownership change cancels |
| `recoverERC20(token, amount)`, `recoverExcess(token)` | Owner or treasury: send an unrelated token, or the balance above `reserved` (`address(0)`: native ETH), to the treasury |
| `addRewardToken(token)`, `removeRewardToken(token)` | Owner: register (or reactivate) a reward token; stop paying one in `claimAll` once nothing is scheduled for it |
| `expireRewardToken(token)` | Anyone, `CLAIM_DEADLINE` (120 days) after a token was retired: what is still unclaimed leaves the books (sweepable to the treasury); the token can never be added again |
| `getRewardTokens()`, `getRetiredRewardTokens()`, `retiredAt(token)`, `isExpiredRewardToken(token)` | Active reward tokens (at most 5); removed tokens that are still owed (at most 10) and when each was retired; expired tokens |

Use `maxEpochs = 64` normally. Repeat claims if `caughtUp` is false. Each token has an independent cursor. If one reward token refuses a transfer, claim other tokens individually instead of using `claimAll`, or send that token's page elsewhere with `claimTo`; if it is broken for good, the owner can remove it from `claimAll` (below). There is no need for a global keeper/checkpoint to withdraw.

### Removing a reward token

`removeRewardToken(token)` (owner) takes an active token out of `getRewardTokens()`, so `claimAll`/`claimAllTo` skip it (audit AC-2/DOS-2: one broken token made `claimAll` revert for everyone) and a slot frees up. It is allowed only when no budget is left on any open or future day: before the exit, today and later; after it, every day after the exit day (release those first). It checks the eight days from that first day (or the launch day, if later), which hold every budget that can exist on them (funding reaches today + 7). So when a token is removed every entitlement is already final.

- If nothing is owed any more (`totalNotified == totalPaid + totalReleased`: every unit paid or released, no dust, nothing claimable), the token is dropped entirely: no books, recoverable like any stray token. Re-adding it later starts again from those totals; a stale cursor only walks days whose shares were all zero, because a positive unclaimed share would have made the totals differ.
- Otherwise it is **retired** (`isRetiredRewardToken`, `getRetiredRewardTokens()`, `retiredAt(token)`; at most ten, `MAX_RETIRED_REWARD_TOKENS`): `claim`/`claimTo`/`claimable` still pay every entitlement, `reserved` still counts it, `recoverERC20` still refuses it and `recoverExcess` stops at `reserved`, and releases after the exit still work. It can't be funded (`notifyRewardAmount`, or for WETH `notifyRewardETH` and plain ETH, revert `NotRewardToken`), recycled or compounded. `addRewardToken` reactivates it with its books (and clears `retiredAt`) while it is not expired.
- PULP as a reward token follows the same rule; `reserved(pulp)` always includes locked principal whatever its reward status.
- Event: `RewardTokenRemoved(token, retired)`.

### Claim deadline: expiring a retired token (external audits A1-1, A2-4)

A retired token used to stay retired forever: rounding dust (each day's payouts round down), rewards nobody claims
and budgets of closed days nobody had power on (which only an active token can recycle, and only the exit can
release) keep `totalNotified != totalPaid + totalReleased`. With five active and five retired slots both lists
could fill up for good: retiring needs a retired slot, reactivating an active one (A1-1), and the stuck zero-power
budgets of a retired token could never leave (A2-4).

- **Users must claim a retired token within `CLAIM_DEADLINE` = 120 days after it was retired**
  (`retiredAt(token) + CLAIM_DEADLINE`; the `RewardTokenRemoved(token, true)` event starts the clock). Before the exit
  a token can only be retired once all its funded days are over, so every entitlement is final for the whole 120
  days. After an emergency exit the owner can retire every token as soon as the days after the exit day are
  released, so the deadline can start right after the exit. An active token never expires.
- From then on anyone may call `expireRewardToken(token)` (permissionless: it only applies a published deadline,
  and frees a retired slot). Everything still owed, `notified − paid − released` (unclaimed rewards, dust, zero-power
  budgets), is added to `totalReleased`, so it leaves `reserved` and `recoverExcess` sweeps it to the treasury.
  `RewardTokenExpired(token, forfeited)` is logged and `lastReleasedAt` moves (see the treasury below).
- The token leaves the retired list and has no books: `claim`, `claimTo` and `claimable` revert `NotRewardToken`,
  `recoverERC20` no longer refuses it, and it is not in the recovery reserve check.
- **An expired token can never be added again** (`ExpiredRewardToken`). Its old `epochRewards` and users' cursors
  stay in storage (clearing them would be unbounded) but nothing can read them as an entitlement any more, so no
  old day can pay twice and the counters stay consistent (`totalNotified == totalPaid + totalReleased` from the
  expiry on). Expiring WETH ends native funding for good, and expiring PULP ends `compound` for good: retire them
  only when that is meant, or reactivate them within the 120 days.
- A dropped token (nothing owed at removal) is not expired and can be re-added, as before.
- Bounds: at most 5 active and 10 retired tokens. The loops over them: `_protectedBalances`/`_checkReserves`
  (1 + 15 capped balance reads, twice), `_scaleExitDay` (15 reads at the switch), `acceptTreasury` (15 × 8 budget
  reads), `_removeFrom` (≤ 10). Measured with every slot full: `recoverExcess` ~392k gas, `acceptTreasury` ~374k;
  worst case with hostile tokens that eat their whole 100k read cap: about 3.3M for a recovery; with 15 "return
  bomb" tokens (as much returndata as 100k gas can produce) about 3.1M (review 3 L-1: the reads copy at most 32
  bytes, see "Recovery checks"; before the fix that case cost up to ~69M).

## Delegated deposits and compounding

`lockFor` / `increaseAmountFor` let anyone pay PULP into someone else's position (gifts, zaps, payroll-style top-ups). `compound` lets a locker turn PULP rewards into principal without the tokens leaving the vault.

**One code path.** `lock`/`lockFor` share `_lock`, and `increaseAmount`/`increaseAmountFor`/`compound` share `_checkTopUpWindow` + `_addPrincipal`; the plain calls are the `For` calls with `beneficiary = msg.sender`. So every rule is identical: launch time, pause, `minLockAmount` (new locks), non-zero amount (top-ups), `MAX_TOTAL_LOCKED`, 10/20/30 durations, one lock per beneficiary (`LockExists`), 10+ days left for new capital (`ExtendFirst`), today's entry multiplier for new capital, and exact integer areas. PULP is **always pulled from `msg.sender`** through `_pullExact`, never from the beneficiary, so no one can spend another address's allowance; fee-on-transfer and false-returning transfers revert exactly as for `lock`. The position belongs wholly to the beneficiary: only it can `extend` or `withdraw`, and the payer keeps no claim. The `For` calls reject `address(0)` (`ZeroAddress`) and the vault itself (`InvalidBeneficiary`), because the vault can never call `withdraw`. Any other contract that cannot call the vault would strand the principal too; that is the payer's responsibility.

**Events.** `Locked` and `Increased` keep their signatures and meaning (`user` is the lock owner), so existing indexers and frontends see `For` deposits as ordinary deposits by the beneficiary. The `For` calls additionally emit `DepositedFor(payer, beneficiary, amount)`, even when the payer is the beneficiary, so the funding source is visible without changing the old topics. Adding a payer field to `Locked`/`Increased` would have changed their topic hashes and silently broken existing listeners.

**Compound accounting.** `compound(maxEpochs, maxFeeBps)` (PULP must be a registered reward token, else `NotRewardToken`):

1. Checks the pause, `maxEpochs` (1–64), the caller's `maxFeeBps` (`FeeAboveMax` if `compoundFeeBps` is above it), and the caller's lock exactly like a top-up: `NoLock`, `LockExpired`, then `ExtendFirst` below 10 days left.
2. Settles one claim page for PULP through the same `_settle` used by `claim`: the cursor moves, `totalPaid[pulp] += page`, and `RewardPaid(user, pulp, page, nextCursor)` is emitted. No token moves here.
3. Takes the fee off the page (see Compound fee below; `amount` is the rest). Reverts `NothingToCompound` if that is zero, and `LockCapExceeded` if principal would pass the cap. Either revert also undoes step 2.
4. Adds `amount` as principal at today's multiplier through `_addPrincipal` (`totalLocked += amount`, area scheduled from now to the unchanged expiry, `Increased` emitted), then emits `Compounded(user, amount, fee, nextCursor)`.
5. Transfers `fee` PULP to the `treasury`, if non-zero. This is the only external call, made last.

With no fee, `totalLocked` and `totalPaid` rise by the same amount, so `reserved(pulp) = totalLocked + totalNotified[pulp] − totalPaid[pulp]` and the vault's PULP balance are both unchanged. Closed-day areas are never touched; compounded principal only earns from the moment it is added. Amounts are the same floor-rounded closed-day entitlements `claim` would pay, so compounding adds no rounding and leaves dust reserved. `RewardPaid` still sums to `totalPaid`; an indexer that treats it as a transfer should skip it when the same transaction has `Compounded`, and count `Compounded.fee` as the only PULP that left.

### Compound fee

`compound` (only; `claim` and `claimAll` stay fee-free) charges `fee = floor(page × compoundFeeBps / 10,000)` on the settled page, paid in PULP to the `treasury`. `MAX_COMPOUND_FEE_BPS = 200` (2%) is a constant: the owner can move the rate anywhere from 0 to 2% with `setCompoundFee(uint16)` (event `CompoundFeeSet`), never past the cap. The initial rate comes from `Config.compoundFeeBps`. There is no separate fee recipient any more (audit M-A, AC-5): the fee goes to the treasury, which changes only two-step (see Roles).

It is a **convenience fee** (audit MS-2): `claim(pulp, n)` followed by `increaseAmount` reaches the same position with no fee, in two transactions (and the same 10-days-left rule). The UI should say so.

- **Accounting.** `totalPaid[pulp] += page` (the whole page leaves the reward books), `totalLocked += page − fee`, and `fee` is transferred out. `reserved(pulp)` and the PULP balance both fall by exactly `fee`, so the balance still covers `reserved` by the same margin (normally zero). The user's lock, power and area grow by `page − fee` only; `compound` returns `page − fee`.
- **Rounding.** The fee rounds down, in the user's favour; a page under `10,000 / bps` base units pays no fee and makes no transfer. Because the cap is below 100%, `page − fee` is zero only when the page is, which still reverts `NothingToCompound`.
- **Validation.** Rate above the cap: `FeeTooHigh` (constructor and setter). The treasury is always set (the constructor requires it), so any rate has a recipient. The treasury can't be the vault (the fee would stay in the balance but leave `reserved`, so the sweep could take it), PULP or a reward token (`InvalidTreasury`).
- **Untrusted recipient.** All state is written and `Compounded` emitted before the transfer, under `nonReentrant`. PULP is a plain ERC20 with no recipient hook, but even a token callback cannot re-enter (tested). If the token refuses the transfer (for example a blacklisted treasury), the whole `compound` reverts: cursor, `totalPaid` and the lock are untouched, the rewards stay claimable fee-free, and the owner can move the treasury (two-step, 8 days after proposing).
- **Event.** `Compounded` gained a `fee` field (`amount` is now the re-locked part; `amount + fee` is the `RewardPaid` page). Its signature changed rather than adding a separate event because the contract has never been deployed, so no listener depends on the old topic, and one event per compound keeps the split readable without joining logs. `Locked`/`Increased`/`RewardPaid` are unchanged.
- **Maximum fee (review L-5).** The owner can change the rate at any time, at most to 2%. So `compound` takes the caller's `maxFeeBps` (`uint16`, the same type as `compoundFeeBps`) and reverts `FeeAboveMax` if `compoundFeeBps > maxFeeBps`, before anything is settled. A rate raised between a user's quote and their transaction, for example by front-running, is never charged: the call reverts and the rewards stay claimable. Frontends pass the rate they showed the user; passing 200 accepts any rate up to the cap. Selector: `compound(uint256,uint16)` = `0xab443219`.

**Paging.** One call settles one page. A page that pays zero (for example days before PULP was first funded) reverts, and `claim(pulp, n)` pages past it, paying zero. Repeat `compound` while `claimable(user, pulp, n)` is non-zero. Below 10 days left, extend first or claim the tokens; after expiry, `extend` restarts the lock and compounding works again. Rewards are never lost by a failed compound.

**Pause.** `lockFor`, `increaseAmountFor` and `compound` add principal, so they stop while locks are paused. `claim` stays open, so paused PULP rewards can still be taken as tokens. **The pause does not cover `extend`** (intentional): extending adds no principal, and blocking it would only force lockers to restart at a lower multiplier after expiry; extending is blocked only by the emergency exit.

**Beneficiary typo protection (external audits A2-3, A2-6).** `lockFor`, `increaseAmountFor`, `claimTo` and `claimAllTo` refuse zero (`ZeroAddress`) and, with `InvalidBeneficiary`, the vault, PULP, WETH and every token with reward books (active or retired) or expired: these are token contracts that can never withdraw a lock or move what they receive, so such an address is always a pasted token address instead of a wallet. `addRewardToken` refuses the vault itself (`InvalidRewardToken`), the treasury and a pending treasury (`InvalidTreasury`) and an expired token. Other protocol contracts (the zap, the PoolManager, the hook) are not known to the vault; the zap refuses them as beneficiaries itself.

**`RewardPaid` may log 0.** Every settled page emits `RewardPaid(user, token, amount, nextCursor)`, including pages that pay nothing (days before a token was funded, zero shares): the cursor still moves. Indexers should not treat it as a transfer.

**Reentrancy.** All three are `nonReentrant`. `lockFor`/`increaseAmountFor` write state only after the exact-balance pull, as `lock` did; `compound`'s only external call is the fee transfer, made after every state change.

### Griefing through `lockFor`

*Attack.* Before an address's first lock (or right after it withdraws, or by front-running its `lock` transaction), someone calls `lockFor(victim, minLockAmount, 30)`. The victim's own `lock` then reverts `LockExists`.

*Cost to the attacker.* At least `minLockAmount` (deploy default: 35,000 PULP, about $33 at the 2026-10-09 price; review L-6 found the earlier 1,000 PULP example was about $1) plus gas, **given away irrevocably to the victim**. The victim earns rewards on it and withdraws it at expiry. Doing it again after each withdrawal costs the same again. The attacker gets nothing.

*Harm to the victim.* (1) One reverted transaction. (2) The victim cannot pick an expiry earlier than the attacker's: `increaseAmount` keeps the existing expiry, and `extend` can only move it later. Wanting 10 days but receiving a gifted 30-day lock, the victim either deposits for the remaining time (up to 30 days), waits, or doesn't deposit. Their own principal gets today's multiplier either way, the same price `lock` would give, and the extra power is from the gift. (3) Nothing else: `lockFor`/`increaseAmountFor` cannot move an existing expiry, reprice existing principal, pull the victim's tokens, touch rewards or cursors, or block `extend`, `withdraw` or `claim`. A lock records at most 31 reward days, and a top-up records none (same expiry), so claim history cannot be bloated cheaply. `increaseAmountFor` can add as little as one base unit, but that only adds principal that comes back on `withdraw`.

*Options considered.* (a) Beneficiary opt-in (an approved-depositor mapping): removes the gift/zap use case for fresh addresses and costs every beneficiary a transaction. (b) Let `lock` merge into an existing lock: changes the meaning of an existing call and must pick between two conflicting expiries. (c) Restrict `lockFor` to 10 days: still triggers `LockExists`, and limits legitimate use.

*Decision.* Left permissionless. The harm is bounded to a forced *later* expiry on new capital, and it costs the attacker at least `minLockAmount` that goes to the victim. **UI requirement:** read `locks(user)` before offering "lock". If a lock exists, offer `increaseAmount` (with `extend` first when under 10 days are left, or after expiry) and show its expiry before the user signs. `test/vault/delegated.test.js` covers this path.

## Emergency exit

Owner requirement: *users must be able to withdraw their PULP no matter what.* Normally a lock is a binding commitment until `end`. `enableEmergencyExit()` (owner only) is a **one-way** switch, `bool public emergencyExit`, off at deploy. There is no function that turns it off; calling it again reverts `EmergencyExitActive`. It records `uint64 public exitTimestamp` (the switch second, `x`), `exitEpoch()` (a view: `exitTimestamp / 1 days`, the UTC day of the switch, `E`; both 0 while off, so off-chain readers check `emergencyExit()` first) and `uint256 public exitDayTotalArea` (`T`, below), and logs `EmergencyExitEnabled(exitEpoch, exitTimestamp, exitDayTotalArea)`. It moves no tokens and changes no lock, area, cursor or principal.

**In plain words:** rewards stop at the switch second. Every day that had already ended is paid as usual, by power. The exit day is paid as if it had ended at the switch: its budget times the part of the day that had passed, split by the power-time each lock built up before the switch. Nothing after the switch pays anyone; that money goes back to the treasury. Leaving keeps everything earned; staying earns nothing more; nobody, the owner included, can move a unit someone has earned to anyone else by staying, leaving, keeping a small lock or timing the switch (audit M-A, replacing the review N-1 rule "the exit day pays nobody", under which a switch at 23:59:59 cancelled a whole earned day).

**Once on:**

| | |
|---|---|
| `withdraw()` | Works for every lock, whatever its `end`: the full principal, at once. It touches no area (areas are frozen at the switch). A lock that ran past the switch leaves its `(boosted, end)` behind (one storage write) so its exit-day share stays computable. Before `end` it also logs `EarlyWithdrawn(user, amount, oldEnd)` after `Withdrawn`. About 74k gas. |
| `lock`, `lockFor`, `increaseAmount`, `increaseAmountFor`, `compound`, `extend` | Revert `EmergencyExitActive` (checked before the pause). |
| `notifyRewardAmount`, `notifyRewardETH`, plain ETH from a distributor | Revert `EmergencyExitActive` (after `NotDistributor`). Every budget is final. |
| `recycleEmptyRewards` | Reverts `EmergencyExitActive`. Use `releaseEmptyRewards` / `releasePostExitRewards`. |
| `claimable`, `claim`, `claimTo`, `claimAll(To)` | Pay every day up to and including `exitEpoch`, at once (the exit day does not wait for midnight). A page stops after `exitEpoch`; `caughtUp` is then true for good. |
| Owner calls | Unchanged; none can affect a withdrawal or an entitlement (see below). |

**Which days pay.**

- **Before `E`:** unchanged. Each day's budget split by full-day area, floor-rounded, claimable forever. These days closed before the switch: their areas and budgets were final.
- **`E`:** at the switch, for every reward token, `epochRewards[token][E]` becomes `P = floor(budget × (x − E·DAY) / DAY)` (0 if `T = 0`, i.e. nobody accrued anything before the switch) and the rest, `budget − P`, is released at once (`totalReleased`, `EmptyRewardsReleased(token, E, budget − P)`). A locker gets `floor(P × A_u / T)`, where `A_u` is the area it accrued in `[E·DAY, x)` (`exitDayArea(user)`) and `T = Σ A_u` (`exitDayTotalArea`). That is exactly what the day would have paid had it ended at `x`, to within one unit of rounding: `|payout − budget × elapsed/DAY × A_u/T| < 2`.
- **After `E`:** nobody is paid, whatever their area. Releasable.

### How `A_u` and `T` are known exactly

Area bookkeeping stores, per day, twice the integral of power over the whole day as scheduled: `totalEpochArea[E]` and `userEpochArea[u][E]` include the part of the exit day after the switch. So `T = totalEpochArea[E] − R` and `A_u = userEpochArea[u][E] − R_u`, where `R`, `R_u` are the parts scheduled after `x`.

- A live trajectory (boost `B`, end `e`, scheduled at or before `x`) has `B·((e − x)² − (e − min(e, dayEnd))²)` after `x` if `e > x`, else nothing. Each user has at most one live trajectory at the switch, its lock: `R_u` is that formula with `locks[u].boosted / end`, or, if the lock was withdrawn after the switch, with the `(boosted, end)` it left behind. Computed when claimed.
- `R` sums that over every lock at once. The formula is linear in `B` for a given `e`, so the vault keeps, for live trajectories, sums of `B` by **end**: per end second, per 10-minute bucket (`ΣB`, `ΣB·r`, `ΣB·r²`, `r` = offset in the bucket) and per day (`ΣB`, `ΣB·r`). `_schedulePower` updates them whenever it adds a trajectory or removes one (`extend` before expiry removes the old trajectory exactly as it removes its area). A trajectory that reaches its end is never removed (matured withdrawal, restart): its end is then in the past, and a switch only reads ends after itself.
- At the switch: ends on later days contribute `(dayEnd − x)(2e − x − dayEnd)` per unit of `B`, from at most 30 day sums (a trajectory scheduled at or before `x` ends within 30 days); ends later the same day contribute `(e − x)²`, from the bucket sums after `x` and the per-second sums of the bucket holding `x`. At most about 1,100 storage reads: 0.45M–0.8M gas in the tests' ordinary cases, 2.57M measured with an end in every 10-minute bucket of the day and on each of the 30 later days, and up to about 2.79M with five reward tokens (re-review I-1). **Send `enableEmergencyExit` with a fixed gas limit of at least 3.5M**: estimates can be about 1.3M too low (see Gas limits).
- Cost of the index: 6 storage writes per trajectory added or removed. A first 30-day lock costs up to about 2.44M gas, a top-up about 0.46M, an extension up to about 2.22M (re-review I-2; see Gas limits).

**Why it is exact (proof sketch).**

1. *Finality.* Every write to a day's areas comes from `_schedulePower` at some time `c`, as pieces `[max(c, dayStart), to)`. Before the switch `c ≤ x`; after it nothing writes areas (the calls that would are blocked, and `withdraw` writes none). So every piece of day `E` starts at or before `x`, and its part before `x` is fixed at the switch.
2. *Decomposition.* A stored piece `B·((e − a)² − (e − b)²)` over `[a, b)` with `a ≤ x` is exactly its part before `x` plus its part after `x` (an integer identity), so `totalEpochArea[E] = T + R` and `userEpochArea[u][E] = A_u + R_u` with no rounding.
3. *Only live trajectories reach past `x`.* A trajectory replaced by `extend` was added and removed with the same `(B, e)`; the part after `x` of a piece does not depend on where it starts, so the two cancel, in the areas and in the end index alike. A trajectory that ended at or before `x` has nothing after it. Top-ups add pieces with the lock's own end, so the live boost is `locks.boosted`. Hence `R_u` is the lock's tail and `R = Σ R_u`, which is what the end index sums. So `T = Σ_u A_u` exactly.
4. *Solvency.* `Σ_u floor(P × A_u / T) ≤ P` and `P + (budget − P) = budget`, so `totalPaid + totalReleased ≤ totalNotified` and `balance ≥ reserved` still hold.
5. *Independence.* After the switch a locker's exit-day payout depends only on `P` and `T` (fixed at the switch) and its own areas and lock-at-switch. Withdrawing writes only the withdrawer's snapshot; claims move only the claimer's cursor; releases take only budgets nobody can be paid. So no action after the switch changes anyone else's payout, for any day.
6. *No timing lever beyond seconds.* What lockers receive in total is the closed days plus `budget × elapsed / DAY`: linear in `x`, with no jump at midnight (at 23:59:59 the exit day pays 86,399/86,400 of its budget; at 00:00:00 that day is closed and paid in full and the new day pays nothing). The owner chooses only when future accrual stops; units already earned can't move between lockers or to the treasury, beyond floor rounding.

Tested against independent integrals of each lock's segments (restarts, mid-day extensions and top-ups, locks ending before, at, and after the switch, in the switch's own bucket, exactly at midnight, weeks later), in the randomized model on every seed, and by mutation: breaking any part of the index or the snapshot makes the tests fail.

**Releasing budgets nobody can be paid.** Permissionless `releaseEmptyRewards(token, epoch)` takes one day off the books: any day after `E` (whatever its area, even before that day ends), or a day before `E` with zero total area (such a day closed before the switch, so the zero can never change). The exit day's unearned part was released by the switch; its earned part is owed (`EpochHasPower`, or `NothingToFund` if `T = 0` and it all went back already). It reverts `EmergencyExitOff` before the exit, `NotRewardToken`, `EpochHasPower` for a day before `E` with area, and `NothingToFund` if the budget is zero or already released. It zeroes `epochRewards[token][epoch]`, adds it to `totalReleased[token]` and emits `EmptyRewardsReleased(token, epoch, amount)`.

Permissionless `releasePostExitRewards(token)` does the same for every funded day after `E` in one call and returns the total (`NothingToFund` if none is left). It scans the **seven** days from `max(E + 1, launch day)`: each budget was scheduled before the switch, on some day `t ≤ E`, over the seven days from `max(t + 1, launch day)`, so every budget after `E` lies in that window. About 73k–87k gas.

**Accounting.** `reserved(token) = totalLocked (PULP only) + totalNotified − totalPaid − totalReleased`. A day's budget is either payable (before `E` with area; the earned part of `E`) or releasable (after `E`, the unearned part of `E`, zero-area days), never both, and is zeroed or reduced when released, so nothing is paid or released twice. `reserved` stays exactly what is owed, including rounding dust (released only when a retired token expires, see the claim deadline). The vault always holds at least `reserved`; more only when tokens were sent in by mistake or released days haven't been swept yet.

**Where released budgets go.** Only to the treasury: they leave `reserved`, and `recoverExcess(token)` sends the balance above `reserved` to `treasury`, nowhere else (audit M-A). The treasury is fixed at deploy and changes only two-step, 8 days after the proposal and after the last release at the earliest, and only once every funded budget has been earned (see Roles); the current treasury can sweep released budgets itself during those 8 days. Rejected alternatives: the distributor (several may exist and the vault doesn't record who funded which day); whoever stays (review M-2: a tiny lock could collect what leavers forfeit); the exit day by full-day power (review N-1: a stayer would earn until 24:00 while leavers stop at their exit); nothing for the exit day (review N-1 fix, audit M-A: the owner chose how much of an earned day lockers lost).

**Trade-offs and what the switch can and cannot do.**

- It can only let people out and stop future accrual. It cannot move or delay principal or change any entitlement earned before the switch. A compromised owner can stop rewards at any second and route the unearned remainder of the exit day and up to seven funded days after it to the treasury, never to an address of its choice.
- It is final: no new locks, top-ups, extensions or funding ever again in this vault. Recovery means deploying a new vault.
- Staying gains nothing and keeps the user exposed to whatever caused the exit. The UI should tell everyone to withdraw; everyone keeps everything earned up to the switch either way.
- If the PULP token itself freezes the vault or a user, no vault switch can help (see Withdrawal cannot be blocked).

## Withdrawal cannot be blocked

This is a **contract-level** guarantee (audit DOS-6): `withdraw()` succeeds and transfers the caller's full `locks(caller).amount` of PULP **whenever the caller has a lock and either `block.timestamp >= end` or `emergencyExit` is on**, as long as the PULP token transfers from the vault to the caller, the call has enough gas (under 100k on every path: about 53k for a matured lock even after ten idle years, about 74k after the switch) and the chain includes the transaction. `withdraw` reads only the caller's lock, `totalLocked` and the packed exit flag/second, writes the caller's lock (and after the switch its `(boosted, end)` snapshot), and calls only `pulp.transfer`. Specifically it does not depend on, and tests show it survives:

- locks paused (`setLocksPaused` only gates incoming principal);
- the compound fee at the 2% cap with a treasury that refuses PULP (only `compound` pays the fee);
- any registered reward token reverting, returning false, or paused (withdraw never touches reward tokens, claims, cursors or epochs);
- every distributor removed;
- ownership mid-transfer (a pending owner has no power; the current owner can still enable the exit);
- someone else having used `lockFor`/`increaseAmountFor` on the user: they cannot move `end` (top-ups keep it, `extend` is owner-of-lock only), cannot top up a matured lock (`LockExpired`) or re-open it (`LockExists`), and the gifted principal comes back with the rest;
- huge histories and idle years (no loop at all);
- a PULP transfer hook that re-enters (`nonReentrant`: the attempt fails, the withdrawal lands; tested with a hook token that owns a lock of its own).

**No owner function can move locked principal or delay a matured withdrawal.** The owner's complete list: `addRewardToken`, `removeRewardToken`, `setDistributor`, `setLocksPaused`, `setCompoundFee`, `proposeTreasury` (takes effect 8 days later at the earliest), `recoverERC20` (refuses PULP and every token with reward books, pays only the treasury; the treasury may call it too), `recoverExcess` (only above `reserved`, only to the treasury; the treasury may call it too), `enableEmergencyExit` (lets people out and stops future rewards), `transferOwnership` (two-step); `renounceOwnership` always reverts. None takes a user address or touches `locks`, `end` or `totalLocked`. `test/vault/emergency.test.js` enumerates every state-changing function in the ABI against this classification (a new one fails the test until classified), runs every owner power with hostile arguments, and checks after each that principal, `reserved` and the lock are untouched and both withdrawal paths still pay in full. The randomized model checks after every action that each matured lock (and every lock after the exit) can withdraw.

**Outside the vault's control:** a PULP token that pauses, blacklists the vault or the user, charges an outgoing fee or is upgraded can block any transfer; a contract beneficiary that cannot call `withdraw` strands its own lock; the chain can refuse to include a transaction (Robinhood Chain's ArbOS compliance filtering can keep a screened address's `withdraw` out of blocks; the sequencer orders and times every transaction). The real PULP is a plain ERC20 (checked on-chain and on the fork), but these are token- and chain-level facts, not vault guarantees.

## Roles, asset assumptions and limits

- **Roles in short.**

  | Role | Who | Can |
  |---|---|---|
  | Owner | A Safe multisig | Settings (pause, compound fee, distributors), reward-token *types* (add / remove), proposing a treasury, recoveries to the treasury, the one-way emergency exit |
  | Distributor(s) | Wallets the owner whitelists, e.g. the fee wallet (an EOA is fine) | Fund rewards, and only that: `notifyRewardETH`, a plain ETH transfer (`receive`), `notifyRewardAmount`. Adding reward-token types stays owner-only |
  | Treasury | Set at deploy (a Safe); changeable only two-step (below) | Receives the compound fee, mistaken transfers, post-exit releases and expired rewards; can trigger recoveries to itself |

- **Owner** (meant to be a Safe multisig): two-step ownership transfer, up to five active reward tokens and their removal (`removeRewardToken`, only once nothing is scheduled; earned rewards stay claimable for 120 days, then the token can be expired by anyone), distributor permissions, pause/unpause incoming principal, the compound fee rate (0–2%, hard-capped, and never above the maximum each caller passes), proposing a treasury, recovering strays to the treasury (`recoverERC20` for unrelated tokens; `recoverExcess` for the balance above `reserved(token)` of PULP, reward tokens and, with `address(0)`, native ETH forced into the vault by `selfdestruct` or similar), and the one-way emergency exit.
- Owner cannot touch locked PULP or owed rewards (`recoverExcess` stops at `reserved`), cannot send anything to any address but the treasury, cannot sweep PULP or reward tokens with `recoverERC20`, edit the immutable launch/duration model, pause or delay withdrawals/claims/extensions, turn the emergency exit off, or upgrade this contract.
- **Recovery checks (audit EF-1, re-review I-3).** `recoverERC20` refuses PULP and every token with reward books by address, and after every recovery transfer both recover functions check that no protected balance (PULP, every active and retired reward token) is below `min(its balance before, reserved(token))`, else `ReserveBreached(token)`. A token reachable at a second address can't be used to move owed rewards or principal. The `min` keeps recovery usable if a protected token is already short, for example after a WETH gateway burn, while still forbidding any further drop. Each `balanceOf` read gets at most 100k gas (`BALANCE_READ_GAS`), so a token can't burn the caller's whole gas limit, and is an assembly `staticcall` with a fixed 32-byte output buffer: a read counts only if the call succeeds and returns at least 32 bytes, and nothing beyond the first 32 bytes is ever copied into memory (review 3 L-1: a high-level call copied all returndata, so 15 "return bomb" tokens made a recovery cost up to ~69M gas; now about 3.1M). Failed reads are treated conservatively: unreadable **before** the transfer means its balance is unknown, so the floor is all of `reserved(token)` instead of zero (otherwise a token whose `balanceOf` fails and whose second address repairs it during the drain would pass with a zero floor); readable before but **not after** counts as a breach (the transfer broke it). Only a token unreadable both times, broken for the whole call, is skipped, so a broken token still can't block recovering the others. The cost of that choice: a token that fails only the first read and is already short of `reserved` blocks recoveries until its reads work again (retry later). Residual: a protected token that is broken for the whole call *and* has a second working entry point is not checked; reward tokens must not have either property (below).
- **Treasury.** Receives the compound fee and every recovery. `Config.treasury` at deploy; afterwards `proposeTreasury(addr)` (owner) then `acceptTreasury()` from `addr` itself, no sooner than `max(treasuryProposedAt(), lastReleasedAt()) + TREASURY_DELAY` (8 days; else `TreasuryDelayNotOver(acceptableAt)`), and only while no token with reward books (active or retired) has a budget on a day not yet earned (else `UnearnedRewardsScheduled(token, day)`, the first such day). Events `TreasuryProposed(addr)`, `TreasuryChanged(old, new)`. Every proposal restarts the clock, even of the same address; `proposeTreasury(address(0))` cancels (pending and time cleared). Never zero, the vault, PULP, WETH (by address, so also after WETH is removed), a token with reward books or an expired reward token (`InvalidTreasury`, checked at deploy, proposal and acceptance; WETH and expired tokens since review 3 I-1); `addRewardToken` refuses the current or pending treasury.
  - **Ownership changes cancel a pending proposal (re-review L-1).** `_transferOwnership` is overridden: when ownership actually changes (`acceptOwnership`), a pending proposal is cleared and `TreasuryProposed(address(0))` is logged. So a treasury proposed by the deployer's hot key before the handover (or by any previous owner) can never be accepted under the new owner. Offering ownership (`transferOwnership`) alone clears nothing: the offering owner is still the owner and could propose again anyway.
  - **The delay (re-review L-2).** Without it a stolen owner key could propose its own address, accept, turn on the emergency exit, release the unearned days and sweep them, in consecutive transactions. **The community has 8 days to react to `TreasuryProposed`.**
  - **Acceptance waits until every funded reward is earned (external audit A1-2).** The delay alone did not protect funded but unearned rewards. The old reasoning ("funding reaches at most today + 7, so after 8 days everything funded before the proposal is earned") is false: funding before launch sits on the 7 days from the launch day, possibly far ahead, and recycling re-schedules a closed empty day onto the next 7 days. A compromised owner could propose, wait 8 days, accept, exit, release and sweep those budgets to its own treasury, and the old treasury could not help: nothing is released until the exit, which only the owner can trigger. Now `acceptTreasury` scans every token with books over the window `removeRewardToken` uses: the 8 days from `max(today, launch day)` before the exit, from `max(exit day + 1, launch day)` after it. Every budget that can still exist on a day not yet earned lies in that window (each was scheduled over the 7 days from `max(t + 1, launch day)` for a funding or recycling day `t`; after the exit, days after the exit day are never earned until they are released). At most 15 tokens × 8 reads (~374k gas with every slot full). And because releasing is the other way funds leave the books, acceptance also waits 8 days after the last release (`lastReleasedAt`: the switch, any release, an expiry that forfeits something), so the current treasury always has 8 days to sweep what was released before a new one could. Without this a compromised owner could exit, release and accept in one block.
    - **Result:** a new treasury never receives rewards funded before it was accepted: they were earned by lockers first, or released at least 8 days before the acceptance, which the current treasury can sweep (`recoverExcess` is owner-or-treasury). "The current treasury can sweep during the window" therefore applies only to funds already released; the protection for everything still scheduled is that acceptance waits until it is earned.
    - **Procedure:** when a treasury change is proposed, the distributor stops funding (revoke it with `setDistributor(distributor, false)` if needed); acceptance becomes possible once everything funded is earned: at the end of the 7th day after the last funding, and with funding before launch at launch + 7 days. Funding during the window simply postpones acceptance.
    - **Residuals (accepted):** budgets of closed days on which no lock had any power are earned by nobody; before the exit anyone can recycle them during the window (they then block acceptance until earned), otherwise they can reach whichever treasury is current when they are released after an exit. Unclaimed rewards whose 120-day claim deadline ends after the change go to the treasury of that time. Strays sent to the vault are not rewards.
    - **Owner-trust residuals found by review 3 (accepted, H-1 and M-1).** Both need the owner, a Safe multisig, to be compromised, and both reach only the protocol's own *unearned* reward budgets, never a locker's principal or earned rewards. **H-1:** the owner registers a hostile "reward token" whose `balanceOf` makes the recovery reserve check fail (`ReserveBreached`) whenever a sweep has happened, so the current treasury can't sweep released budgets during the 8 days; the owner's own proposed treasury then accepts and sweeps them. **M-1:** the owner pauses locks through the funded launch week, so every funded day has zero power; acceptance is possible from launch + 7 days and those budgets reach the new treasury after an exit (or recycling keeps them for lockers, see above). Monitoring: alert on `TreasuryProposed`, `RewardTokenAdded` and `LocksPausedSet`; during the 8-day window the community can recycle zero-power days (`recycleEmptyRewards`, permissionless), which keeps acceptance blocked. No mechanism was added for these: the owner is trusted not to be compromised (Safe signers).
  - **Recoveries while a proposal is pending: not blocked, and the treasury may trigger them (decision).** While a change is pending, `recoverExcess`/`recoverERC20` keep paying the current treasury, the one already accepted, so they can't benefit the proposed address. Blocking them would freeze exactly the sweep that must happen during the window. The real gap was that only the owner could sweep: a compromised owner could exit and release during the window, hold the sweep back, and run it once its own treasury took over. So both recover functions accept the owner **or the current treasury** (`onlyOwnerOrTreasury`, reverting `OwnableUnauthorizedAccount` for anyone else); the destination is still only the treasury and the amounts and checks are unchanged. Not opened to everyone: `recoverExcess` accepts any token address, and a permissionless call would let anyone make the vault call arbitrary contracts and log spoofed `Recovered` events. Trade-off: a compromised treasury can pull strays and released budgets itself, even while the owner is replacing it (before, the owner could hold them back); it already received every recovery, and principal and owed rewards stay out of reach.
- Ownership renunciation is disabled to avoid permanently freezing pause/distributor settings. Use two-step transfer to the intended multisig/DAO instead. This does not give the owner an upgrade or protected-fund withdrawal power.
- **Distributor** controls **whether, when and how much** to fund. Locking is a commitment, not a guarantee of fees. Future schedules do not stop new eligible lockers from competing for them.
- **Reward tokens** must be plain ERC20s: no blocklist, pause, rebase, fee on transfer, admin burn or mint-from-holder, upgrade into any of these, or second entry point (a second address that moves the same balances). **Never register an alias or shared-ledger token** (two addresses over one balance, or two registered tokens sharing a ledger, PULP included): `reserved` is computed per token address, so the recovery check can't protect a shared ledger, and claims of one would spend the other's backing. Exact incoming balance checks reject ordinary fee-on-transfer tokens, and the recovery check above stops a second entry point from draining owed balances, but neither can stop a token from shorting its own claimers later. A token that fails stops only its own claims (`claim` of the others, `claimTo` and `removeRewardToken` keep everything else working); entitlements and cursors survive.
- **A bad token that keeps being funded (re-review I-4).** `removeRewardToken` needs every open and future day of the token to be empty, so a distributor that funds it every day keeps it unremovable (and `claimAll` failing for everyone, if the token reverts). The fix is to revoke that distributor (`setDistributor(distributor, false)`) and wait 8 days: its last funding reaches at most 7 days ahead, after which nothing is scheduled and the token can be removed (retired, so still claimable). Per-token `claim(token, n)` / `claimTo` of every other token works throughout.
- A token-level freeze can block principal withdrawal; the vault cannot bypass the underlying token.
- The actual PULP, wrapper implementation, decimals, blacklist/pool restrictions and upgrade/admin capabilities must be verified before real deployment. `code.length` alone is not compatibility verification.
- **Launch at 00:00 UTC** (audit MS-3): the constructor refuses a `launchStart` that is not a whole UTC day (`BadConfig`), so the launch day's bonus hours are a full, funded day.
- Default minimum deposit: 35,000 PULP **assuming 18 decimals** (fixed at deploy; re-check its dollar value against the price before deploying); `minLockAmount` is a deployment input in base units (the deploy script asks in whole tokens). No decimals assumption is built into the accounting.
- Total outstanding principal is bounded at `2^128 - 1` base units for arithmetic safety. A position change touches at most 31 calendar-day buckets per old/new schedule plus 6 end-index slots, independent of user count or idle time. Claims process at most 64 recorded days per token.
- Daily settlement is a rolling accounting cycle, not a one-time rewards campaign. Fees may keep being funded indefinitely, and users may keep extending active locks.

### Trust assumptions (audit Info)

| Party | Power |
|---|---|
| Vault owner | As above. Through the exit it can stop future accrual at any second and send the not-yet-earned remainder (the rest of the exit day plus every funded day after it) to the treasury. It can change the treasury only 8 days after proposing it, 8 days after the last release, and once every funded reward has been earned. It can retire a token (only once all its days are over), which starts the 120-day claim deadline. |
| Distributor | Funding only: whether, when, how much. |
| Treasury | Receives fees and recoveries, and can trigger recoveries to itself; can't reach principal or owed rewards. |
| WETH (`aeWETH`) | Upgradeable by Robinhood Chain's UpgradeExecutor; its bridge gateway can burn any holder's WETH, including the vault's reward balance. |
| Robinhood Chain | Arbitrum Orbit, Stage 0, no exit window. The sequencer orders transactions and sets timestamps (may lag up to 4 days or lead about 1 hour: day boundaries and the exit second follow it); ArbOS compliance filtering can exclude a screened address's transactions, `withdraw` included, or a screened fee recipient's. |
| PULP pool hook owner (EOA) | Can redirect the fixed 3% tax, or point it at a recipient that makes every swap revert; can still renounce the hook. |
| Uniswap v4 | The protocol fee can be turned on (≤ 0.1%). |
| PULP token | Plain ERC20 today; a token-level freeze would block withdrawals. |

## Gas limits (re-review I-1, I-2)

Worst cases measured in the re-review (Hardhat, Cancun rules; Robinhood Chain adds its L1 data fee and its own gas accounting, so treat these as orders of magnitude, not exact limits):

| Call | Gas |
|---|---|
| first 30-day `lock` / `lockFor` | about 2.44M |
| `extend` | up to about 2.22M |
| `compound(64, …)` | about 0.74M |
| `claim(token, 64)` | about 0.72M |
| `claimAll(64)` with 5 reward tokens | about 1.97M |
| `enableEmergencyExit` | up to about 2.79M with 5 reward tokens (each retired token adds one budget read) |
| `acceptTreasury` | about 374k with 5 active + 10 retired tokens |
| `recoverExcess` / `recoverERC20` | about 392k with 5 active + 10 retired tokens (16 capped balance reads, twice) |
| `withdraw`, matured | about 53k |
| `withdraw`, after the emergency exit | about 74k |

**`enableEmergencyExit`: send it with a fixed gas limit of at least 3.5M.** Its cost depends on where lock ends fall relative to the switch second, which can move between the estimate and inclusion: estimates can be about 1.3M too low. A switch that runs out of gas reverts and can simply be sent again with more, but in an emergency that costs time. Everything else: send with the wallet's estimate and don't cap it lower.

## Build and test

Node.js 22, npm. Dependencies are pinned in `package-lock.json`; the compiler is the local solcjs 0.8.28
(optimizer 200, Cancun), so builds download nothing.

```sh
npm ci --ignore-scripts
npm run build
npm test             # all unit tests (vault and zap); fork tests are skipped
npm run test:soak    # the randomized vault model with 12 extra seeds of 160 actions
npm run test:fork    # real $PULP and WETH on a local fork of Robinhood Chain (reads the public RPC, sends nothing)
```

The Hardhat configuration only defines the in-process `hardhat` network. It does not load `.env`, private keys or
any deployment wallet. Fork mode (`FORK=1`) reads chain state from `FORK_RPC` (default: the public Robinhood Chain
RPC) and optionally pins `FORK_BLOCK`.

| Test file | What it covers |
|---|---|
| `test/vault/locks.test.js` | durations, launch bonus, power decay, extend, top-ups, timestamp boundaries |
| `test/vault/rewards.test.js` | daily settlement, additive funding, claims and paging, recycling empty days |
| `test/vault/delegated.test.js` | `lockFor`, `increaseAmountFor`, `compound` and its fee, the griefing path |
| `test/vault/emergency.test.js` | the exit switch, exact exit-day payouts, releases, the withdrawal guarantee and the ABI classification of every state-changing function |
| `test/vault/fixes.test.js` | audit fixes: treasury, recovery checks, `claimTo`, `removeRewardToken`, native ETH, events |
| `test/vault/treasury.test.js` | the 8-day treasury delay, cancellation on ownership change, recovery by the treasury, flaky tokens |
| `test/vault/audits.test.js` | external audits A1/A2: the treasury attack with funding before launch, recycled budgets, the release clock; the registry deadlock, the 120-day claim deadline and expiry; typo protection |
| `test/vault/security.test.js` | reentrancy, false-returning / fee-on-transfer / blocking tokens, principal protection, ownership |
| `test/vault/deploy.test.js` | `scripts/deploy-vault.js` helpers: dates, refused addresses, the handover verdict |
| `test/vault/model.test.js` | randomized actions checked against an independent BigInt model after every step, including a third reward token's remove / re-add / expire lifecycle and treasury handovers |
| `test/vault/fork.test.js` | opt-in mainnet fork with the real $PULP and WETH |

## Validation history

How the contract got to its current source (SHA-256
`647e8ae861b1cc0b50df41891bcd2dc5b5752556842a3ce71abc626b8e8ba4d2`). These are local results, not a public
deployment or an external audit.

- **Base design (2026-10-06).** 10/20/30-day locks, launch bonus, daily power-time settlement, paginated claims,
  renouncing ownership disabled after review. 48 tests and 16 soak seeds; the four-seed independent history model,
  timestamp/bonus boundaries, additive funding, same-day extensions, post-withdrawal claims, failing / false /
  re-entrant tokens, principal protection and large-number arithmetic. Representative gas then: 30-day lock
  2,233,485; withdrawal after ten idle years 51,375.
- **Delegated deposits and compounding (2026-10-09).** `lockFor`, `increaseAmountFor`, `compound` through shared
  internals; the randomized model gained PULP as a second reward token and random `lockFor` / `increaseAmountFor` /
  `compound`. 66 tests, 16 soak seeds.
- **Compound fee and mainnet fork (2026-10-09).** Fee capped at 2%. First fork run with the real $PULP and WETH
  (block 84,403,112): locks, funding (wrapped by the real WETH), claims, compound with a fee, recoveries,
  withdrawals, balance equal to `reserved` after every step.
- **Emergency exit (2026-10-09).** One-way switch, early withdrawal, releases. 85 tests; the model switches the
  exit on at a random point of every run.
- **Internal review fixes (2026-10-09/10).** Exit-day rules (review M-2, then N-1), `compound(maxEpochs,
  maxFeeBps)` (L-5), `balance >= reserved` as the stated invariant (I-4). 95 tests; fork runs at blocks 84,474,826
  and 84,555,181.
- **Audit fixes (2026-10-10).** The exit day paid pro rata up to the switch second with an exact end-time index
  (M-A), the treasury replacing the fee recipient, recovery only to the treasury with a post-transfer reserve check
  (EF-1), `claimTo` / `claimAllTo` (EF-4), `removeRewardToken` (AC-2/DOS-2), native ETH recovery (DOS-3/EF-5),
  00:00 UTC launch (MS-3), richer events (GA-3), and the rewritten deploy script (AC-3, AC-8, E2E-4). 110 tests; the
  model checks every exit-day payout against `budget × elapsed / DAY × A_u / T` (within two units), and mutations
  of the end index or the exit snapshot make it fail.
- **Re-review fixes (2026-10-10).** Ownership changes cancel a pending treasury (L-1), the 8-day treasury delay and
  recoveries callable by the current treasury (L-2), the stricter handover check (L-3), gas-capped balance reads in
  the reserve check (I-3), documented gas limits (I-1, I-2) and the revoke-then-remove procedure (I-4).
  Runtime bytecode 21,201 bytes. **131 tests, 16 soak seeds, 7 fork tests** (block 84,772,813).
- **This repository (2026-10-10).** The same source, built and tested together with PulpZap: 131 vault unit tests
  in `npm test`, 16 soak seeds, and the 7 vault fork tests again passing on a fresh fork (block 84,853,444).
- **External audit fixes (2026-10-10).** Two external audits of the source above (`a8bb34b4…`). Treasury
  acceptance waits until every funded reward is earned and 8 days after the last release (A1-2); 10 retired slots
  and the 120-day claim deadline with `expireRewardToken` (A1-1, A2-4); typo protection for reward tokens and
  beneficiaries (A2-3, A2-6). Runtime bytecode 22,427 bytes. **142 tests, 16 soak seeds (now with a third reward token's lifecycle and treasury handovers), 7 fork tests** (block 84,957,009).

Gas figures measured along the way (Hardhat, Cancun rules): first 30-day lock 2,308,195 (2.44M worst case);
top-up ~462k; extension ~612k (2.22M worst case); 64-day claim page 516,015; matured withdrawal after ten idle
years 53,172; withdrawal after the switch 73,665; `enableEmergencyExit` 0.45M–0.8M typical, 2.79M worst case with
five reward tokens; `releasePostExitRewards` over 7 funded days 73,121; `notifyRewardETH` 102,907 warm to ~274k.

## Deploy

`scripts/deploy-vault.js` deploys the vault with your own keys and sets it up in one run. The step-by-step guide
is in the [README](../README.md#deploy); this is the reference.

```sh
npm ci --ignore-scripts
npm run deploy:vault -- --dry-run                   # every check, the simulation and the cost; sends nothing
npm run deploy:vault                                # the real thing
npm run deploy:vault -- --config config/vault.json  # settings from a file shaped like config/vault.example.json
npm run deploy:vault -- --site <frontend dir>       # also write the vault address into <dir>/lock/config.js
npm run deploy:vault -- --check-handover <vault>    # has the final owner accepted? (add --wait-handover to wait)
```

It asks for the **deployer's private key** at a hidden prompt. Keys are never echoed, stored or logged, and never read from arguments, environment variables or files. On Robinhood Chain it refuses Hardhat's/Anvil's public test keys, and their addresses for any role (they are 7702-delegated sweepers there). Then it asks for:

- the PULP and WETH addresses, each checked on-chain (a contract, an ERC20, and WETH has to take ETH through `deposit()`),
- the fee distributor,
- the **final owner**: no default, never the deployer, the PULP or WETH entered, or a known Robinhood Chain token or pool contract ($PULP, WETH, the Uniswap v4 PoolManager that holds the $PULP / ETH pool); on Robinhood Chain it must have contract code that isn't a 7702 delegation (a multisig) unless `--allow-eoa-owner`,
- the **treasury**: no default; not PULP, WETH, a known token or pool contract, or the vault. It may be an EOA: a warning if it is the deployer, a note otherwise that a single key then receives every fee and recovery,
- the day locking opens: a UTC date (it opens at 00:00 UTC) or a unix time that is a whole day, at least two hours ahead. A date that doesn't exist (2026-02-30, 2026-04-31, 24:00) is refused, not rolled over to the next month or day,
- the launch-bonus window in hours (under 1 hour needs `--force`) and the minimum lock in whole PULP (default 35,000; under 1 token needs `--force`),
- whether to also pay rewards in PULP, any extra wallets allowed to send fees, and the compound fee in basis points (default 100 = 1%, at most 200), paid to the treasury.

`--config file.json` fills these in from a file shaped like `config/vault.example.json`, **in the prompts' units**: `launchStart` as a date or unix time, `earlyWindowHours`, `minLockAmountTokens` (whole tokens), `compoundFeeBps`, optional `pulpRewards` and `extraDistributors`. The old contract-unit keys (`earlyWindow`, `minLockAmount`, `feeRecipient`) and unknown keys are refused by name, as is anything key-like.

Before sending anything it shows the plan and the maximum cost and simulates the deployment, then waits for you to type `deploy`. In order it:

1. deploys the vault, owned by the deployer while it's set up (only the owner can make the setup calls),
2. adds PULP as a reward token (if chosen) and allows the extra fee senders,
3. **offers** ownership to the final owner (`transferOwnership`). It never accepts for it and never asks for its key: the owner calls `acceptOwnership()` itself, at the latest an hour before locking opens,
4. reads every setting back from the chain (including `pendingOwner`, `locksPaused`, `treasury`, `pendingTreasury`, `emergencyExit`), saves a record in `deployments/`, verifies the source on Blockscout (or prints how to do it by hand) and, with `--site`, writes the address into the frontend's `lock/config.js`,
5. reports the handover: with `--wait-handover` it waits for the acceptance; it exits 1 if launch − 1h has passed without it.

`--check-handover <vault>` (no key) compares the vault with the expected final owner, deployer and treasury, taken from `--owner`, `--deployer`, `--treasury` or else from the vault's `deployments/<chainId>-<vault>.json` record (it refuses to guess: without an expected owner and treasury it stops). It exits **0** only when nothing is pending, the owner is the expected final owner and not the deployer, on Robinhood Chain the owner has contract code (unless `--allow-eoa-owner`), `pendingTreasury` is zero and `treasury` is the deployed one. **3** while ownership is offered to the expected owner before launch − 1h. **1** otherwise: past launch − 1h, offered to another address, owned by anyone else, the deployer still owning it with nothing offered (the `transferOwnership` step failed), an EOA owner, a pending treasury change or a different treasury. The same verdict ends a real deploy. The helpers are unit-tested in `test/vault/deploy.test.js`.

Other flags: `--rpc`, `--chain-id` (if the RPC is on a different chain, nothing happens), `--explorer <url|none>`, `--no-verify`, and `--owner`/`--treasury`/`--deployer` (only with `--check-handover`). Signing uses ethers v6; Hardhat only compiles.

## Before any deployment

1. Confirm **daily settlement versus continuously claimable rewards** and the launch bonus decay window (example: 24 hours).
2. Confirm chain, actual PULP/wrapped-native addresses, decimals, minimum deposit, fee distributor, final owner and treasury.
3. Verify token compatibility and chain/compiler support; `npm run test:fork` covers real PULP/WETH transfers and wrapping on a fork, but not the intended EOA funding route or Orbit-specific gas.
4. Get the payout model and source reviewed independently. Local tests and internal reviews are not an external security audit or a launch guarantee.
5. Select a future launch day (00:00 UTC), the owner multisig and the treasury, rehearse with `--dry-run`, confirm gas and funding, then deploy.

Design reference: [Curve's remaining-time vote-escrow principle](https://github.com/curvefi/docs/blob/main/docs/user/vecrv/what-is-vecrv.md). The launch multiplier, short durations and daily integral accounting here are this project's design, not a claim of Curve code equivalence. Security and arithmetic helpers are imported from [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/5.x/api/utils).
