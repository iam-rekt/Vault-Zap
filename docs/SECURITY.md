# Security status

**The vault had two external audits (A1, A2) on an earlier source (`a8bb34b4…`) and two more external reviews
(R4, R5) of the fixes; after R4/R5 the vault was simplified (below). Earned rewards are claimable forever and
nobody, the owner included, can take them. The zap has had no external audit.** Everything else below is internal: three AI-assisted security reviews, one AI-assisted checklist audit with
an end-to-end fork run, and the test suites in this repository. Nothing has been deployed.

| Contract | SHA-256 of the tested source |
|---|---|
| `contracts/PulpVeVault.sol` | `c3bf146418b23d7a915848b4294218f20d5dcd1a2c7bca927f3ba2e2eaad7062` (externally audited version: `a8bb34b40faec1de7913a38222b645bf4914fae63afc18b54743265ca7c9f0d4`; reviewed by review 3: `647e8ae8…`; by R4/R5: `95356b25…`) |
| `contracts/PulpZap.sol` | `871cbf4865ca76c1bd567124fd414deaa87a46c1798c11262002f4cf5897c042` |

## Timeline

| Date | What | Result |
|---|---|---|
| 2026-10-09 | Security review of both contracts (review 1) | 0 Critical, 0 High, 2 Medium, 7 Low, 6 Info. All fixed or documented |
| 2026-10-10 | Re-review of those fixes (review 2) | No Critical/High/Medium; 1 Low (N-1), 5 Info. N-1 fixed |
| 2026-10-10 | Checklist audit + end-to-end fork run (below) | 0 Critical, 0 High, 3 Medium, 11 Low, ~25 Info after de-duplication. All Mediums and Lows fixed or documented |
| 2026-10-10 | Re-review of the audit fixes | No Critical/High/Medium; 3 Lows (L-1 to L-3), all fixed |
| 2026-10 | Two external audits of the vault (A1, A2), source `a8bb34b4…` | A1-1 and A1-2 (registry deadlock, treasury handover), A2-3/A2-4/A2-6 fixed; the rest documented or accepted (below) |
| 2026-10-10 | Adversarial review of the A1/A2 fixes (review 3), source `647e8ae8…` | 1 High, 1 Medium (both need a compromised owner Safe and reach only unearned protocol budgets: accepted), 1 Low fixed, 4 Info (below) |
| 2026-10-10 | Two external reviews of the fixes (R4, R5), source `95356b25…` | R4-1 (High) rejected; forfeiture of earned rewards and treasury-handover griefing resolved by removing the claim deadline and the acceptance scan; registry lockout accepted (below) |

## External reviews R4 and R5 (vault)

Both reviewed `contracts/PulpVeVault.sol` at `95356b2548f883b8eb906286b65992932004dbb84ef83840c366ef06656ab6bc`.
The owner chose to simplify rather than add more mechanisms: the 120-day claim deadline and the extra
treasury-acceptance rules are removed. What stays: the 8-day treasury notice (propose / accept), recoveries only to
the treasury (callable by the owner or the treasury), the return-bomb-safe balance reads, 10 retired slots and the
typo guards.

