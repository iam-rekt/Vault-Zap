# PulpZap: design

`contracts/PulpZap.sol` buys $PULP with ETH (or WETH) on Robinhood Chain (4663) and locks it in `PulpVeVault`
for a beneficiary in one transaction, or adds it to the beneficiary's existing lock. The same contract covers
"reinvest ETH rewards" (claim WETH from the vault, zap it) and works as the destination call of a bridge
(Relay `txs`, Across actions; see [BRIDGES.md](BRIDGES.md)).

**Status: not deployed, not externally audited.** Finding IDs (M-1, L-3, CB-2, AMM-2, ...) refer to the internal
reviews and the 2026-10-10 audit summarised in [SECURITY.md](SECURITY.md).

The zap depends on the vault only through the functions in `contracts/interfaces/IPulpVeVault.sol` (`pulp`,
`minLockAmount`, `launchStart`, `locksPaused`, `emergencyExit`, `MIN_LOCK_TIME`, `locks`, `lockFor`,
`increaseAmountFor`), not on the vault's constructor `Config`, compound fee or treasury. The Uniswap v4 types it
needs are minimal local copies in `contracts/interfaces/IUniswapV4.sol` (layouts match v4-core).

## Design

### Swap path: direct PoolManager, not the Universal Router

The zap calls `PoolManager.unlock`, and in `unlockCallback` does exactly one `swap` (ETH -> PULP, exact input),
`sync(address(0))`, `settle{value: amountIn}()` and `take(PULP, zap, out)`. The `sync(native)` right before
`settle` is there because `settle` pays whatever currency is globally synced and `sync` is permissionless: the
hook, or a party the hook forwards ETH to, could leave a `sync(PULP)` dangling inside our unlock window, which
would make a native `settle{value}` revert `NonzeroNativeValue` and DoS every zap (review L-3). v4-periphery's
`DeltaResolver` does the same. **This fixes one variant only** (audit GA-2): code that runs inside the swap
(the hook, or its tax recipient) can still halt swaps in other ways, for example a tax recipient that reverts or
burns gas (audit AMM-2). Then strict zaps revert and OrRefund zaps refund (or revert `InsufficientGas` if it
burns the hop's whole gas). That is a trust assumption on the hook owner (see "Trust assumptions").

Reasons for the direct path:

- Smaller audit surface: ~30 lines against six PoolManager functions. The Universal Router path would add
  command/action byte encoding (`V4_SWAP` + `SWAP_EXACT_IN_SINGLE`/`SETTLE_ALL`/`TAKE_ALL`), the router's own
  ETH/token sweeping rules and, for WETH, Permit2 approvals. None of that is needed for one fixed pool.
- Exact deltas: the zap sees the `BalanceDelta` the PoolManager returns (which includes the hook's
  return-deltas, the hook address has beforeSwap/afterSwap return-delta flags) and verifies it:
  ETH delta must be exactly `-amountIn` (no partial fill, no extra charge) and PULP delta must be positive;
  then the PULP balance must have grown by at least the delta. Exactly the delta is locked; anything pushed in
  on top during the swap is a stray for `sweep` (audit DOS-1: with `!=` a 1-wei push from the hook or its fee
  recipient made every zap revert).
- No approvals to the router or Permit2, and native ETH settles with `sync(0)` + `settle{value}`.

The zap must be called **at top level, not from inside another contract's v4 unlock** (audit EF-6): the
PoolManager allows one unlock at a time, so the zap's own `unlock` would revert. Bridge executors and wallets
call it directly, which is fine.

### Price limit (`minSqrtPriceX96`)

Every entry point takes an optional `minSqrtPriceX96` (0 = no limit), passed to the swap as `sqrtPriceLimitX96`
(audit M-C). Selling ETH lowers the pool's `sqrtPriceX96` (PULP per ETH, Q64.96); the limit is the lowest price
the caller accepts the pool to reach. Checks:

- `0 < limit` must be in `(MIN_SQRT_PRICE, MAX_SQRT_PRICE)`, else `InvalidPriceLimit(limit)` (before the swap).
- The current price must be above the limit, else `PriceLimitReached(price, limit)` before the fee and the swap
  (a front-run already moved it). `sqrtPriceX96()` reads the pool's slot0 from the PoolManager (`extsload`),
  and `checkBeneficiary` runs the same check.
- If the swap would cross the limit, v4 stops at it (a partial fill) and the zap reverts
  `PriceLimitReached(limit, limit)`: no partial fills are kept. OrRefund zaps refund with that reason.

`minPulpOut` bounds the output; the price limit bounds how far anyone can push the pool before (or during) the
zap, which caps sandwich profit independently of the output margin (see "Sandwiches"). With no limit the swap
uses `MIN_SQRT_PRICE + 1` as before.

**Computing a limit.** Read `p0 = zap.sqrtPriceX96()` and quote the zap with the v4 Quoter (`quoteExactInputSingle`
on `amountIn - fee`). Inside one liquidity range the execution price is the geometric mean of the start and end
prices, so the price after your own swap is `p1 ≈ p0 × exec / spot`, where `spot = (p0 / 2^96)^2` and
`exec = quotedOut / (0.97 × (amountIn − fee))` (gross PULP per ETH before the 3% tax). Then allow your tolerance
`t` (e.g. 0.5%): `minSqrtPriceX96 = p1 × sqrt(1 − t)`. A simpler, slightly looser rule:
`minSqrtPriceX96 = p0 × sqrt(1 − (expected price move + t))`. Round down (a lower limit is looser).

### Entry points

```solidity
// Strict: lock everything bought or revert.
function zapETH(address beneficiary, uint256 daysLocked, uint256 minPulpOut, uint160 minSqrtPriceX96,
    uint256 maxUnlockTime, uint16 maxFeeBps, uint256 deadline) external payable returns (uint256 pulpLocked);
function zapWETH(address beneficiary, uint256 wethAmount, uint256 daysLocked, uint256 minPulpOut,
    uint160 minSqrtPriceX96, uint256 maxUnlockTime, uint16 maxFeeBps, uint256 deadline)
    external returns (uint256 pulpLocked);              // wethAmount = type(uint256).max: caller's whole WETH balance

// Non-reverting after funds arrive (for bridges): lock, or send the full input to the beneficiary.
function zapETHOrRefund(address beneficiary, uint256 daysLocked, uint256 minPulpOut, uint160 minSqrtPriceX96,
    uint256 maxUnlockTime, uint16 maxFeeBps, uint256 deadline) external payable returns (bool locked, uint256 pulpLocked);
function zapWETHOrRefund(address beneficiary, uint256 wethAmount, uint256 daysLocked, uint256 minPulpOut,
    uint160 minSqrtPriceX96, uint256 maxUnlockTime, uint16 maxFeeBps, uint256 deadline)
    external returns (bool locked, uint256 pulpLocked);

// Views
function checkBeneficiary(address beneficiary, uint256 daysLocked, uint256 minPulpOut, uint160 minSqrtPriceX96,
    uint256 maxUnlockTime) external view returns (bool newLock); // every pre-swap check except fee bound and deadline
function sqrtPriceX96() external view returns (uint160);      // the pool's current price (slot0 via extsload)
function quoteFee(uint256 amountIn) external view returns (uint256 fee, uint256 net);
function poolKey() external view returns (PoolKey memory);
function zapFeeBps() external view returns (uint16);
function feeRecipient() external view returns (address);
uint16 public constant MAX_ZAP_FEE_BPS = 200;

// Owner (Ownable2Step): the fee, its recipient, and sweeping strays to that recipient; nothing else.
function setZapFee(uint16 newBps) external;              // <= MAX_ZAP_FEE_BPS; > 0 needs a recipient
function setFeeRecipient(address newRecipient) external; // not zero, the zap, vault, WETH, PULP, PoolManager or hook
function sweep(address token) external;                  // whole balance (address(0) = ETH) to feeRecipient; nonReentrant
function transferOwnership(address) external; function acceptOwnership() external; // renounceOwnership reverts
```

Selectors:

| Function | Signature | Selector |
|---|---|---|
| `zapETH` | `(address,uint256,uint256,uint160,uint256,uint16,uint256)` | `0x72eef5ee` |
| `zapWETH` | `(address,uint256,uint256,uint256,uint160,uint256,uint16,uint256)` | `0x035c2287` |
| `zapETHOrRefund` | `(address,uint256,uint256,uint160,uint256,uint16,uint256)` | `0x11e47402` |
| `zapWETHOrRefund` | `(address,uint256,uint256,uint256,uint160,uint256,uint16,uint256)` | `0xb2ba783d` |
| `checkBeneficiary` | `(address,uint256,uint256,uint160,uint256)` | `0xd13757e1` |
| `sqrtPriceX96` | `()` | `0x8db791d2` |
| `quoteFee` | `(uint256)` | `0x2205f568` |
| `setZapFee` | `(uint16)` | `0xa199eefc` |
| `setFeeRecipient` | `(address)` | `0xe74b981b` |
| `sweep` | `(address)` | `0x01681a62` |
| `selfZap` (internal hop) | `(address,uint256,(address,uint256,uint256,uint160,uint256,uint16,uint256))` | `0xb32431f4` |

`selfZap` reverts `OnlySelf` for anyone but the zap.

Rules (checked before any swap, mirroring the vault):

- `beneficiary` must not be zero, the zap, the vault, WETH, PULP, the PoolManager or the hook (`InvalidBeneficiary`):
  none of them can ever withdraw a lock, and a refund to WETH would be minted back to the zap and stranded.
- No lock: opens a new lock of `daysLocked` in {10, 20, 30}; `minPulpOut >= vault.minLockAmount()`.
- Active lock with >= 10 days left: the PULP is added (`increaseAmountFor`); `daysLocked` is ignored and the
  unlock time does not move.
- Active lock with < 10 days left: `LockEndsTooSoon` (beneficiary must `extend` first).
- Expired lock not withdrawn: `LockExpiredWithdrawFirst` (beneficiary must `withdraw` first).
- `maxUnlockTime`: the lock end after the zap must be `<= maxUnlockTime`, else `UnlockTooLate(lockEnd,
  maxUnlockTime)`. Checked before the swap (existing lock: its `end`; new lock: `now + daysLocked days`) and
  again on what the vault recorded after the lock call. This stops a lock planted for the beneficiary from
  silently absorbing a "10-day" zap for 30 days (review M-1). For a new lock pass
  **`maxUnlockTime = deadline + daysLocked × 86400`**: that is exactly the latest end any execution before the
  deadline can produce (audit CB-5), so it never refunds a valid fill. For a top-up pass the displayed `end`.
  `type(uint256).max` disables the bound (not recommended).
- `maxFeeBps`: `zapFeeBps > maxFeeBps` reverts `FeeAboveMax(zapFeeBps, maxFeeBps)` before the swap (review L-5).
- `minSqrtPriceX96`: see "Price limit" (`InvalidPriceLimit`, `PriceLimitReached`).
- Also: `DeadlineExpired`, `ZeroAmount`, `ZeroMinOut` (minPulpOut must be > 0), `LocksPaused`, `NotLaunched`.
- Vault emergency exit on: `EmergencyExitActive` (same selector as the vault's), checked before the swap and in
  `checkBeneficiary`.
- After the swap: `InsufficientOutput(out, minPulpOut)`. `minPulpOut` is net of the zap fee and the hook tax
  (what actually gets locked). Get `(fee, net) = quoteFee(amountIn)`, quote the pool with the v4 Quoter
  `quoteExactInputSingle(net)` (it includes the hook's tax, verified on the fork) and subtract a slippage margin.

Constructor: `(poolManager, vault, weth, hooks, fee, tickSpacing, expectedPoolId, owner, zapFeeBps, feeRecipient)`.
PULP is read from `vault.pulp()`, `currency0` is native ETH; `fee` is the pool's LP fee, not the zap fee. The
constructor computes the pool id and reverts `PoolIdMismatch(computed, expected)` unless it equals
`expectedPoolId` (audit GA-4/AC-7: a typo in the hook, fee or tick spacing cannot deploy a zap for another pool).
For Robinhood: `(0x8366a39cc670b4001a1121b8f6a443a643e40951, <vault>, 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,
0x4Bc7Ba3a253d048Dc36C17Ac3f4E6484dAD120CC, 0, 60,
0xdd086a556aa997e79d16cde88a6fcda21f615737df3d331ca1af74642e99dc09, <deployer>, 50, <treasury>)`, then a
two-step handover to the owner multisig. Use `scripts/deploy-zap.js` (below), which does all of that and checks it.

Events: `Zapped(caller, beneficiary, tokenIn, amountIn, feeAmount, pulpLocked, newLock, lockEnd)` (`amountIn`
is gross, `amountIn - feeAmount` was swapped; `caller` is the outer `msg.sender` on every path, e.g. the bridge
executor), `FeePaid(recipient, token, amount)` (only when fee > 0),
`Refunded(caller, beneficiary, token, amount, reason)` (token `address(0)` = ETH), and the owner events
`ZapFeeSet(oldBps, newBps)`, `FeeRecipientSet(oldRecipient, newRecipient)` (also emitted by the constructor),
`Swept(token, to, amount)`, plus OZ `OwnershipTransferStarted`/`OwnershipTransferred`. The vault also emits
`Locked`/`Increased` and `DepositedFor(payer = zap, beneficiary, amount)`.

**`Refunded.reason`** is the 4-byte selector of the revert that stopped the lock: one of the zap's errors
(`InsufficientOutput`, `PriceLimitReached`, `UnlockTooLate`, `FeeAboveMax`, `DeadlineExpired`, `LockEndsTooSoon`,
`EmergencyExitActive`, ...), a vault error, or a PoolManager/hook error (v4 wraps hook reverts in `WrappedError`).
`0x00000000` means the revert carried no data: an inner call ran out of gas, or something reverted without a
reason. A hop that ran out of gas itself is never refunded (see "Gas").

Errors: `FeeTooHigh(bps)`, `InvalidFeeRecipient()`, `RenounceDisabled()`, `UnlockTooLate(lockEnd, maxUnlockTime)`,
`FeeAboveMax(feeBps, maxFeeBps)`, `EmergencyExitActive()`, `InsufficientGas()`, `InvalidRecipient()` (sweep with no
fee recipient set), plus OZ `OwnableUnauthorizedAccount`/`OwnableInvalidOwner`/`FailedCall`/`InsufficientBalance`.
`InvalidPriceLimit(uint160)` `0xf80ef53b`, `PriceLimitReached(uint160,uint160)`
`0xe1fba2ad`, `PoolIdMismatch(bytes32,bytes32)` `0xb46bf886`. `InsufficientGas()` `0x1c26714c` also covers
"the hop ran out of gas".

### Fees

- `fee = amountIn * zapFeeBps / 10_000`, rounded down (in the user's favour), via `Math.mulDiv` so `quoteFee`
  never overflows. Only `amountIn - fee` is swapped. With the intended 50 bps, 0.001 ETH pays 0.000005 ETH.
- Taken from the input, before the swap: ETH for `zapETH`/`zapETHOrRefund`, WETH for `zapWETH`/`zapWETHOrRefund`
  (the WETH fee is transferred as WETH, only the rest is unwrapped).
- `zapFeeBps <= MAX_ZAP_FEE_BPS = 200` (2%), enforced in the constructor and in `setZapFee`. A non-zero fee
  needs a recipient. Fee 0 skips all fee code (no transfer, no `FeePaid`).
- **ETH fee to a recipient that refuses ETH:** the zap sends ETH with a 50,000 gas cap and without copying
  return data; if that call fails for any reason (revert, no `receive`, out of gas) it wraps the fee and
  transfers WETH instead, so the recipient can neither block a zap nor make it refund. Re-entry from the
  recipient hits `nonReentrant`.
- **OrRefund:** the fee is paid inside the `selfZap` hop. If anything after it fails, the whole hop reverts,
  the fee payment is rolled back, and the beneficiary gets the entire input. No fee is charged when nothing is
  locked.
- The fee is read at execution time; `maxFeeBps` (the fee at quote time) makes a raise after the quote revert
  or refund (`FeeAboveMax`). The website should quote with `quoteFee` and pass the `zapFeeBps()` it showed.

### Owner powers

The owner (two-step transfer via `transferOwnership` + `acceptOwnership`; renounce disabled) can only:
change `zapFeeBps` within the 2% cap (bounded per call by the caller's `maxFeeBps`), change `feeRecipient`, and
`sweep(token)` the zap's whole balance of a token or ETH **to the fee recipient**. The fee recipient may not be
zero, the zap, the vault, WETH, PULP, the PoolManager or the hook, the same deny-list as beneficiaries (audit
AC-5; any of them would strand the fee or the sweep). `sweep` has no destination argument (audit AC-6): strays
can only go to the treasury, and moving the treasury emits `FeeRecipientSet`, which monitoring should alert on.
Sweep only ever sees strays: the zap holds no user funds between transactions, and `sweep` is `nonReentrant`,
so it cannot run inside a zap. The owner cannot pause zaps, move user funds, change the pool, vault, slippage
checks or the cap, or upgrade anything. Use a multisig: a compromised owner can take 2% of every zap (within
each caller's `maxFeeBps`) until it is rotated.

### Deploying

`npm run deploy:zap -- --dry-run` rehearses, `npm run deploy:zap` deploys (`scripts/deploy-zap.js`, modelled on the vault's):

- The deployer key is typed into a hidden prompt; it is never read from arguments, environment variables or
  files, never printed and never stored. Settings can come from `--config <file>` (`config/zap.example.json`); a
  config with a key-like field is refused.
- The vault address comes from the config file, else the newest vault record that `npm run deploy:vault` wrote
  to `deployments/` for this chain is offered as the default (press enter to accept), else it is asked for.
- On Robinhood Chain the PULP, WETH, PoolManager, hook, LP fee 0, tick spacing 60 and the pool id
  `0xdd086a556aa997e79d16cde88a6fcda21f615737df3d331ca1af74642e99dc09` are fixed defaults; the computed id must
  match before anything is sent, the vault's `pulp()`/`weth()` must match, the pool must be initialized, and the
  vault's emergency exit must be off.
- No owner default: the final owner is required. On 4663 it must be a contract (multisig) unless
  `--allow-eoa-owner`. The zap is deployed owned by the deployer, then ownership is offered to the owner
  (two-step; the owner calls `acceptOwnership`). Hardhat's public test keys/accounts are refused for every role
  on 4663 (they are 7702-delegated on mainnet).
- Zap fee default 50 bps; the fee recipient (the treasury) is required and is checked against the deny-list.
- It simulates the deployment, shows the plan and the cost, and sends nothing until you type `deploy`.
- After deploying it reads everything back (pool id, key, vault/PULP/WETH matching the vault, fee, recipient,
  owner/pendingOwner, cap, minimum lock, launch) and simulates a dust zap with `eth_call`: a strict 0.000001 ETH
  `zapETH` must get through the real swap and revert `InsufficientOutput(pulpOut > 0, minLock)` (on 4663 the
  output must equal the v4 Quoter's), and the OrRefund variant must refund. Before the vault opens the
  simulation needs an `eth_call` block-time override; if the node does not support it the simulation is
  reported as skipped and you run `npm run deploy:zap -- --check <zap>` after launch (read-only, no key).

### How users call it

- Buy and lock from a wallet: `zapETH(me, 30, quote * 99 / 100, limit, deadline + 30 days, zapFeeBps(),
  deadline)` with `value`, `deadline = now + 10 min`, `limit` from "Price limit" (or 0). For a top-up use the
  existing lock's displayed `end` as `maxUnlockTime`.
- Gift a lock: same with someone else's address. Note this is permanent for them: once they have a lock,
  their own `lock()` reverts `LockExists` and they add with `increaseAmount` instead (vault semantics).
- Reinvest WETH rewards: `vault.claim(WETH, 64)`, `WETH.approve(zap, amount)`, then
  `zapWETH(me, type(uint256).max, 0, minOut, limit, lockEnd, zapFeeBps(), deadline)`. The zap cannot claim for
  the user because the vault pays rewards to `msg.sender`.
- Frontends should call `checkBeneficiary(beneficiary, days, minOut, limit, maxUnlockTime)` first, and before
  signing `eth_call` the real zap (not just the Quoter): a hook that halts swaps (AMM-2) only shows up there.
- Show the price impact; warn above ~2% or ~0.5 ETH, block above ~5% (audit M-C). Default to tight slippage.

### How bridges call it

The lock owner is always the explicit `beneficiary`, never `msg.sender`, so the caller can be a bridge
executor/multicaller. Use the `OrRefund` entry points and follow [BRIDGES.md](BRIDGES.md) section 4 (Across
recipes, addresses on 4663, deadlines, price limit, gas). In short:

- **Across delivers WETH, not ETH, to a contract recipient** (the MulticallHandler), so the old "native
  `makeCallWithBalance` -> `zapETHOrRefund`" recipe never locked (audit CB-2). Use `WETH.approve(zap, amount)` +
  `zapWETHOrRefund(user, amount, ...)` with **`fallbackRecipient = 0`**, or unwrap first (recipe in [BRIDGES.md](BRIDGES.md)).
  With a fallback recipient the handler catches the zap's `InsufficientGas`, gas estimates land on that catch and
  the user gets WETH instead of a lock (measured through the real Across contracts).
- Gas: estimate the fill (or the OrRefund call) and add at least 10%. An exact estimate can fall ~40k short,
  because the vault's gas depends on where the lock's end falls in its 10-minute bucket; too little gas reverts
  (`InsufficientGas`), never refunds.
- `deadline <=` the bridge's `fillDeadline`; `maxUnlockTime = deadline + days × 86400`. A fill after `deadline`
  (but before `fillDeadline`) **refunds on Robinhood Chain**, not on the origin chain.
- Bridge swap margin (`minPulpOut` and the price limit) at most 1%; split large orders (see "Sandwiches").

### Gas

The OrRefund functions run the zap in an internal `selfZap` hop with all gas but `REFUND_GAS_RESERVE`
(250,000), kept back for the refund. **If the hop failed because it ran out of gas, the call reverts
`InsufficientGas` instead of refunding** (audit M-B). Before this fix the cheapest non-reverting outcome of an
OrRefund call was a refund, so `eth_estimateGas`, the bridges' simulators and Robinhood's own node all sized
the refund, and every bridged zap refunded (reproduced through the real Across and Relay contracts). Now the
gas estimate of the OrRefund call itself lands on the lock path, or on a genuine refund when the zap really
cannot lock (price, deadline, bounds, pause, pool or hook revert):

- **Estimate the OrRefund call itself with `eth_estimateGas` and add ~10% headroom.** The headroom covers
  state changes between estimate and fill: a new lock created a second after 00:00 UTC schedules one more day
  than one created at 00:00:00 (~70k gas), other locks or swaps change the pool's tick crossings, and so on.
  Bridges' own simulators (Across relayers, Relay solvers) now see the lock too.
- "Ran out of gas" means the failed hop left less than 1/8 of its gas unused. An out-of-gas k calls below the
  hop leaves at most `1 − (63/64)^k` of it (each frame keeps 1/64 back and hands it back when it reverts), so
  1/8 covers out-of-gas up to 8 calls deep (the swap path is ~6 deep). The prototype's `hop/63` only covered
  the hop's direct callees: an out-of-gas inside the swap or the hook still refunded, which the test with an
  expensive hook shows as a ~1.1M-gas-wide refund window below the lock's gas. The price: a genuine failure is
  refunded only if it used less than 7/8 of the hop. Real failures happen at or before the swap, far below a
  lock's gas.
- With less gas than needed for the lock, or less than ~250k, the call reverts `InsufficientGas` and takes
  nothing; the bridge's own rules apply (Across: the relayer cannot fill, and the deposit is refunded on origin
  after `fillDeadline`).
- A hook (or its tax recipient) that burns all the hop's gas makes OrRefund calls revert `InsufficientGas` at
  every gas limit, instead of refunding (it is indistinguishable from too little gas). Strict calls revert too.
  This is the AMM-2 trust assumption.
- Figures. End-to-end run on real chain state (E2E-2): zap new lock ~1.35M average, up to ~1.95M; top-up
  ~0.46M average, up to ~0.57M; bridged 30-day zap through an executor 1.89–1.92M. This fork run (block
  84,643,000, 0.001 ETH, 50 bps fee), OrRefund estimate -> gas used, all `Zapped` at exactly the estimate:
  new 10-day 1,142,460 -> 850,203; new 30-day 2,186,642 -> 1,878,457; top-up 869,844 -> 583,696; WETH new
  30-day 2,251,280 -> 1,914,709; WETH top-up 933,986 -> 614,259; impossible `minOut` 458,371 -> 195,571
  (`Refunded`). The estimate is higher than the gas used because the 250k reserve and the 1/8 margin must be
  available, not spent.
- Refunds of ETH go out with a 50,000-gas cap and no returndata copy, falling back to WETH (like the fee).

**Strict vs OrRefund.** If a strict zap reverts, the funds stay with the bridge and its refund rules apply.
Bridges should use the `OrRefund` entry points: any genuine failure after the funds arrive is rolled back
atomically and the full input goes to the beneficiary on Robinhood Chain as ETH (WETH if the beneficiary
cannot receive ETH within 50,000 gas) or as WETH for the WETH entry point. They revert, before taking anything,
for a zero amount, an unusable beneficiary, too little gas, or if the WETH pull fails. A refunded user holds
ETH/WETH on Robinhood instead of a lock and has to retry; the UI must say so.

### Sandwiches

The pool is thin: on the fork 0.01 ETH moved `sqrtPriceX96` by 0.035% (price ~0.07%), and 1 ETH moves the
price ~7% (audit AMM-1/EF-2). Bridge zaps are visible on the origin chain before they fill, so a third party
can buy PULP ahead of the fill and sell after it. Even with the 3% tax each way that is profitable from about
1 ETH upward, and **the hook's tax recipient (the fee wallet `0x3fae…832b`, an EOA) gets its own tax back, so it
profits at any size**. The victim always loses its full tolerance: whatever `minPulpOut` leaves on the table is
what a sandwich takes. Direct zaps on Robinhood are exposed mainly to the sequencer (no public mempool).

Rules: keep the bridge swap margin (`minPulpOut` below the quote, and the price limit below the expected
post-swap price) at **1% or less**; split orders above ~0.5 ETH into several fills; show the price impact and
block above ~5%. The fee wallet should never trade (or the hook owner should point the tax at a non-trading
forwarder).

## Trust assumptions (chain and third parties)

| Party | What it can do | Effect on the zap |
|---|---|---|
| Hook owner (EOA `0xbf63…564d`) | Redirect the 3% tax (`setFeeRecipient`); the hook still has `renounceOwnership` | A hostile tax recipient can halt every swap on the pool (AMM-2): strict zaps revert, OrRefund refunds (or reverts `InsufficientGas` if it burns gas). Ask the owner to use a multisig; monitor the hook's recipient |
| The PULP tax | **Fixed at 3% forever**: `currentFeeBips(pulp) = 300`, `registerLaunch` reverts `AlreadyLaunched`, nothing else writes it, the hook is not upgradeable or pausable (audit AMM-4) | Only the recipient can change, not the rate |
| WETH (`0x0Bd7…AD73`, Arbitrum `aeWETH`) | Upgradeable by the chain's UpgradeExecutor; its bridge gateway can burn any holder's WETH | An upgrade can change gas costs (see "Monitoring"); a gateway burn can take WETH held by anyone, including the vault's rewards |
| Robinhood Chain sequencer | ArbOS compliance filtering: a screened address cannot get transactions included. Timestamps may lag up to 4 days or lead by 1 hour. Stage 0, no exit window | A screened beneficiary cannot `withdraw`; a screened fee recipient (the zap's or the hook's) blocks every zap |
| Uniswap v4 | The protocol fee can be turned on (≤ 0.1%) | Slightly less PULP per zap; covered by `minPulpOut` |
| Bridges (Across, Relay, LI.FI) | Pick fill time and gas | A relayer can make a fill revert (`InsufficientGas`) or sandwich within your margin; it cannot redirect funds |

## Monitoring

- **WETH `Upgraded(address)` on `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`** (audit GA-1). `REFUND_GAS_RESERVE`
  (250k) is calibrated to today's WETH: the worst refund (a beneficiary that burns its 50k ETH gas, then the WETH
  fallback to a fresh holder through the WETH proxy) measured 137,000 gas in the catch branch. An upgrade that
  adds ~100k to WETH's deposit/transfer would make some refunds revert. After any `Upgraded` event, re-run
  `npm run test:fork:zap` (the "genuine failure refunds a gas burner in WETH" test) and re-measure the catch path by
  trace; if it nears 250k, stop routing bridges to the OrRefund functions and deploy a zap with a bigger reserve.
- The zap's `FeeRecipientSet`, `ZapFeeSet`, `OwnershipTransferStarted`, `Swept`.
- The hook's tax recipient and owner; `currentFeeBips(pulp)` (must stay 300).
- Refund rate and `Refunded.reason` per bridge route (a spike in `0x00000000` or `WrappedError` means the pool
  or hook is misbehaving).

## Safety properties

- Minimal state: the fee (capped at 2%), its recipient and Ownable2Step's owner/pendingOwner; everything else
  is immutable. No upgradeability, no pause, no admin access to user funds.
- Never holds funds between transactions: every path pays the fee out and locks all PULP bought, reverts, or
  refunds the full input. Tests assert zero ETH/PULP/WETH balance and zero vault allowance after every call
  (except the deliberate stray tests).
- Exact approvals: `forceApprove(vault, pulpOut)` before `lockFor`/`increaseAmountFor`, reset to 0 after.
- `nonReentrant` on all four entry points and `sweep`. `selfZap` reverts unless `msg.sender == address(this)`;
  `unlockCallback` reverts unless called by the PoolManager.
- `receive()` accepts ETH only when `msg.sender == WETH`; Robinhood WETH's `withdrawTo` lets anyone push ETH in
  anyway (verified on the fork), as do `selfdestruct` and direct token transfers. Strays never enter a zap's
  amounts and are swept to the treasury.
- Swap deltas verified (full exact-input fill, positive output; a stop at the caller's price limit reverts)
  and the PULP balance checked to have grown by at least the output.
- WETH pull uses a balance-delta check; `wethAmount = max` only ever pulls from `msg.sender`.

## Tests

| Command | What |
|---|---|
| `npm test` (zap part: `test/zap/zap.test.js`, `test/zap/deploy.test.js`) | 70 unit tests against the real vault and a mock PoolManager (`contracts/test/ZapMocks.sol`), plus 5 deploy-script helper tests |
| `npm run test:deploy` | the deploy script end to end against a local Hardhat node it spawns on 127.0.0.1 (Hardhat test keys only; needs local port binding): 11 tests including the helpers |
| `npm run test:fork:zap` | 8 tests on a local fork of Robinhood Chain mainnet with the real PoolManager, hook, pool, WETH and Quoter (reads the public RPC; pin with `FORK_BLOCK=<n>`; re-run if the RPC rate-limits) |

What the unit tests cover, by finding: constructor `PoolIdMismatch` (GA-4); every deny-listed fee recipient
refused (AC-5); `sweep` only to the fee recipient, owner-only, not mid-zap (AC-6, I-1); out-of-gas hops revert
`InsufficientGas` for ETH and WETH, a gas sweep with a gas-burning beneficiary only ever sees `InsufficientGas`
then lock (or refund for an impossible order), `eth_estimateGas` on the OrRefund call sent at exactly the
estimate locks, an out-of-gas four calls below the hop is `InsufficientGas` too (M-B); the price limit (M-C);
a 1-wei PULP push mid-swap no longer blocks zaps (DOS-1); `maxUnlockTime` against planted locks (M-1); `maxFeeBps`
(L-5); the dangling `sync` (L-3); unusable beneficiaries (L-2); hostile and gas-burning beneficiaries (L-4); the
emergency-exit pre-check (I-2); `Zapped.caller` through bridge executors (L-1); and the original behaviour (new
locks of 10/20/30 days, top-ups, boundaries, slippage, deadlines, pause, pre-launch, partial fills, reentrancy from
the pool and from token hooks, access control on `unlockCallback` and `selfZap`). Every test asserts the zap ends
with zero ETH, PULP and WETH and a zero vault allowance, except the deliberate stray tests.

The fork test checks: the real pool id and `PoolIdMismatch`; `sqrtPriceX96()` through `extsload`; a 0.001 ETH
`zapETH` locks exactly the v4 Quoter's output for `amountIn − fee`; a WETH top-up; an impossible-minOut refund;
M-B with the real WETH (gas sweep `InsufficientGas` then `lock`, a genuine failure refunds a gas burner in WETH);
estimate → send at exactly the estimate → `Zapped` for new 10/30-day locks and top-ups (ETH and WETH) and
`Refunded` for an impossible `minOut`; M-C front-runs against the real pool; ETH pushed in through the real
`WETH.withdrawTo` is swept to the fee recipient.

Results in this repository (2026-10-10, `PulpZap.sol` sha256
`871cbf4865ca76c1bd567124fd414deaa87a46c1798c11262002f4cf5897c042`): unit 70 + 5 helpers passing, `test:deploy`
11 passing, fork 8 passing at the latest block (0.001 ETH locked exactly the Quoter's 1489.367145191350370251
PULP; OrRefund estimate → used: new 10-day 1,277,672 → 985,192, new 30-day 2,235,734 → 1,927,097, top-up
901,178 → 614,385, WETH new 30-day 2,299,800 → 1,962,496, WETH top-up 965,587 → 644,984, all `Zapped`).
Earlier pinned run (block 84,643,000): new 10-day 1,142,460 → 850,203; new 30-day 2,186,642 → 1,878,457; top-up
869,844 → 583,696; impossible `minOut` 458,371 → 195,571 (`Refunded`).

## What is not verified

- No deployment, no broadcast transaction; the fork is local. The vault is not deployed on mainnet yet.
- Bridges: the Across recipes were run through the real SpokePool and MulticallHandler on a fork by the
  2026-10-10 audit (with the old signatures); the CB-1 fix was prototyped there too. With the new signatures
  the bridge path is only covered by the mock executor here. Relay's on-chain failure behaviour, the Across
  relayers' and Relay solvers' gas policies, and the second Across handler (`0xa8aD…`, only seen in an Across
  API response) were not exercised.
- Whether Robinhood's RPC supports the `eth_call` block-time override the deploy script uses before launch
  (geth and Nitro document it; Hardhat does not support it). If not, run `--check` after launch.
- The price-limit formula assumes the swap stays in one liquidity range and that the hook's tax comes off the
  output; it is guidance, not a guarantee. Always `eth_call` the zap with the limit before signing.
- Hardhat's fork uses Ethereum (cancun) rules, not ArbOS; Robinhood Chain gas accounting (the L1 component was
  0 in the E2E run) and Arbitrum-specific behaviour are not modelled. Gas figures are L2 execution gas.
- Fee/ownership not exercised with the real deploy owner or through a real bridge; the deploy script only ran
  against a local Hardhat node with Hardhat test keys.
- No fuzzing, no formal verification, no external audit.

## Open risks

- Sandwich/MEV: protection is `minPulpOut`, the optional price limit and `deadline`. See "Sandwiches": keep
  bridge margins at 1% or less and split large orders. The hook's tax recipient can sandwich at any size.
- Hook risk: the hook owner (an EOA) can halt every swap through a hostile tax recipient (AMM-2). The tax rate
  itself is fixed at 3%.
- Gifting a lock is permanent and permissionless (vault semantics): a planted lock cannot stretch a zap beyond
  `maxUnlockTime` (it reverts or refunds), but it still blocks that address's new locks until it expires, and a
  planted lock that ends sooner turns a "new lock" zap into a shorter top-up (re-review N-3/N-4).
- OrRefund leaves users with ETH/WETH on Robinhood when the lock fails, including late bridge fills; the UI must
  tell them.
- OrRefund gas: too little gas now reverts (`InsufficientGas`) instead of refunding, so a relayer that
  under-supplies gas makes the fill fail and the bridge's own refund rules apply. A hook that burns gas makes
  every OrRefund call revert the same way.
- Owner key: a compromised owner can raise the fee to 2% (bounded by each caller's `maxFeeBps`), redirect it,
  and sweep strays to the (possibly redirected) fee recipient. Ownership cannot be renounced.
- WETH upgrades can change the refund path's gas (see "Monitoring").
