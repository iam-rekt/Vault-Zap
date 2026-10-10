# Bridges: cross-chain "buy & lock" into Robinhood Chain (4663)

How a bridge (or a frontend that builds a bridge order) should call PulpZap, and which bridges reach Robinhood
Chain. **Integrators: section 4 has the rules.** Zap design: [ZAP.md](ZAP.md).

Checked: 2026-10-09; section 4 rewritten 2026-10-10 after the audit ([SECURITY.md](SECURITY.md):
CB-1/E2E-1, CB-2, CB-5, CB-6, AMM-1, E2E-2). Method: live API calls (curl), on-chain RPC calls, official docs. Anything not verified is marked **UNVERIFIED**.

## 1. Tokens on Robinhood Chain (verified on-chain via https://rpc.mainnet.chain.robinhood.com, chainId 0x1237 = 4663)

| Asset | Address | Notes |
|---|---|---|
| $pulp | 0xBc2283d12B1f2f46c1613AE672E95C55b69Ca414 | eth_getCode returns contract code |
| WETH | 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 | symbol WETH, 18 dec (also listed at https://docs.robinhood.com/chain/contracts) |
| USDG (Paxos Global Dollar) | 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 | symbol USDG, 6 dec, large supply (~7e8 units); canonical per Robinhood docs, Relay, LI.FI |
| USDG (second token) | 0x0A3B763d66c0e8c7555c986A3701E1DC1Bf3954F | symbol USDG, 6 dec, supply only ~1,100; listed by LI.FI. Treat as non-canonical, do not use |
| native USDC | none found | Not on docs token page; not in Relay/LI.FI/Across token lists (only syrupUSDC 0xC6a4854eeB493224d5f9485E12Dd3A81f22EEE14). **No USDC on Robinhood Chain as of today (UNVERIFIED beyond these lists).** |

Consequence: "bring USDC" always means USDC in, **USDG out** (Across, Relay both do this). A frontend needs a USDG-to-ETH-to-$pulp path (or a USDG/pulp pool) on Robinhood, or users should be routed to land as ETH.

Canonical ETH route: Arbitrum-style canonical bridge via the Delayed Inbox on Ethereum L1. Deposit about 10 min, withdrawal about 7 days; retryable tickets, failed L2 leg can be redeemed manually within 7 days. No arbitrary-call hook usable from a static site (needs L1 retryable ticket to a contract). Source: https://docs.robinhood.com/chain/bridging/ . Inbox/gateway addresses are on https://docs.robinhood.com/chain/protocol-contracts (not fetched).

## 2. Comparison (destination = Robinhood Chain 4663)

Verified live that 4663 appears in: Relay `GET https://api.relay.link/chains`, LI.FI `GET https://li.quest/v1/chains`, Across `GET https://app.across.to/api/swap/chains`. Robinhood's own bridging page lists: canonical bridge, LayerZero OFT/Stargate, Chainlink CCIP/Transporter, Relay, Across, LI.FI/0x.

| Option | Source chains (common EVM chains and Solana) | Assets | Dest. arbitrary call | Fees / speed | Public API + frontend use | API key |
|---|---|---|---|---|---|---|
| **Relay** (https://docs.relay.link) | Relay chain list includes Ethereum, Base, Arbitrum, Optimism, BSC, HyperEVM, Solana (listed as chains; Solana to 4663 pair **UNVERIFIED**). 61 chains total | ETH in/out, USDG on 4663; USDC in -> USDG out. Relay lists 4663 currencies: ETH, USDG | **Yes**: `POST /quote/v2` with `txs[{to,value,data}]` ("bridge and execute"). For EXACT_INPUT docs say you usually need your own destination proxy that reads its balance at execution time; EXACT_OUTPUT can use fixed calldata. https://docs.relay.link/references/api/api_guides/calling-integration-guide | Seconds (intents). Fee shown in quote; not quantified here | REST + SDK + React widget; works from a browser | Docs say required for every `POST /quote/v2` from 2026-10-02 (`x-api-key`), but an unauthenticated ETH Base->4663 quote returned a valid response on 2026-10-09. Plan on getting a free key from the Relay dashboard; key in a static site is public-ish (use domain restrictions if offered, UNVERIFIED) |
| **Across** (https://docs.across.to) | 24 chains in `/swap/chains` incl. 1, 10, 56, 999 (HyperEVM), 8453, 42161, 4663; Solana (34268394551451) in list. Across blog says 13 chains can send USDC | USDC in -> USDG out; ETH -> ETH; USDG from L1 | **Yes**: `POST /swap/approval` with `actions[{target, functionSignature, args[]...}]`, or `message` delivered to `handleV3AcrossMessage(address,uint256,address,bytes)` on the recipient contract (corrected 2026-10-10; Across' MulticallHandler implements it). Recipient must be a contract that implements the handler. https://docs.across.to/api-reference/swap/approval/post | ~2 s fills claimed by Across blog (vendor claim). Fees returned in quote (bridge, swap impact, optional appFee) | REST; browser use possible | Production needs API key + 2-byte integratorId (https://docs.across.to/introduction/api-keys); whether a key may be exposed client-side is not addressed. Native ETH output with actions: **not available to contracts**: the SpokePool delivers WETH to a contract recipient (verified on a fork, audit CB-2) |
| **LI.FI** (https://docs.li.fi) | 50+ chains incl. all EVM sources and Solana; 4663 in chain list | ETH, USDG, cbBTC, many tokens (token list for 4663 fetched) | **Yes but limited**: `POST /v1/quote/contractCalls` (beta); `/quote/contractCalls` **does not support native ETH** destination value per docs/search result. SDK `getContractCallsQuote`. Live: a plain ETH Base->4663 `/quote` returned via bridge "layerswap" (~3 s, 0.001 -> ~0.00099681 ETH) | Aggregates other bridges; simplest "widget" story | `@lifi/sdk` and widget run in browser, no key needed in frontend | Optional; unauthenticated is 75 `/quote` req per 2 h, free key gives 100 rpm |
| Stargate / LayerZero OFT | EVM chains | USDG, WBTC, other OFTs (docs examples) | Compose messages possible in LayerZero generally; not verified for 4663 | Minutes | Stargate UI/SDK | No |
| Chainlink CCIP / Transporter | n/a | syrupUSDG etc. | Programmable token transfers exist; **not evaluated** | Minutes | Not designed for retail buy flow | No |
| Canonical bridge | Ethereum only | ETH, ERC-20 | Retryable tickets (L1 contract needed) | ~10 min in; 7 days out | Robinhood bridge UI | No |
| deBridge, Socket/Bungee, Squid, Rango, Gas.zip | **UNVERIFIED** (not checked; not on Robinhood's list) | | | | | |

## 3. Recommendation

(a) **Land as ETH on Robinhood, then swap+lock in the frontend (2 transactions):** use **LI.FI** as the primary (widget/SDK, no backend, multi-source incl. Solana/BNB/HyperEVM, can route via Relay/Across/others) with **Relay** (direct API/SDK, seconds, ETH native) as the alternative or fallback. Set destination token = native ETH, and for USDC sources let the router swap to ETH on source or destination so users end with ETH, not USDG. Across is fine for ETH/USDC from major EVMs but needs an API key plus integratorId for production.

(b) **One action, bridge + call the zap:** use **Relay `txs` calls** (native ETH `value` supported, destination calldata to the zap) as first choice, **Across `actions`/`handleV3AcrossMessage`** as second (WETH arrives at the handler: use the section 4 recipes). Avoid LI.FI `contractCalls` for this because it lacks native ETH.

Design notes for (b):
- EXACT_INPUT amounts are not known at quote time, so the zap takes `msg.value` (or the WETH amount it is given) at execution (Relay docs recommend a balance-reading proxy), with `minPulpOut` and an explicit `beneficiary` (the lock owner).
- Failure handling: Relay refunds on the **origin** chain to `refundTo` (automatic refunds disabled if unset, none if refund < gas). What happens to funds when the destination call itself reverts is **not documented in the pages checked (UNVERIFIED)**. Across: refund destination depends on route (destination-swap routes refund on destination by default; `refundOnOrigin`, `refundAddress` can be set); destination action failure behavior also not stated. This is why the zap has the non-reverting `OrRefund` entry points (on a genuine failure the input goes to the user on Robinhood Chain instead of reverting), so funds never strand. Test small amounts on both before launch.
- Slippage across two hops: bridge quote (EXACT_INPUT output moves) plus Uniswap v4 pool swap plus **3% buy tax on $pulp** (fixed at 3% forever: the hook's `registerLaunch` reverts `AlreadyLaunched` and nothing else writes the rate; audit AMM-4). Set `minPulpOut` net of tax, quote it on-chain at execution, and show the user the post-tax estimate. A zap that reverts on slippage is the main strand risk, hence the non-reverting design above.
- Third-party contract risk: user funds touch the bridge depository/solver and then the zap; the zap does not hold approvals or balances between transactions, and is safe to call by anyone (the lock owner must be an explicit calldata argument, never inferred from `msg.sender`, since the caller will be the bridge forwarder).
- USDC users: ask the router for ETH output, otherwise they receive USDG and need a USDG to $pulp path.

## 4. Integrating a bridge with PulpZap (rules)

Requirements for any frontend or backend that builds a bridge destination call to the zap. First written
2026-10-09 after the first internal review; rewritten 2026-10-10 for the audit fixes and the new signatures (every entry
point gained `uint160 minSqrtPriceX96` right after `minPulpOut`).

1. **Use the `OrRefund` entry points** (`zapETHOrRefund`, `zapWETHOrRefund`). After funds arrive they lock, or
   refund the full input to the beneficiary on Robinhood Chain on any genuine failure. They revert, taking
   nothing, only for a zero amount, an unusable beneficiary, a failed WETH pull, or too little gas (rule 7).
2. **The beneficiary is the user's own address on Robinhood Chain. Never the executor/handler** (Across
   `MulticallHandler`, Relay's multicaller/solver, any router or proxy), never the zap, vault, WETH, PULP,
   PoolManager or hook (those revert `InvalidBeneficiary`). A lock owned by a public executor is a lock anyone
   can drive (withdraw at maturity, claim its rewards).
3. **Exact amounts, not `max`.** `wethAmount = type(uint256).max` pulls the executor's whole WETH balance,
   including other users' leftovers if it batches or holds dust. Across fills exactly `outputAmount`, so use it.
4. **Tight `minPulpOut` and a price limit.** `(fee, net) = zap.quoteFee(minBridgeOutput)`, then
   `Quoter.quoteExactInputSingle((ETH, PULP, 0, 60, hook), true, net, "")` (includes the hook tax), minus at most
   **1%**. Set `minSqrtPriceX96` from the expected post-swap price minus at most 1% ([ZAP.md](ZAP.md), "Price limit"), or 0
   for none. Bridge orders are public on the origin chain before they fill, the pool is thin (1 ETH moves it
   ~7%), and a sandwich takes whatever margin you leave; the hook's tax recipient profits at any size. **Split
   orders above ~0.5 ETH** into several fills.
5. **`deadline <= the bridge's fill deadline`** (Across `fillDeadline`; Relay's quote expiry). A fill after
   `deadline` but before the bridge's deadline **refunds on Robinhood Chain** (`DeadlineExpired` -> `Refunded`):
   the user gets ETH/WETH there, not a lock and not an origin-chain refund. Only an unfilled order is refunded
   on the origin chain by the bridge.
6. **`maxUnlockTime = deadline + daysLocked * 86400`** for a new lock: exactly the latest end any fill before the
   deadline can produce, so a valid fill never refunds and a planted or extended lock does (`UnlockTooLate`).
   For a top-up: the lock `end` shown to the user. Never `type(uint256).max` for bridge flows.
7. **Gas: estimate the OrRefund call itself and add ~10% headroom.** A hop that runs out of gas now reverts
   `InsufficientGas` instead of refunding (audit CB-1/E2E-1), so `eth_estimateGas` on `zapETHOrRefund` /
   `zapWETHOrRefund` (or on the whole bridge fill, e.g. the SpokePool `fillRelay` with the message) lands on the
   lock path, or on a genuine refund when the order cannot lock. Bridges' own simulators (Across relayers,
   Relay solvers) see the same. The headroom covers state changes between estimate and fill (a new lock made a
   second after 00:00 UTC schedules one more day, ~70k gas; other swaps change tick crossings). With too little
   gas the destination call reverts and the bridge's rules apply (Across: the relayer cannot fill and the
   deposit is refunded on origin after `fillDeadline`). Measured on a fork (0.001 ETH, block 84,643,000),
   OrRefund estimate -> gas used: new 10-day 1,142,460 -> 850,203; new 30-day 2,186,642 -> 1,878,457; top-up
   869,844 -> 583,696; WETH new 30-day 2,251,280 -> 1,914,709; WETH top-up 933,986 -> 614,259; all locked when
   sent with exactly the estimate. On real chain state (E2E): zap new lock ~1.35–1.95M, top-up ~0.46–0.57M,
   bridged 30-day zap 1.89–1.92M. The old advice ("estimate the strict call + 20%") is obsolete.
8. **`maxFeeBps`** = the `zap.zapFeeBps()` the user was shown. A fee raised after the quote refunds (`FeeAboveMax`).
9. **Call the zap at top level** (a bridge executor's plain call is fine), never from inside a v4 `unlock`.
10. Tell the user that a refund (including a late fill) leaves ETH (or WETH, if their wallet refuses ETH within
    50,000 gas) on Robinhood Chain, not a lock, and they must retry from there. `Refunded.reason` says why (the
    revert selector; `0x00000000` = no revert data, e.g. an inner call ran out of gas).

### Addresses on Robinhood Chain (4663)

Checked 2026-10-10. "Executed" means the audit ran the real deployed code on a fork; "code read" means
`eth_getCode` (and the EIP-1967 implementation for proxies) was read and the listed selectors were found in the
bytecode. Block explorer source pages were not readable (Cloudflare), so no source was matched to bytecode.

| What | Address | Status |
|---|---|---|
| Across SpokePool (proxy; impl `0x1771c470d41b8c39338450c380bf2c080a2cedd8`) | `0xD29C85F15DF544bA632C9E25829fd29d767d7978` | Executed (`fillRelay`) by the audit's CB fork tests; code read: `fillRelay`, `wrappedNativeToken` present. Address from the Across API (`destinationSpokePoolAddress`) |
| Across MulticallHandler A | `0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E` | Executed (both recipes below, old signatures); code read: `handleV3AcrossMessage`, `makeCallWithBalance`, `drainLeftoverTokens` present |
| Across handler B | `0xa8aD2e87E2043711d8BeC77e8BC3E2683C0ab6BD` | Code read only (same three selectors present). Seen as the recipient in an Across swap-API response; **not executed** |
| Relay router (`contracts.v3.erc20Router`) | `0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f` | Executed (`multicall`) by the audit's CB fork tests; code read: `multicall` present. Address from the Relay API |
| LI.FI diamond | `0xB477751B76CF82d00a686A1232f5fCD772414Af3` | Code read only (254-byte diamond proxy; the loupe reports 19 facets). From the LI.FI chains API; **not executed** |

### Across recipes (WETH arrives, not ETH)

The SpokePool delivers **WETH** to a contract recipient such as the MulticallHandler, never native ETH. The
earlier recipe "one native `makeCallWithBalance` -> `zapETHOrRefund`" therefore never locked: the zap got
`msg.value = 0` (`ZeroAmount`), the call failed and the handler drained the WETH to `fallbackRecipient`
(audit CB-2, reproduced through the real contracts). Use one of these, with `recipient = MulticallHandler` and
`message = abi.encode(Instructions{calls, fallbackRecipient})`,
`Instructions = ((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)`.

**`fallbackRecipient` must be `address(0)`.** With a fallback recipient, the handler wraps the calls in its own
try/catch (`handleV3AcrossMessage`) and, if they fail, sends the user the WETH. The zap reverts
`InsufficientGas` when it is under-gassed, so that catch is the cheapest successful path of the fill: every
`eth_estimateGas` lands on it and the fill "succeeds" with the user holding WETH and no lock. Measured on a fork
of 4663 through the real SpokePool and handler (end-to-end suite, 2026-10-10): with `fallbackRecipient = user` a fill succeeds
from about 265k gas but only locks from about 2.57M, and the estimate (x1.0, x1.1, geth-style) never locked. With
`fallbackRecipient = 0` the handler does not catch, an under-gassed fill reverts (the relayer can't fill it, and
Across refunds the deposit on the origin chain after `fillDeadline`), so estimates must cover the lock: they
locked at x1.0 and x1.1. Genuine failures (price moved, deadline passed) are still refunded by the zap itself
(`zapWETHOrRefund` pays the user the WETH) and the fill succeeds.

- **A. WETH (recommended).** `calls = [ (WETH, approve(zap, outputAmount), 0),
  (zap, zapWETHOrRefund(user, outputAmount, days, minOut, minSqrtPriceX96, deadline + days*86400, maxFeeBps, deadline), 0) ]`,
  `fallbackRecipient = 0`. Tested on a 4663 fork through the real SpokePool and handler with the current
  signatures (end-to-end suite): locks at the fill's gas estimate; a stale price or a late fill refunds the user in WETH.
- **B. Unwrap, then native.** `calls = [ (WETH, withdraw(outputAmount), 0),
  (handler, makeCallWithBalance(zap, zapETHOrRefund(...) ++ 32 zero bytes, 0, [(address(0), 4 + 7*32 = 228)]), 0) ]`,
  `fallbackRecipient = 0`. `makeCallWithBalance` with token `address(0)` sends the handler's whole native
  balance as `value` and writes that balance into the calldata at the given offset; the appended zero word is
  that slot, so no real argument is touched (the offset was `196` for the old 6-argument signature). Tested on
  the fork with the current signature (end-to-end suite): locks at the estimate; `Zapped.caller` = the handler.

### Encoded-call examples (current signatures)

```
zapETHOrRefund(address beneficiary, uint256 daysLocked, uint256 minPulpOut, uint160 minSqrtPriceX96, uint256 maxUnlockTime, uint16 maxFeeBps, uint256 deadline)
  selector 0x11e47402   (was 0xd419e105)
zapWETHOrRefund(address beneficiary, uint256 wethAmount, uint256 daysLocked, uint256 minPulpOut, uint160 minSqrtPriceX96, uint256 maxUnlockTime, uint16 maxFeeBps, uint256 deadline)
  selector 0xb2ba783d   (was 0x96b8bafa)
```

Worked example (illustrative values; quote time `t = 1760000000`): beneficiary `0x1111…1111`, new 30-day lock,
`minPulpOut` 2,000 PULP, no price limit (`0`), `deadline = t + 30 min = 1760001800`,
`maxUnlockTime = deadline + 30 days = 1762593800`, `maxFeeBps = 50`. Generated with
`ethers.Interface(PulpZap ABI).encodeFunctionData`.

```js
// ethers v6
const deadline = quoteTime + 1800n; // <= the bridge's fillDeadline
const data = zap.interface.encodeFunctionData('zapETHOrRefund',
  [user, 30, minPulpOut, minSqrtPriceX96, deadline + 30n * 86400n, shownFeeBps, deadline]);
```

```
zapETHOrRefund(0x1111…1111, 30, 2000e18, 0, 1762593800, 50, 1760001800):
0x11e474020000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000006c6b935b8bbd400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000690f0c0800000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000068e77f08

zapWETHOrRefund(0x1111…1111, 0.001e18, 30, 2000e18, 0, 1762593800, 50, 1760001800):
0xb2ba783d000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000006c6b935b8bbd400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000690f0c0800000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000068e77f08
```

- **Relay** `txs`: `[{ to: <zap>, value: <ETH delivered>, data: <zapETHOrRefund calldata> }]`. For EXACT_INPUT the
  delivered amount is only known at fill time, so either use EXACT_OUTPUT with fixed calldata and `value`, or a
  route where the executor forwards its actual balance as `value` (UNVERIFIED for Relay). Relay's on-chain
  behaviour when the destination call reverts was not tested.
- **Across** `actions` / `message`: recipe A or B above.
- **LI.FI** `contractCalls`: no native ETH destination value (section 2); a WETH-based call like recipe A would
  be needed (not tested).

## Sources (checked 2026-10-09)
- https://docs.robinhood.com/chain/bridging/ , https://docs.robinhood.com/chain/contracts
- RPC: https://rpc.mainnet.chain.robinhood.com (eth_chainId, eth_getCode, eth_call symbol/decimals/totalSupply)
- https://api.relay.link/chains ; https://docs.relay.link/references/api/api_guides/calling-integration-guide ; https://docs.relay.link/references/api/api_core_concepts/refunds
- https://li.quest/v1/chains ; https://li.quest/v1/tokens?chains=4663 ; https://docs.li.fi/api-reference/perform-multiple-contract-calls-across-blockchains-beta ; https://docs.li.fi/api-reference/rate-limits
- https://app.across.to/api/swap/chains ; https://www.across.to/blog/bridge-to-robinhood-chain-with-across ; https://docs.across.to/api-reference/swap/approval/post ; https://docs.across.to/introduction/api-keys