| ID | Finding | Resolution |
|---|---|---|
| R4-1 | High (claimed): `_tryBalance` puts the `balanceOf` selector in the wrong bytes, so every balance read fails and the reserve check is skipped | **Rejected.** A `bytes4` local is left-aligned in its 32-byte Yul word, so `mstore(ptr, selector)` writes the selector to `ptr..ptr+3` and the address follows at `ptr+4`. The reads work: the `ReserveBreached` tests (a recovery that would take owed balance reverts naming the token) only pass if they do. `_tryBalance` is unchanged |
| R4-2, R5-2 | The claim deadline lets anyone expire a retired token and forfeit users' earned, unclaimed rewards to the treasury | **Resolved by removing the claim deadline** (`expireRewardToken`, `CLAIM_DEADLINE`, `retiredAt`, `isExpiredRewardToken`, `RewardTokenExpired`, `ExpiredRewardToken`, `NotRetiredRewardToken`, `ClaimDeadlineNotReached`). Earned rewards are claimable forever; retired tokens stay claimable, reserved and protected and can be re-added (tested two years after retirement) |
| R4-3, R5-1 | Treasury handover liveness: anyone can keep `acceptTreasury` blocked (recycling empty days, dust funding, permissionless releases restarting the clock) | **Resolved by removing the acceptance scan and the release clock** (`UnearnedRewardsScheduled`, `lastReleasedAt`). `acceptTreasury`: only the pending treasury, only from `treasuryProposedAt + 8 days`, and `_checkTreasury`. A pending proposal is still cleared on every ownership change |
| R4-4 | `lastReleasedAt` can be bumped by anyone through a release | **Moot:** `lastReleasedAt` is removed |
| R5-3 | The registry (5 active + 10 retired) can fill up; then nothing can be retired or reactivated | **Accepted, documented.** If it is ever full, a broken active token stays in `claimAll`, but per-token `claim`/`claimTo` always works for every other token (tested) |
| R4-5 | Info notes: a `_removeFrom` comment cites only the retired cap (it also serves the active list); `acceptTreasury` is not `nonReentrant` (it makes no external calls); a new treasury can still receive dust and budgets of days with no power; offering ownership (`transferOwnership`) does not clear a pending treasury proposal, only accepting it does; the claim-deadline notes are moot after its removal | **Documented / no change needed** |

**Accepted residual (A1-2, with review 3 H-1/M-1).** A compromised owner Safe can, after the 8-day public notice,
accept a new treasury and route funded-but-unearned reward budgets to it (exit, release, sweep). Never principal,
never earned rewards: `test/vault/audits.test.js` replays it and checks lockers claim every earned reward and
withdraw all principal. Monitoring: alert on `TreasuryProposed`, `RewardTokenAdded`, `LocksPausedSet` and
`EmergencyExitEnabled`.

## External audits A1 and A2 (vault)

Both audited `contracts/PulpVeVault.sol` at `a8bb34b40faec1de7913a38222b645bf4914fae63afc18b54743265ca7c9f0d4`.
The audit reports are not part of this repository.

