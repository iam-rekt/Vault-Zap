# paperdao-contracts

Two Solidity contracts for **$PULP** on Robinhood Chain (chain id 4663), with their tests, deploy scripts and
design notes:

- **PulpVeVault** (`contracts/PulpVeVault.sol`): lock $PULP for 10, 20 or 30 days and earn a share of the
  trading tax, paid in ETH (as WETH) and $PULP.
- **PulpZap** (`contracts/PulpZap.sol`): buy $PULP with ETH or WETH on the Uniswap v4 pool and lock it in the
  vault, in one transaction. It also works as the destination call of a bridge.

**Status: not deployed. Not externally audited.** Both contracts went through internal (AI-assisted) reviews and a
checklist audit with an end-to-end fork run; all findings are fixed or documented ([docs/SECURITY.md](docs/SECURITY.md)).
Get an independent external audit before putting real money in.

License: [MIT](LICENSE).

---

## Background

**paperdao** is a community treasury that farms [papertrade](https://papertrade.xyz)'s PAPER together, at size.
**$PULP** is its token, launched on [daos.world](https://daos.world) on Robinhood Chain on 7 Oct 2026:
1,000,000,000 supply, 15% in a Uniswap v4 pool against ETH, each $PULP a pro rata claim on the treasury. Trades
pay a tax (now fixed at 3%) charged by the pool's hook; the token itself is a plain ERC-20 with no transfer tax.

The tax is the treasury's income. The vault pays it to holders who commit: lock $PULP, earn more $PULP and ETH
from the tax. Rewards only ever come from tax that was actually collected; nothing is minted.

## What the two contracts do

### PulpVeVault, in plain words

| | |
|---|---|
| **Lock** | Pick 10, 20 or 30 days. One lock per wallet. Locked $PULP can't be withdrawn early. |
| **Power** | amount × time left × launch bonus. A 30-day lock starts at full power, 10 days at a third. Power falls every second toward the unlock date. |
| **Launch bonus** | Locks made at launch count 2×, falling to 1× over the bonus window (24 hours in the example). A lock keeps its bonus as long as it is extended. |
| **Add / extend** | Add more $PULP (at today's bonus) while 10+ days remain. Extend any time to push the unlock date later and top power back up. |
| **Rewards** | Each funding is spread over the next 7 full UTC days; each day is shared by everyone's power during that day. A day is claimable once it ends (midnight UTC). Unclaimed rewards never expire. |
| **Compound** | Put your claimable $PULP rewards straight into your lock, minus a compound fee (at most 2%) paid to the treasury. `claim` + `increaseAmount` does the same for free in two transactions. |
| **For someone else** | `lockFor` / `increaseAmountFor` lock your $PULP into another wallet's lock; it becomes theirs. |
| **Withdraw** | After the unlock date, take the $PULP back. Rewards stay claimable. |
| **Emergency exit** | A one-way owner switch: every lock can withdraw at once and nothing new comes in. Rewards stop at the second of the switch; everything earned until then stays claimable. |

### PulpZap, in plain words

Send ETH (or approve WETH) and name a beneficiary. The zap takes its fee (at most 2%), swaps the rest for $PULP on
the $PULP / ETH Uniswap v4 pool, and opens a 10/20/30-day lock for the beneficiary in the vault, or adds to the
beneficiary's existing lock. The caller bounds everything: minimum $PULP out, an optional pool price limit, the
latest acceptable unlock time, the highest fee, and a deadline. The zap never holds funds between transactions.

Two flavours: **strict** (`zapETH`, `zapWETH`) lock or revert; **OrRefund** (`zapETHOrRefund`,
`zapWETHOrRefund`) lock, or on a genuine failure send the full input back to the beneficiary. Bridges use the
OrRefund ones.

## How rewards are funded

```
trades in the $PULP pool → tax (hook) → fee wallet ("distributor") → vault → lockers, by power
```

The distributor wallet funds rewards with:

- **`notifyRewardETH()`** with ETH attached: wrapped to WETH, which lockers claim.
- `notifyRewardAmount($PULP, amount)` after approving the vault (when $PULP is a reward token; the deploy script
  can add it).

**Each top-up is spread evenly over the next 7 full UTC days** and adds to what is already scheduled, so funding
once a week keeps every day paid (more often is fine). A top-up costs about 100k gas, up to about 280k when it is
the first to reach new days: send it with the wallet's normal gas estimate and don't cap it lower. Tokens sent
straight to the vault's address are not rewards, and ETH from any wallet that isn't a distributor is refused.

## Quick start

Node 22 (`.nvmrc`), npm.

```sh
git clone <this repo> && cd paperdao-contracts
npm ci --ignore-scripts      # exact versions from package-lock.json; no install scripts run
npm run build                # compiles with the pinned local solcjs 0.8.28 (optimizer 200, cancun); downloads nothing
npm test                     # all unit tests: vault + zap + deploy-script helpers
npm run test:soak            # longer randomized vault model runs (12 extra seeds × 160 actions)
npm run test:deploy          # the zap deploy script end to end against a local Hardhat node (needs local port binding)
npm run test:fork            # vault and zap on a local fork of Robinhood Chain mainnet (read-only)
```

`test:fork` sets `FORK=1` and reads chain state from `FORK_RPC` (default: the public
`https://rpc.mainnet.chain.robinhood.com`). It only reads; nothing is ever sent to the network. The public RPC can
rate-limit: pin a block for repeatable runs and re-run later if it throttles.

```sh
FORK_RPC=https://your-own-node.example FORK_BLOCK=84853444 npm run test:fork
npm run test:fork:vault      # or one suite at a time
npm run test:fork:zap
```

The fork runs under Hardhat's Ethereum (Cancun) rules, not Arbitrum/Orbit's: it proves token, pool and hook
behaviour, not real gas costs.

| Suite | Tests (last run, 2026-10-10) |
|---|---|
| `npm test` | 206 passing (131 vault, 70 zap, 5 zap deploy-script helpers), 21 pending (the fork and local-node suites, run by the commands below) |
| `npm run test:soak` | 16 passing |
| `npm run test:deploy` | 11 passing |
| `npm run test:fork` | vault 7 passing, zap 8 passing |

## Deploy

Deploy the **vault first, then the zap**. Both scripts run with Node and ethers; Hardhat only compiles.

**Keys are only ever typed into a hidden prompt.** They are never read from arguments, environment variables or
files, never printed and never stored; a config file with a key-like field is refused. On Robinhood Chain the
scripts refuse Hardhat's public test keys and accounts (they are 7702-delegated sweepers there). Nothing is sent
until the script has shown the plan and the cost, simulated the deployment, and you typed `deploy`.

### 1. Rehearse the vault

```sh
cp config/vault.example.json config/vault.json     # fill it in, or answer the prompts instead
npm run deploy:vault -- --config config/vault.json --dry-run
```

`--dry-run` runs every check and the simulation and shows the cost; it sends nothing. The settings:

| Setting | Meaning |
|---|---|
| `pulp` | The token to lock ($PULP: `0xBc2283d12B1f2f46c1613AE672E95C55b69Ca414`). Checked to be an ERC-20 contract. |
| `weth` | The wrapped native token rewards are paid in (`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`). Must accept ETH through `deposit()`. |
| `distributor` | The fee wallet allowed to fund rewards (`notifyRewardETH` / `notifyRewardAmount`). More can be added (`extraDistributors`). |
| `owner` | The **final owner, a multisig**. No default. On Robinhood Chain it must be a contract unless `--allow-eoa-owner`; never the deployer, $PULP, WETH or the PoolManager. |
| `treasury` | Receives the compound fee and every recovery, nothing else. No default; never a token, the PoolManager or the vault. A multisig is safest. Changing it later takes 8 days. |
| `launchStart` | The day locking opens, as a UTC date (`2026-10-20`) or unix time. **Always 00:00 UTC**, at least two hours ahead. Dates that don't exist are refused. |
| `earlyWindowHours` | The launch bonus window: 2× at launch falling to 1× over this many hours (example 24; under 1 needs `--force`). |
| `minLockAmountTokens` | The minimum new lock in whole tokens. **Default 35,000** $PULP. Fixed forever once deployed; re-check its dollar value first. It is also the cost of the `lockFor` griefing described in [docs/TECHNICAL.md](docs/TECHNICAL.md#griefing-through-lockfor). |
| `compoundFeeBps` | The compound fee in basis points (default 100 = 1%). **At most 200 (2%)**, enforced by the contract; the owner can change it within that cap and users pass the highest fee they accept. |
| `pulpRewards` | Also pay rewards in $PULP (adds $PULP as a reward token). |

### 2. Deploy the vault

```sh
npm run deploy:vault -- --config config/vault.json
```

It deploys the vault owned by the deployer, adds $PULP as a reward token if chosen, **offers** ownership to the
final owner (two-step `transferOwnership`), reads every setting back from the chain, writes a record to
`deployments/<chainId>-<vault>.json` and verifies the source on Blockscout (or prints how to do it by hand).

### 3. Hand ownership over and check it

The owner multisig calls **`acceptOwnership()`** on the vault itself, at the latest **one hour before locking
opens**. Check it:

```sh
npm run deploy:vault -- --check-handover <vault>       # add --wait-handover to wait for it
```

It reads the expected owner, deployer and treasury from the `deployments/` record (or `--owner`, `--treasury`,
`--deployer`) and exits **0** only when nothing is pending, the owner is the expected multisig (not the deployer),
no treasury change is pending and the treasury is the deployed one; **3** while ownership is offered to the right
owner before launch − 1 h; **1** otherwise (too late, wrong address, the offer step failed, an EOA owner, or a
treasury change). From then on, watch for `TreasuryProposed` events.

### 4. Rehearse and deploy the zap

```sh
cp config/zap.example.json config/zap.json
npm run deploy:zap -- --config config/zap.json --dry-run
npm run deploy:zap -- --config config/zap.json
```

| Setting | Meaning |
|---|---|
| `vault` | The vault from step 2. If the config doesn't set it, the newest vault record in `deployments/` for this chain is offered as the default (press enter), else it is asked for. The vault's emergency exit must be off and its $PULP / WETH must match. |
| `owner` | The final owner, a multisig (two-step handover like the vault: it calls `acceptOwnership()` on the zap). |
| `feeRecipient` | The treasury: receives the zap fee and anything swept. Never the vault, a token, the PoolManager or the hook. |
| `zapFeeBps` | The zap fee in basis points (default 50 = 0.5%). **At most 200 (2%)**, enforced by the contract; callers pass the highest fee they accept. |
| pool settings | On Robinhood Chain fixed defaults: PoolManager, hook, LP fee 0, tick spacing 60 and **`expectedPoolId`** `0xdd086a556aa997e79d16cde88a6fcda21f615737df3d331ca1af74642e99dc09`. The script computes the pool id from the settings and stops on any difference; the constructor checks it again (`PoolIdMismatch`), so a typo can't deploy a zap for another pool. On other chains, pass `poolManager`, `hooks`, `lpFee`, `tickSpacing` and `poolId`. |

After deploying it reads everything back and simulates a dust zap through the real pool with `eth_call`. Before
locking opens that needs a block-time override; if the node can't do it, run the read-only check after launch:

```sh
npm run deploy:zap -- --check <zap>
```

Other flags for both scripts: `--rpc <url>`, `--chain-id <id>`, `--explorer <url|none>`, `--no-verify`,
`--allow-eoa-owner`; the vault script also has `--force`, `--wait-handover` and `--site <dir>` (writes the vault
address into a frontend's `lock/config.js`). Details: [docs/TECHNICAL.md](docs/TECHNICAL.md#deploy) and
[docs/ZAP.md](docs/ZAP.md#deploying).

### Before going live

1. Get both contracts reviewed by someone outside the team.
2. Decide the distributor, the owner multisig and the treasury, and how often the distributor funds (weekly is enough).
3. Dry-run both deploys on the real chain; deploy; have the multisig accept ownership of both and check it.
4. Do one small real lock and one small zap before announcing.

## What the owner can and can't do

**Vault owner can:** pause *new* principal (locks, adds, `lockFor`, `increaseAmountFor`, `compound`; extending,
withdrawing and claiming always work), set the compound fee within 0–2%, approve distributors, add up to five
reward tokens and remove one once nothing is scheduled for it, hand ownership over (two-step), propose a new
treasury, send tokens sent here by mistake to the treasury (`recoverERC20`, `recoverExcess`), and turn on the
emergency exit, once and for good.

**Vault owner can't:** touch anyone's locked $PULP or earned rewards, send anything anywhere but the treasury,
raise the compound fee above 2% or above what a user accepted, charge a fee on claims, change lock lengths or the
bonus, stop or delay withdrawals or claims, turn the exit off, upgrade the contract, or renounce ownership.
`recoverExcess` only moves the balance above `reserved` (all principal plus every reward not yet paid), and after
every recovery the vault checks that no protected balance fell below what it owes.

**8-day treasury delay.** The treasury changes only in two steps: the owner proposes (`TreasuryProposed`), and the
new address accepts **no sooner than 8 days later**. A new proposal restarts the clock, proposing zero cancels, and
every ownership change cancels a pending proposal. The 8 days are the community's time to react: funding reaches at
most 7 days ahead, so after 8 days every day funded before the proposal has been earned; the distributor should
stop funding; and the *current* treasury can trigger recoveries to itself during the window.

**Emergency exit rules.** Once on (it can never be switched off):

- every lock can withdraw its full principal at once, whatever its unlock date;
- nothing new comes in: no locks, adds, extends, compounding or funding;
- rewards stop at the second of the switch: every closed day pays as usual, the switch day pays its budget × the
  part of the day that had passed, split by the power each lock built up until the switch, and nothing after the
  switch is paid to anyone;
- leaving costs nothing compared with staying, and no locker can change another's rewards by staying or leaving;
- the unearned rest goes back only to the treasury (anyone can release it, `recoverExcess` sweeps it). A
  compromised owner can at most stop future accrual early and send the not-yet-earned part (up to about eight days
  of funded rewards) to the treasury.
- `enableEmergencyExit` costs up to about 2.8M gas, and estimates can be about 1.3M too low: **send it with a fixed
  gas limit of at least 3.5M.**

**Zap owner can:** change the zap fee within 0–2% (never above a caller's `maxFeeBps`), change the fee recipient
(not to a protocol contract), and sweep stray tokens or ETH to the fee recipient. **Can't:** pause zaps, move user
funds, change the pool, vault or caps, or upgrade anything. Ownership is two-step; renounce is disabled.

**Withdrawals can't be blocked by the contract.** `withdraw()` reads only your own lock and the exit switch and
calls the $PULP token. It keeps working with locks paused, a hostile treasury, broken reward tokens, every
distributor removed, an ownership handover half done, years of history, and re-entrant tokens; no owner function
can move locked $PULP or delay a withdrawal. It can't get around the token refusing the transfer or the chain
refusing your transaction (see trust assumptions).

## Bridge integration

The zap can be the destination call of a bridge (Relay `txs`, Across actions) so users lock $PULP from another
chain in one action. The rules, in short (full version with addresses, encoded examples and Across recipes:
[docs/BRIDGES.md](docs/BRIDGES.md)):

- Use the **OrRefund** functions (`zapETHOrRefund`, `zapWETHOrRefund`): after funds arrive they lock, or refund
  the full input to the beneficiary on Robinhood Chain.
- The beneficiary is the user's own address, never the bridge executor; use exact amounts, not `max`.
- **Across delivers WETH to contracts**: approve WETH and call `zapWETHOrRefund`, and set **`fallbackRecipient = 0`**
  (with a fallback recipient, Across' handler swallows the zap's `InsufficientGas` and gas estimates end up paying
  the user WETH instead of locking).
- **Gas: estimate the OrRefund call (or the whole fill) and add at least 10%.** Too little gas reverts
  `InsufficientGas`; it never refunds.
- `deadline` ≤ the bridge's fill deadline, `maxUnlockTime = deadline + days × 86400`, `maxFeeBps` = the fee shown,
  swap margin and price limit at most 1%, and split orders above about 0.5 ETH (the pool is thin).

## Trust assumptions

What the contracts can't protect against. None of these is a bug in them; they are the parties and the chain.

| Who / what | What they can do |
|---|---|
| **Vault owner** (a multisig) | Pause new locks, set the compound fee (0–2%), manage reward tokens and distributors, propose a treasury (effective 8 days later at the earliest), recover strays to the treasury, and turn on the emergency exit (stopping future rewards and returning the unearned part to the treasury). Can't take principal or earned rewards. |
| **Zap owner** (a multisig) | Raise the zap fee up to 2% (within each caller's `maxFeeBps`), redirect it, sweep strays to the fee recipient. |
| **Distributor** | Decides whether, when and how much to fund. Locking is not a promise of rewards. |
| **Treasury** | Receives the compound fee, recoveries and the zap fee, and can trigger vault recoveries to itself. Can't reach principal or owed rewards. |
| **WETH** (Arbitrum `aeWETH`) | Upgradeable by the chain's UpgradeExecutor; its bridge gateway can burn any holder's WETH, including the vault's rewards. An upgrade can also change the zap's refund gas (monitor `Upgraded`). |
| **Robinhood Chain** (Arbitrum Orbit, Stage 0) | The sequencer orders transactions and sets timestamps (may lag up to 4 days or lead about an hour, shifting day boundaries); ArbOS compliance filtering can keep a screened address's `withdraw` out of blocks, and a screened fee recipient blocks zaps; no exit window for upgrades. |
| **The $PULP pool's hook owner** (an EOA) | Can redirect the 3% tax (the vault's income), or point it at a recipient that makes every swap fail (zaps then revert or refund). The tax rate itself is fixed. |
| **Uniswap v4** | The protocol fee can be switched on (at most 0.1%), slightly lowering the tax and the zap output. |
| **Bridges** (Across, Relay, LI.FI) | Pick fill time and gas: a relayer can make a fill revert or sandwich within your margin; it can't redirect funds. |
| **The $PULP token** | A plain ERC-20 today. A token that paused, blocklisted the vault or charged a transfer fee could block withdrawals. |

Reward tokens must be plain ERC-20s (no blocklist, pause, rebase, fee on transfer, admin burn, or second address
for the same balances). Details: [docs/TECHNICAL.md](docs/TECHNICAL.md#roles-asset-assumptions-and-limits) and
[docs/ZAP.md](docs/ZAP.md#trust-assumptions-chain-and-third-parties).

## Security status

- Two internal security reviews (2026-10-09, 2026-10-10) and a checklist audit across 11 EVM checklists with an
  end-to-end run on a fork of Robinhood Chain (38 simulated days, 630 transactions, every invariant held), followed
  by a re-review of the fixes. All AI-assisted, done for the project; **none of it is an external audit**.
- Results: no Critical or High findings at any stage. The audit's three Mediums (exit-day/treasury owner trust,
  bridge gas estimation, sandwiches on a thin pool) and all Lows are fixed or documented, and the re-review's three
  Lows are fixed.
- Tests on the final sources: see the table under Quick start.

Full findings, fixes and evidence: [docs/SECURITY.md](docs/SECURITY.md).

## Addresses on Robinhood Chain (4663)

| | Address |
|---|---|
| $PULP | `0xBc2283d12B1f2f46c1613AE672E95C55b69Ca414` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap v4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| $PULP pool hook | `0x4Bc7Ba3a253d048Dc36C17Ac3f4E6484dAD120CC` |
| $PULP / ETH pool id (ETH, $PULP, LP fee 0, tick spacing 60, hook above) | `0xdd086a556aa997e79d16cde88a6fcda21f615737df3d331ca1af74642e99dc09` |
| Uniswap v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| Uniswap v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| PulpVeVault | not deployed yet |
| PulpZap | not deployed yet |

Public RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `https://robinhoodchain.blockscout.com`.

## Forking for another token or chain

The contracts take every address as a constructor argument, so they need no code change for another plain ERC-20
token paired with native ETH on a Uniswap v4 chain. What to change:

- **Vault:** nothing in the contract. Pass your token, wrapped native token, distributor, owner, treasury, launch
  day, bonus window, minimum lock (in your token's units: the deploy script asks in whole tokens) and compound fee.
  The token and every reward token must be plain ERC-20s. Lock lengths (10/20/30 days), the 7-day reward spread,
  the 2% fee cap and the 8-day treasury delay are constants in `PulpVeVault.sol`.
- **Zap:** pass the PoolManager, vault, WETH, hook, LP fee, tick spacing and the expected pool id. The zap assumes
  a pool of **native ETH (currency0) against the vault's token** and swaps ETH → token exact-input; other pairs
  need code changes. `REFUND_GAS_RESERVE` (250k) is calibrated to Robinhood's WETH; re-measure for yours.
- **Deploy scripts:** `ROBINHOOD` (RPC, chain id, explorer) and `KNOWN_ADDRESSES` in `scripts/deploy-vault.js`;
  `ROBINHOOD` and `KNOWN[4663]` (token, WETH, PoolManager, hook, LP fee, tick spacing, pool id, Quoter) in
  `scripts/deploy-zap.js`. Chains without a `KNOWN` entry are asked for the pool settings and pool id.
- **Hardhat config:** in `hardhat.config.js`, the fork chain id (4663), the hardfork history entry and the default
  `FORK_RPC`.
- **Fork tests:** the addresses at the top of `test/vault/fork.test.js` and `test/zap/fork.test.js`, and the
  funding source they impersonate for test tokens.
- **Docs:** the addresses above, the 3% tax figures, and the bridge addresses in `docs/BRIDGES.md`.

## Layout

| Path | What |
|---|---|
| `contracts/PulpVeVault.sol` | The vault (sha256 `a8bb34b40faec1de7913a38222b645bf4914fae63afc18b54743265ca7c9f0d4`) |
| `contracts/PulpZap.sol` | The zap (sha256 `871cbf4865ca76c1bd567124fd414deaa87a46c1798c11262002f4cf5897c042`) |
| `contracts/interfaces/` | `IPulpVeVault` (the vault functions the zap uses, plus WETH9) and minimal Uniswap v4 types (`IUniswapV4`) |
| `contracts/test/` | Test-only mocks: tokens (plain, fee-on-transfer, false-return, blocking, pausable, re-entrant, two-address, breakable), `MockWETH`, `MockWETH9`, a mock v4 PoolManager, bridge executor, hostile receivers. Never deployed by the scripts |
| `scripts/deploy-vault.js`, `scripts/deploy-zap.js` | Deploy scripts (hidden-prompt keys, dry run, checks, read-back, verification) |
| `config/*.example.json` | Settings file shapes for `--config` |
| `deployments/` | Deployment records written by the scripts (gitignored) |
| `test/vault/`, `test/zap/` | Unit, randomized-model, deploy-script and opt-in fork tests |
| `docs/TECHNICAL.md` | Vault design: accounting, daily settlement, emergency exit, limits, gas |
| `docs/ZAP.md` | Zap design: swap path, price limit, entry points, fees, gas, sandwiches, monitoring |
| `docs/BRIDGES.md` | Bridge options into Robinhood Chain and the rules for calling the zap from a bridge |
| `docs/SECURITY.md` | Reviews, audit findings, fixes and test evidence |