| ID | Finding | Resolution |
|---|---|---|
| A1-2 | The 8-day treasury delay did not protect funded but unearned rewards: a compromised owner could `proposeTreasury(attacker)`, wait 8 days, `acceptTreasury`, `enableEmergencyExit`, `releasePostExitRewards` and `recoverExcess` to the new treasury. Worst with funding before launch (it sits on the 7 days from the launch day, possibly far ahead) and recycled budgets; the old treasury could not help, since nothing is released until the owner's exit | **Accepted owner-trust residual** (after R4/R5; first fixed with an acceptance scan and a release clock, which R4-3/R5-1 showed could be griefed, so both were removed). The 8-day delay is a public notice; principal and earned rewards are never reachable. Tested: lockers claim every earned reward and withdraw all principal |
| A1-1 | Reward-token registries could deadlock: retiring needs a retired slot (max 5), reactivating an active slot (max 5), and a retired token never leaves because rounding dust or unclaimed rewards keep `notified != paid + released` | **Mitigated, rest accepted.** Up to 10 retired tokens (`MAX_RETIRED_REWARD_TOKENS`; active stays 5). The 120-day claim deadline added for it was removed after R4/R5 (it could forfeit earned rewards). If both lists are ever full, a broken active token stays in `claimAll`; per-token `claim` always works (R5-3). Every loop stays bounded (16 capped balance reads per recovery check) |
| A2-4 | A retired token's closed zero-power day budgets were stuck: recycling needs an active token, releasing needs the exit | **Accepted** (the expiry that released them is removed): they stay reserved while the token is retired; re-adding the token lets anyone recycle them, and after the exit they can be released |
| A2-3, A2-6 | `_addRewardToken` accepted the vault itself (and protocol contracts); `_checkBeneficiary` (`lockFor`, `increaseAmountFor`, `claimTo`, `claimAllTo`) refused only zero and the vault | **Fixed** as far as the vault can know: `addRewardToken` refuses the vault (`InvalidRewardToken`), the treasury and a pending treasury (as before); beneficiaries also refuse PULP, WETH and every token with reward books (`InvalidBeneficiary`). The zap, PoolManager and hook are unknown to the vault: the zap refuses them as beneficiaries itself, and the owner must never register them as reward tokens |
| A1-3 | Two token addresses sharing one balance ledger pass the per-token reserve check (each address is checked against its own liability, not the sum) | **Accepted, documented.** Only reachable if the owner registers such a token; PULP and WETH are not. Alias or shared-ledger tokens must never be registered as reward tokens |
| A1-4 | Anyone can open a lock for another address; a zap then tops it up and can end sooner than the length the user asked for | **Accepted, documented** (design: the attacker gives away at least `minLockAmount`; nothing is stolen). See ZAP.md |
| A2-1 | A compromised owner can halt future rewards and route up to ~8 days of unearned budgets to the treasury | **Accepted owner trust** (see A1-2): routing unearned budgets to the treasury through the exit is an owner power, to a new treasury only after the 8-day notice; earned rewards and principal are never reachable |
| A2-2 | `exitDayTotalArea` uses a subtraction that floors at zero | **Accepted.** Correct as written (the auditor agrees); it only matters for future code changes, which the differential fuzz and mutation tests catch |
| A2-5 | Pausing does not pause `extend` | **Accepted, documented:** the pause gates only incoming principal, by design |
| A2-7 | `RewardPaid` is emitted with amount 0 on pages that pay nothing | **Accepted, documented** for indexers |
| A2-8 | A hostile pool hook could open a lock for the beneficiary in the middle of a zap | **Not reachable** with the real tax hook: its code is fixed and its only external call forwards 50k gas, far below a lock (~1.7M) |
| A2-9 | An OrRefund failure that used over 7/8 of the hop's gas is reported as `InsufficientGas` instead of refunded | **Accepted:** practically unreachable (the auditor agrees); real failures happen early in the hop |
| A2-10 | If a reward token's balance falls below what is owed, the last claimers bear the shortfall | **Accepted, documented** token trust assumption (reward tokens must be plain ERC-20s) |

## Review 3 (adversarial review of the A1/A2 fixes)

IDs are local to this review. The vault's owner is a Safe multisig, so H-1 and M-1 require that Safe to be
compromised; they only ever reach the protocol's own **unearned** reward budgets, never a locker's principal or
earned rewards. They are accepted as owner-trust residuals; no new mechanism was added. Regression tests replaying
the reviewer's proofs of concept: `test/vault/review3.test.js`.

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| H-1 | High | The treasury-change protections (acceptance blocked while unearned budgets are scheduled, and until 8 days after the last release; both removed since, after R4/R5) can be bypassed by a compromised owner: it registers a hostile "reward token" whose `balanceOf` makes `_checkReserves` revert after any sweep, so the current treasury can't sweep released budgets for the 8 days; then its own proposed treasury accepts and sweeps them | **Accepted (owner trust).** Needs the owner Safe to be compromised; reaches only budgets nobody has earned yet (the test checks lockers claim everything earned and withdraw all principal). Monitoring: alert on `RewardTokenAdded`, `TreasuryProposed` and `EmergencyExitEnabled`. Documented in [TECHNICAL.md](TECHNICAL.md) (Treasury) |
| M-1 | Medium | Pausing locks through the funded launch week makes every funded day zero-power; acceptance is then possible from launch + 7 days and those budgets reach the new treasury after an exit | **Accepted (owner trust).** Needs the owner Safe; nobody could lock, so no user funds are involved. Alert on `LocksPausedSet` |
| L-1 | Low | Return bomb: `_tryBalance` used a high-level `staticcall` that copied all returndata into memory, so 15 hostile reward tokens made a recovery cost up to ~69M gas | **Fixed.** Assembly `staticcall` with the 100k gas cap and a fixed 32-byte output buffer; a read counts only if the call succeeds and returns at least 32 bytes. With 15 return-bomb tokens (5 active + 10 retired): `recoverExcess` 3.10M gas, `recoverERC20` 3.12M (gas-burning tokens 3.26M / 3.28M; normal 0.40M / 0.42M) |
| I-1 | Info | Treasury validation | **Fixed:** `_checkTreasury` (constructor, `proposeTreasury`, `acceptTreasury`) also refuses WETH by address (so also after WETH is removed) |
| I-2 | Info | The reward-token registry can be kept full | **Documented** (see R5-3): a full registry blocks removals and reactivations; per-token `claim`/`claimTo` always works |
| I-3 | Info | Can `acceptTreasury` be blocked forever (permissionless releases restarting the 8-day clock, recycling, dust funding)? | **Moot** after R4/R5: acceptance no longer depends on releases, recycling or funding |
| I-4 | Info | The owner can register a user's contract wallet as a "reward token", after which that address is refused as a beneficiary (`lockFor`/`claimTo` to it); a hostile reward token can also delay recoveries | **Documented** owner-trust assumption: owner griefing only; the user's own `withdraw` and `claim` are unaffected, and principal and earned rewards stay reachable |

## Review 1 and 2 (internal reviews)

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| M-1 | Medium | The zap silently turned a "new N-day lock" into a top-up of any existing lock: a front-run `lockFor(victim, min, 30)` locked a 10-day zap for 30 days | `maxUnlockTime` on every entry point and `checkBeneficiary`, checked before the swap and again after the vault call (`UnlockTooLate`) |
| M-2 | Medium | After the emergency exit, whoever stayed (including the owner) collected the funded days leavers forfeited | Days after the exit are unpayable and released to the treasury; superseded by the audit's M-A rule (exit day paid pro rata to the switch second) |
| L-1 | Low | `Zapped.caller` was the zap itself on the OrRefund path | The outer caller is passed through and emitted |
| L-2 | Low | Beneficiary could be WETH / PULP / PoolManager / hook (refund to WETH stranded) | Deny-list on every entry point |
| L-3 | Low | No `sync(native)` before `settle`: a dangling `sync(PULP)` inside the unlock window blocked every zap | `poolManager.sync(address(0))` right before `settle{value}` |
| L-4 | Low | Refunds forwarded all gas and copied return data; a starved hop could not refund | 50k-gas refund call without return-data copy, WETH fallback, 250k reserve |
| L-5 | Low | Owner could raise the zap fee / compound fee under a user's slippage margin | `maxFeeBps` on zaps and `compound(maxEpochs, maxFeeBps)` (`FeeAboveMax`) |
| L-6 | Low | `lockFor` griefing cost about $1 with a 1,000 PULP minimum | Default minimum lock 35,000 PULP |
| L-7 | Low | Bridge pitfalls (`max` amounts, executor as beneficiary) | Documented in [BRIDGES.md](BRIDGES.md) section 4 |
| I-1..I-6 | Info | Stray ETH via WETH `withdrawTo` stuck; exit pre-check; Quoter-based `minPulpOut`; `balance >= reserved` invariant; permanent reward-token slots; external trust | `sweep` to the treasury; `emergencyExit` checked before the swap; docs; `removeRewardToken` (later, AC-2) |
| N-1 | Low | Stayers still won on the exit day itself | Exit-day rule replaced (final rule: M-A below) |
| N-2..N-6 | Info | Frontend fee bound, planted shorter locks, `LockEndsTooSoon` DoS, stale docs, `exitEpoch()` reads 0 while off | Documented ([ZAP.md](ZAP.md) "Open risks"); off-chain readers check `emergencyExit()` first |

## 2026-10-10 audit

Method: the 11 EVM audit checklists (general, assembly, precision-math, defi-staking, erc20, flashloans,
defi-amm, dos, access-control, chain-specific, bridges), each worked through by a specialist reviewer, plus one
end-to-end run on a fork of Robinhood Chain. Every checklist item was marked PASS, N/A or a finding; every Medium
has a runnable proof of concept. No contract was changed during the audit; fixes came afterwards (see "Fix
status").

| Area | Crit | High | Med | Low | Info |
|---|---|---|---|---|---|
| General + assembly (GA) | 0 | 0 | 0 | 1 | 3 |
| Math + reward accounting (MS) | 0 | 0 | 0 | 1 | 4 |
| Tokens + flash loans (EF) | 0 | 0 | 0 | 3 | 3 |
| Uniswap v4 (AMM) | 0 | 0 | 1 | 2 | 3 |
| DoS + gas (DOS) | 0 | 0 | 0 | 1 | 6 |
| Access control (AC) | 0 | 0 | 1 | 2 | 6 |
| Chain + bridges (CB) | 0 | 0 | 1 | 2 | 6 |
| End-to-end fork (E2E) | 0 | 0 | 0 | 1 | 4 |
| **After de-duplication** | **0** | **0** | **3** | **11** | **~25** |

**Bottom line.** No Critical or High. No path was found, by any reviewer or in 38 simulated days on real chain
state, that takes locked principal, blocks a withdrawal at contract level, steals closed-day rewards from a
locker, or misuses an approval.

### End-to-end run

Fork of Robinhood Chain at block 84,612,129 with the real PULP, WETH, PoolManager, tax hook, pool, Quoter and
Chainlink. 38 simulated days, 25 users plus traders, distributor, owners, relayer and attacker; the vault deploy
script ran non-interactively against a local fork node (dry run, then full).

- 19/19 scenarios passed. Every invariant held after each of 630 transactions; all 201 reward payments matched
  an independent model to the wei.
- The launch bonus falls strictly from 2× to 1×; flash-sized locks can't be repaid; a lock in the same block as a
  funding earns the same either side of it; a whale entering 60 s before a day closes gets 0.03% of that day.
- Planted locks, fee raises, stale quotes, expired deadlines, gas-burning beneficiaries: all revert or refund
  cleanly, nothing stranded.
- Emergency exit mid-life: closed-day rewards unchanged for everyone; 19.82 WETH and 355,903 PULP released and
  swept; final dust 398 wei WETH, 355 wei PULP.
- Costs at the real gas price then (0.02 gwei, ETH $2,486): lock ≤ $0.11, zap ≤ $0.10, claim ≤ $0.02,
  compound ≤ $0.03, withdraw ≤ $0.016, deploying both ≈ $0.31.

### Medium findings

**M-A: the owner decided how much of the exit day lockers lost, and could send released rewards anywhere
(AC-1, MS-1).** Under the previous rule the exit day paid nobody, so a switch at 23:59:59 cancelled a fully earned
day, and `releasePostExitRewards` + `recoverExcess(token, to)` could move it plus up to 7 funded days to any
address in one block (PoC: switch at 23:59:50, attacker 50 of 70 WETH).
*Fix:* the exit day is paid pro rata up to the switch second (exact, see
[TECHNICAL.md](TECHNICAL.md#emergency-exit)); released and stray funds go only to a treasury fixed at deploy,
changeable only two-step after an 8-day delay (a public notice; see A1-2 for the accepted residual).

**M-B: bridges sizing gas with `eth_estimateGas` made every bridged zap refund (CB-1, E2E-1).** OrRefund
refunded on any hop failure, including out-of-gas, so estimators settled on the cheap refund path (reproduced
through the real Across SpokePool + MulticallHandler and the real Relay router; even estimate × 1.5 refunded).
*Fix:* a hop that ran out of gas reverts `InsufficientGas` instead of refunding, so estimates land on the lock
path; genuine failures still refund. Across must be used with `fallbackRecipient = 0`
([BRIDGES.md](BRIDGES.md)).

**M-C: sandwiches on a thin pool; the tax recipient can sandwich any size (AMM-1, EF-2).** Bridge zaps are
visible on the origin chain before they fill and 1 ETH moves the pool ~7%; third parties profit from about 1 ETH
upward despite the 3% tax each way, and the hook's tax recipient (an EOA) gets its own tax back, so it profits at
any size.
*Mitigation:* optional caller price limit `minSqrtPriceX96`; frontends default to tight slippage, show price
impact, warn above ~2% / 0.5 ETH and refuse above ~5%; bridge margins at most 1%.

### Low findings

| ID | Finding | Fix |
|---|---|---|
| DOS-1 | The zap required its PULP balance to rise by exactly the swap output; any code inside the swap could push 1 wei and block every zap | Lock exactly the swap output; any extra is a sweepable stray |
| GA-1 | The 250k refund reserve is calibrated to today's WETH; an upgrade adding ~100k gas would make some refunds revert | Monitor WETH `Upgraded`; re-measure after upgrades ([ZAP.md](ZAP.md#monitoring)) |
| EF-1 | Recovery protected tokens by address; a two-address token would let the owner take owed rewards or principal | After each recovery, every protected balance is checked against `reserved` (gas-capped reads) |
| EF-4 | A reward token that blocklists the claimer: no way to claim elsewhere | `claimTo` / `claimAllTo`; reward-token rules documented |
| AC-2 / DOS-2 | Reward-token slots were permanent; one bad token broke `claimAll` for everyone | `removeRewardToken` once nothing is scheduled; earned rewards stay claimable |
| AC-3 | Deploy script defaulted the owner to the deployer hot key | No owner default; contract owner required on 4663 unless forced; always two-step; strict handover check |
| CB-2 | The documented Across ETH recipe never locked: Across delivers WETH to contracts | WETH recipe (`zapWETHOrRefund`) or unwrap recipe, both tested through the real contracts |
| CB-3 | ArbOS compliance filtering can keep a screened address's `withdraw` out of blocks; a screened fee recipient blocks zaps | Documented as a chain trust assumption |
| AMM-2 | The hook owner (an EOA) can halt every swap via a hostile tax recipient | Trust assumption; monitor; frontends `eth_call` the real zap before signing |
| AMM-3 | Thin pool, no price-impact cap (5 ETH ≈ 19% vs spot) | Frontend limits; bridge size caps |

### Info (grouped)

- The PULP tax is fixed at 3% forever (`AlreadyLaunched`, no other writer, hook neither upgradeable nor pausable);
  the hook owner can only redirect it (AMM-4).
- Trust table (WETH is upgradeable `aeWETH` whose gateway can burn balances; sequencer timestamps; v4 protocol
  fee; Stage 0): in the [README](../README.md#trust-assumptions).
- Events added: exit details, funder on funding, early withdrawal (GA-3). Zap deploy script with a pool-id
  assertion and constructor `expectedPoolId` (GA-4, AC-7). Fee recipients reuse the beneficiary deny-list (AC-5);
  `sweep` only to the fee recipient (AC-6). Native ETH forced into the vault is recoverable (DOS-3, EF-5). The
  compound fee is documented as a convenience fee (MS-2). Launch only at 00:00 UTC (MS-3). Bonus persistence
  through extensions and reserved dust are by design (MS-4, MS-5). Config units match the prompts and Hardhat's
  public keys are refused on 4663 (AC-8, E2E-4). Docs: the dangling-`sync` fix covers one variant only (GA-2),
  `maxUnlockTime = deadline + days` (CB-5), bridge address matrix (CB-6), gas figures (E2E-2), call the zap at top
  level (EF-6), "withdraw can't be blocked" is a contract-level guarantee (DOS-6).
- Throughput: a lock writes up to 31 days (≤ 2.3M gas); the chain's 7M gas/s limit means ~3 locks/s chain-wide
  during a launch rush (DOS-5).

Not verified by the audit: Across relayer and Relay solver gas policies; Relay's on-chain failure behaviour;
whether L1 force inclusion bypasses Robinhood's filter; Timeboost.

## Fix status

| Finding | Status |
|---|---|
| M-A exit day / treasury | Fixed: the exit day is paid pro rata up to the switch second (exact end-time index; an independent differential fuzz of 1,267 histories found 0 mismatches); released and stray funds go only to the treasury, which changes only after an 8-day delay and is cleared on ownership change; the current treasury can sweep already-released funds during a pending change. (The A1-2 acceptance scan and release clock were removed again after R4/R5; A1-2 is an accepted residual.) |
| M-B bridge gas | Fixed in the zap (an out-of-gas hop reverts `InsufficientGas`). Across must be used with `fallbackRecipient = 0` (its handler's own catch otherwise swallows the revert); locks at estimate + 10% through the real Across and Relay contracts |
| M-C sandwiches | Mitigated: optional `minSqrtPriceX96`; frontend slippage 0.5% floor / 3% max, price-impact warning from 2%, refusal above 5% |
| Lows | All fixed or documented: DOS-1, EF-1, EF-4, AC-2/DOS-2, AC-3 + E2E-4, AC-5/AC-6, CB-2/CB-3/AMM-2/AMM-3/GA-1 (docs, trust table, frontend limits), GA-4/AC-7, MS-3, DOS-3/EF-5, GA-3 |
| External audits A1, A2 | A2-3, A2-6 fixed; A1-1 mitigated (10 retired slots, rest accepted); A1-2, A2-1, A2-4 accepted owner-trust residuals; A2-8 not reachable; A1-3, A1-4, A2-2, A2-5, A2-7, A2-9, A2-10 accepted and documented |
| Review 3 | H-1, M-1 accepted (compromised owner Safe; unearned protocol budgets only); L-1 and I-1 fixed; I-2, I-4 documented; I-3 moot |
| Reviews R4, R5 | R4-1 rejected; R4-2/R5-2 and R4-3/R5-1 resolved by removing the claim deadline and the acceptance scan; R4-4 moot; R5-3 accepted; R4-5 documented |
| Re-review of the fixes | No Critical/High/Medium. Its three Lows fixed: a pending treasury no longer survives an ownership handover (L-1), 8-day treasury delay with recoveries callable by the current treasury (L-2), strict handover check in the deploy script (L-3); plus gas-capped balance reads (I-3) and documented gas limits (I-1, I-2) |

## Test evidence

On the current sources (hashes above):

| Suite | Result |
|---|---|
| Vault unit tests (`npm test`, `test/vault/`) | 145 passing (including the review 3 and R4/R5 regressions) |
| Vault randomized model, soak (`npm run test:soak`) | 16 seeds passing (with a third reward token's remove / re-add lifecycle and treasury handovers) |
| Vault mainnet fork (`npm run test:fork:vault`) | 7 passing (on the current source at the latest block on 2026-10-10, 85,014,074; earlier runs at 84,772,813, 84,853,444, 84,957,009) |
| Zap unit tests (`npm test`, `test/zap/`) | 70 passing + 5 deploy-script helper tests |
| Zap deploy script end to end (`npm run test:deploy`) | 11 passing against a local Hardhat node |
| Zap mainnet fork (`npm run test:fork:zap`) | 8 passing (at the estimate + 10%, the documented rule) |
| End-to-end suite on a 4663 fork (separate, not in this repository; run on the previous vault source) | 22/22 with the real PULP, WETH, PoolManager, hook, pool, Across and Relay contracts; a frontend was also driven in a browser against a local fork (lock with ETH, top-up, guardrails, claim, compound) |

**Zap fork, gas estimates.** Sending an OrRefund call at *exactly* its gas estimate can fall about 40k short (the
vault's gas depends on where the lock's end falls in its 10-minute bucket); it then reverts `InsufficientGas`, never
refunds. The fork test sends at the documented estimate + 10% and every case locks.

Coverage highlights: the vault's randomized model checks every lock, power, claimable amount, wallet and the
vault's balances against an independent BigInt model after every action, including exit-day payouts against
`budget × elapsed / DAY × A_u / T`; `test/vault/emergency.test.js` classifies every state-changing function in the
ABI and checks every owner power with hostile arguments against both withdrawal paths; the zap tests assert the
zap holds nothing after every call.

What none of this covers: Arbitrum/Orbit gas accounting (forks run under Ethereum Cancun rules), real bridge
relayers and solvers, fuzzing beyond the randomized model, formal verification, an external audit of the zap, and an
external review of the simplification made after R4/R5.
