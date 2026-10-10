#!/usr/bin/env node
/* Deploys PulpZap with your own key, hands ownership over (two-step), checks every setting on-chain and
   simulates a dust zap through the real pool with eth_call.

     npm run deploy:zap -- --dry-run           rehearse: every check, the deploy simulation and the cost, sends nothing
     npm run deploy:zap                        deploy to Robinhood Chain, asking for everything
     npm run deploy:zap -- --config zap.json   take the settings from a file (same shape as config/zap.example.json)
     npm run deploy:zap -- --check <zap>       no key, sends nothing: read an existing zap back and simulate a dust zap

   Deploy the vault first (npm run deploy:vault). The vault address is taken from the config file, else offered
   as the default from the newest vault record in deployments/ for this chain (written by deploy:vault), else asked.

   other flags: --rpc <url>  --chain-id <id>  --explorer <url|none>  --no-verify  --allow-eoa-owner  --from <addr>

   Private keys are only ever typed into a hidden prompt. They are never read from arguments, environment
   variables or files, never written anywhere and never printed. Nothing is sent until the plan has been shown,
   the deployment has been simulated and you type "deploy". On Robinhood Chain (4663) the script refuses
   Hardhat's public test keys and accounts (they are 7702-delegated on mainnet) for every role, and refuses an
   owner without code (a multisig is expected) unless --allow-eoa-owner is given. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const ART_DIR = path.join(ROOT, 'artifacts/contracts/PulpZap.sol');
const SOURCE = 'contracts/PulpZap.sol';
const ROBINHOOD = { rpc: 'https://rpc.mainnet.chain.robinhood.com', chainId: 4663, explorer: 'https://robinhoodchain.blockscout.com' };
// Robinhood Chain (4663): the one pool the zap is for. The pool id is asserted twice: here before deploying,
// and by the constructor (expectedPoolId), which reverts PoolIdMismatch on any difference.
const KNOWN = {
  4663: {
    pulp: '0xBc2283d12B1f2f46c1613AE672E95C55b69Ca414',
    weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    hooks: '0x4Bc7Ba3a253d048Dc36C17Ac3f4E6484dAD120CC',
    lpFee: 0,
    tickSpacing: 60,
    poolId: '0xdd086a556aa997e79d16cde88a6fcda21f615737df3d331ca1af74642e99dc09',
    quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  },
};
const MAX_FEE_BPS = 200; // the contract's MAX_ZAP_FEE_BPS (2%)
const DEFAULT_FEE_BPS = 50;
const DUST = 10n ** 12n; // 0.000001 ETH for the eth_call zap simulation
const TRANSFER_GAS = 80_000n; // transferOwnership, only for the up-front cost check
const WAIT_MS = 10 * 60 * 1000;
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

const VAULT_ABI = [
  'function pulp() view returns (address)', 'function weth() view returns (address)',
  'function minLockAmount() view returns (uint256)', 'function launchStart() view returns (uint256)',
  'function emergencyExit() view returns (bool)', 'function locksPaused() view returns (bool)',
];
const PM_ABI = ['function extsload(bytes32) view returns (bytes32)'];
const QUOTER_ABI = ['function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256 amountOut, uint256 gasEstimate)'];
const ERC20 = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];

const HELP = `usage: npm run deploy:zap -- [options]

  --dry-run              run every check and the deploy simulation, show the plan and cost, send nothing
  --config <file>        settings from a JSON file shaped like config/zap.example.json
  --check <zap>          read an already deployed zap back and simulate a dust zap; no key, sends nothing
  --from <address>       eth_call sender for --check's dust simulation (default: the zap's fee recipient)
  --allow-eoa-owner      on Robinhood Chain, accept a final owner without code (default: a contract/multisig is required)
  --rpc <url>            default ${ROBINHOOD.rpc}
  --chain-id <id>        the chain the RPC must be on (default ${ROBINHOOD.chainId})
  --explorer <url|none>  blockscout explorer for links and verification (default ${ROBINHOOD.explorer})
  --no-verify            skip source verification`;

/* ---------- pure helpers (exported for tests) ---------- */

/** v4 PoolId of (native ETH, pulp, lpFee, tickSpacing, hooks), like PoolIdLibrary.toId and PulpZap's constructor. */
function computePoolId(pulp, lpFee, tickSpacing, hooks) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'], [ethers.ZeroAddress, pulp, lpFee, tickSpacing, hooks]));
}

/** StateLibrary slot of a pool's slot0 in the PoolManager. */
function slot0Slot(poolId) {
  return ethers.keccak256(ethers.concat([poolId, ethers.toBeHex(6, 32)]));
}

let hardhatCache = null;
/** The first 1,000 accounts derived from Hardhat's public mnemonic (lowercase; #20 and up are swept on mainnet too). Their keys are public everywhere. */
function hardhatAccounts() {
  if (!hardhatCache) {
    const root = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, '', "m/44'/60'/0'/0");
    hardhatCache = new Set(Array.from({ length: 1000 }, (_, i) => root.deriveChild(i).address.toLowerCase()));
  }
  return hardhatCache;
}
const isHardhatAccount = (a) => hardhatAccounts().has(String(a).toLowerCase());

function parseFeeBps(text) {
  const t = String(text).trim();
  if (!/^\d+$/.test(t) || Number(t) > MAX_FEE_BPS) throw new Error(`the zap fee is in basis points: a whole number from 0 to ${MAX_FEE_BPS} (2%)`);
  return Number(t);
}

function toAddress(text) {
  const t = String(text).trim();
  if (!ethers.isAddress(t)) throw new Error('that isn’t a valid address');
  const a = ethers.getAddress(t);
  if (a === ethers.ZeroAddress) throw new Error('the zero address can’t be used here');
  return a;
}

function toBytes32(text) {
  const t = String(text).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(t)) throw new Error('give a 32-byte hex value (0x + 64 hex characters)');
  return t;
}

/** The constructor's deny-list for the fee recipient (and beneficiaries). */
function protocolAddresses(s) {
  return [s.vault, s.pulp, s.weth, s.poolManager, s.hooks].filter(Boolean).map((a) => a.toLowerCase());
}

/**
 * Role rules, checked before anything is sent. `codeAt(address)` returns the deployed code ('0x' if none).
 * Returns a list of problems (empty = fine).
 */
async function roleProblems({ chainId, deployer, owner, feeRecipient, allowEoaOwner, settings }, codeAt) {
  const p = [];
  const deny = protocolAddresses(settings);
  if (chainId === 4663) {
    if (isHardhatAccount(deployer)) p.push(`the deployer ${deployer} is a Hardhat test account: its key is public (and 7702-delegated on mainnet)`);
    if (isHardhatAccount(owner)) p.push(`the owner ${owner} is a Hardhat test account: its key is public`);
    if (isHardhatAccount(feeRecipient)) p.push(`the fee recipient ${feeRecipient} is a Hardhat test account: its key is public`);
    if (!allowEoaOwner && (await codeAt(owner)) === '0x') {
      p.push(`the owner ${owner} has no code: on Robinhood Chain the owner must be a contract (a multisig). pass --allow-eoa-owner to accept a plain wallet`);
    }
  }
  if (deny.includes(owner.toLowerCase())) p.push(`the owner ${owner} is one of the protocol contracts (vault, PULP, WETH, PoolManager, hook)`);
  if (deny.includes(feeRecipient.toLowerCase())) p.push(`the fee recipient ${feeRecipient} is one of the protocol contracts; the zap refuses it (InvalidFeeRecipient)`);
  return p;
}

/** The custom error in a failed call, by name. */
function reason(e, iface) {
  const data = [e?.data, e?.info?.error?.data, e?.error?.data, e?.info?.error?.data?.data]
    .find((d) => typeof d === 'string' && /^0x[0-9a-f]{8}/i.test(d));
  if (data) {
    try { const p = iface.parseError(data); if (p) return { name: p.name, args: p.args, text: p.args.length ? `${p.name}(${p.args.join(', ')})` : p.name }; } catch { /* not ours */ }
  }
  return { name: null, args: [], text: e?.shortMessage || e?.reason || e?.message || String(e) };
}

/**
 * eth_call a strict dust zapETH and the OrRefund variant. The strict call must get through every pre-swap check
 * and the real swap, then revert InsufficientOutput(pulpOut > 0, minLockAmount): that proves the pool key, the
 * hook, settle and take all work for this zap. If the vault is not open yet, the call is retried with a block
 * time override (geth/Nitro support it); if the node can't, the simulation is reported as skipped.
 */
async function dustSimulation(provider, zapAddr, iface, { from, feeBps, minLockAmount, launchStart, quoter, pulp, hooks, lpFee, tickSpacing }) {
  const now = (await provider.getBlock('latest')).timestamp;
  const dl = BigInt(Math.max(now, Number(launchStart)) + 3600);
  // A fresh beneficiary, so the simulation never depends on someone's existing lock.
  const beneficiary = ethers.getAddress(ethers.hexlify(ethers.randomBytes(20)));
  const args = [beneficiary, 10, minLockAmount, 0, ethers.MaxUint256, feeBps, dl];
  const call = async (fn, override) => {
    const tx = { from, to: zapAddr, value: ethers.toBeHex(DUST), data: iface.encodeFunctionData(fn, args) };
    const params = [tx, 'latest'];
    if (override) params.push({}, { time: ethers.toBeHex(Number(launchStart) + 60) });
    return provider.send('eth_call', params);
  };
  let override = false;
  if (now < Number(launchStart)) override = true;
  const out = { ran: false, override, pulpOut: null, quoted: null, refund: null, problem: null, note: null };
  let strict;
  try {
    await call('zapETH', override);
    out.problem = 'a dust zap locked: minLockAmount is below the PULP 0.000001 ETH buys';
    return out;
  } catch (e) {
    strict = reason(e, iface);
  }
  if (override && strict.name === null) {
    out.note = `the node can’t simulate at the launch time (${strict.text}); run again with --check after locking opens`;
    return out;
  }
  out.ran = true;
  if (strict.name !== 'InsufficientOutput' || !(strict.args[0] > 0n)) {
    out.problem = `the dust zap failed with ${strict.text}, not InsufficientOutput(pulpOut > 0, minLock)`;
    return out;
  }
  out.pulpOut = strict.args[0];
  if (quoter) {
    try {
      const q = new ethers.Contract(quoter, QUOTER_ABI, provider);
      const net = DUST - (DUST * BigInt(feeBps)) / 10_000n;
      const [amountOut] = await q.quoteExactInputSingle.staticCall([[ethers.ZeroAddress, pulp, lpFee, tickSpacing, hooks], true, net, '0x'], { from });
      out.quoted = amountOut;
    } catch (e) { out.note = `the Quoter could not be read: ${e.shortMessage || e.message}`; }
  }
  try {
    const ret = await call('zapETHOrRefund', override);
    const [locked] = iface.decodeFunctionResult('zapETHOrRefund', ret);
    out.refund = locked === false;
    if (!out.refund) out.problem = 'the OrRefund dust zap locked instead of refunding';
  } catch (e) {
    out.problem = `the OrRefund dust zap reverted: ${reason(e, iface).text}`;
  }
  return out;
}

/**
 * The newest PulpVeVault record that deploy-vault.js wrote for `chainId` (deployments/<chainId>-<vault>.json, a
 * JSON object with a `vault` address), or null. Zap records (with `zap`) and unreadable files are skipped.
 */
function findVaultRecord(chainId, dir = path.join(ROOT, 'deployments')) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!new RegExp(`^${Number(chainId)}-0x[0-9a-fA-F]{40}\\.json$`).test(name)) continue;
    const file = path.join(dir, name);
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!j || typeof j.vault !== 'string' || !ethers.isAddress(j.vault) || j.zap) continue;
    if (j.chainId !== undefined && Number(j.chainId) !== Number(chainId)) continue;
    const at = Date.parse(j.deployedAt || '') || fs.statSync(file).mtimeMs;
    if (!best || at > best.at) best = { vault: ethers.getAddress(j.vault), file, at, record: j };
  }
  return best;
}

module.exports = { KNOWN, computePoolId, slot0Slot, isHardhatAccount, hardhatAccounts, parseFeeBps, toAddress, toBytes32, roleProblems, dustSimulation, reason, findVaultRecord };

/* ---------- output and input (CLI only) ---------- */
let out, rl, lines, tty, sent = false;
const say = (s = '') => process.stdout.write(`${s}\n`);
const tint = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tint ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint(1), dim = paint(2), red = paint(31), green = paint(32), yellow = paint(33);
const row = (k, v) => say(`  ${k.padEnd(17)}${v}`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const utc = (t) => `${new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
const eth = (v) => Number(ethers.formatEther(v)).toLocaleString('en-US', { maximumSignificantDigits: 4 });
const pct = (bps) => `${+(bps / 100).toFixed(2)}%`;
const chainName = (id) => (id === 4663 ? 'Robinhood Chain' : id === 31337 ? 'local test chain' : `chain ${id}`);

function stop(msg) {
  if (out) out.muted = false;
  say(red(`\n✗ ${msg}`));
  say(sent ? yellow('  transactions were already sent: check the explorer before running this again.') : dim('  nothing was sent.'));
  process.exit(1);
}

function setupInput() {
  out = new Writable({ write(chunk, enc, cb) { if (!out.muted) process.stdout.write(chunk, enc); cb(); } });
  out.muted = false;
  tty = !!process.stdin.isTTY;
  rl = readline.createInterface({ input: process.stdin, output: out, terminal: tty, historySize: 0 });
  lines = rl[Symbol.asyncIterator]();
  rl.on('SIGINT', () => {
    out.muted = false;
    say(sent ? yellow('\nstopped. transactions already sent may still confirm: check the explorer.') : '\ncancelled. nothing was sent.');
    process.exit(130);
  });
}

async function ask(question, { hidden = false, def = null } = {}) {
  rl.setPrompt(def != null && def !== '' ? `${question} [${def}]: ` : `${question}: `);
  rl.prompt();
  out.muted = hidden;
  const { value, done } = await lines.next();
  out.muted = false;
  if (done) stop('input ended before the deploy was confirmed');
  if (hidden && tty) process.stdout.write('\n');
  if (!tty) say(hidden ? '(hidden)' : value);
  const v = String(value).trim();
  return v === '' && def != null ? String(def) : v;
}

async function askUntil(question, parse, opts = {}) {
  for (;;) {
    const text = await ask(question, opts);
    try { return await parse(text); } catch (e) {
      say(red(`  ${e.message}`));
      if (!tty) stop(`${question}: ${e.message}`);
    }
  }
}

async function setting(cfg, key, question, parse, def) {
  if (cfg[key] === undefined) return askUntil(question, parse, { def });
  try {
    const v = await parse(String(cfg[key]));
    say(`${question}: ${dim('from the config file')}`);
    return v;
  } catch (e) { return stop(`config "${key}": ${e.message}`); }
}

function toWallet(text, provider) {
  let k = String(text).trim();
  if (!k) throw new Error('no key entered');
  if (!/^0x/i.test(k)) k = `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('that isn’t a private key (64 hex characters)');
  try { return new ethers.Wallet(k, provider); } catch { throw new Error('that isn’t a usable private key'); }
}

async function contractAt(provider, text, label) {
  const a = toAddress(text);
  if ((await provider.getCode(a)) === '0x') throw new Error(`there’s no contract at ${a} on this chain, so it can’t be the ${label}`);
  return a;
}

function loadArtifact() {
  const file = path.join(ART_DIR, 'PulpZap.json');
  if (!fs.existsSync(file)) stop('no compiled contract found: run npm run build first (npm run deploy:zap does it for you)');
  const art = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dbg = JSON.parse(fs.readFileSync(path.join(ART_DIR, 'PulpZap.dbg.json'), 'utf8'));
  const build = JSON.parse(fs.readFileSync(path.resolve(ART_DIR, dbg.buildInfo), 'utf8'));
  const compiled = build.input.sources[SOURCE] && build.input.sources[SOURCE].content;
  if (compiled !== fs.readFileSync(path.join(ROOT, SOURCE), 'utf8')) stop(`the compiled contract is older than ${SOURCE}: run npm run build`);
  const m = String(build.solcLongVersion || '').match(/^\d+\.\d+\.\d+\+commit\.[0-9a-f]+/);
  return { abi: art.abi, bytecode: art.bytecode, input: build.input, compiler: m ? `v${m[0]}` : null };
}

function loadConfig(file) {
  if (!file) return {};
  let j;
  try { j = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { return stop(`can’t read ${file}: ${e.message}`); }
  for (const k of Object.keys(j)) {
    if (/key|secret|mnemonic|seed|phrase/i.test(k)) stop(`${file} has a "${k}" field. keys are only ever typed at the prompt, never kept in files`);
  }
  const cfg = {};
  for (const [k, v] of Object.entries(j)) if (v !== null && v !== '' && !(typeof v === 'string' && v.startsWith('REQUIRED'))) cfg[k] = v;
  return cfg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function verifySource(explorer, address, art, args) {
  if (!art.compiler) throw new Error('unknown compiler version');
  const api = `${explorer}/api`;
  const body = new URLSearchParams({
    module: 'contract', action: 'verifysourcecode', codeformat: 'solidity-standard-json-input',
    contractaddress: address, contractname: `${SOURCE}:PulpZap`, compilerversion: art.compiler,
    sourceCode: JSON.stringify(art.input), constructorArguements: args.replace(/^0x/, ''), licenseType: '3',
  });
  let guid = null;
  for (let i = 0; !guid; i++) {
    const j = await (await fetch(api, { method: 'POST', body })).json();
    const text = `${j.result || ''} ${j.message || ''}`;
    if (/already verified/i.test(text)) return 'already verified';
    if (j.status === '1' && j.result) guid = j.result;
    else if (i >= 5) throw new Error(text.trim() || 'the explorer refused the request');
    else await sleep(6000);
  }
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const j = await (await fetch(`${api}?module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid)}`)).json();
    const r = String(j.result || '');
    if (/pass|verified/i.test(r)) return 'verified';
    if (/fail/i.test(r)) throw new Error(r);
  }
  throw new Error('the explorer is still working on it: check the address page in a few minutes');
}

/* ---------- read back + simulate (used after a deploy and by --check) ---------- */
async function readBack(provider, zapAddr, art, want, problems) {
  const zap = new ethers.Contract(zapAddr, art.abi, provider);
  const vault = new ethers.Contract(want.vault, VAULT_ABI, provider);
  const check = (label, ok, detail = '') => {
    say(`  ${ok ? green('✓') : red('✗')} ${label}${detail ? dim(`  ${detail}`) : ''}`);
    if (!ok) problems.push(`check failed: ${label}`);
  };
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const key = await zap.poolKey();
  const got = {
    poolId: await zap.poolId(), vault: await zap.vault(), pulp: await zap.pulp(), weth: await zap.weth(),
    poolManager: await zap.poolManager(), hooks: await zap.hooks(), fee: Number(await zap.fee()), tickSpacing: Number(await zap.tickSpacing()),
    feeBps: Number(await zap.zapFeeBps()), feeRecipient: await zap.feeRecipient(), owner: await zap.owner(), pending: await zap.pendingOwner(),
    cap: Number(await zap.MAX_ZAP_FEE_BPS()), minLock: await zap.minLockAmount(), launchStart: await zap.launchStart(),
    sqrtPrice: await zap.sqrtPriceX96(),
  };
  check('pool id', eq(got.poolId, want.poolId), got.poolId);
  check('pool key', eq(key.currency0, ethers.ZeroAddress) && eq(key.currency1, want.pulp) && Number(key.fee) === want.lpFee && Number(key.tickSpacing) === want.tickSpacing && eq(key.hooks, want.hooks),
    `(ETH, ${short(key.currency1)}, ${key.fee}, ${key.tickSpacing}, ${short(key.hooks)})`);
  check('pool is live', got.sqrtPrice > 0n, `sqrtPriceX96 ${got.sqrtPrice}`);
  check('vault', eq(got.vault, want.vault), got.vault);
  check('PULP = the vault’s PULP', eq(got.pulp, want.pulp) && eq(got.pulp, await vault.pulp()), got.pulp);
  check('WETH = the vault’s WETH', eq(got.weth, want.weth) && eq(got.weth, await vault.weth()), got.weth);
  check('PoolManager', eq(got.poolManager, want.poolManager), got.poolManager);
  check('hook', eq(got.hooks, want.hooks), got.hooks);
  check('zap fee', got.feeBps === want.feeBps, `${pct(got.feeBps)} (${got.feeBps} bps)`);
  check('fee recipient (treasury, also the sweep destination)', eq(got.feeRecipient, want.feeRecipient), got.feeRecipient);
  check('fee cap', got.cap === MAX_FEE_BPS, `${got.cap} bps`);
  check('minimum lock = the vault’s', got.minLock === (await vault.minLockAmount()), String(got.minLock));
  check('launch = the vault’s', got.launchStart === (await vault.launchStart()), utc(got.launchStart));
  if (want.owner) {
    if (eq(got.owner, want.owner)) check('owner', true, got.owner);
    else check(`ownership offered to ${short(want.owner)}`, eq(got.pending, want.owner), `owner stays ${short(got.owner)} until ${short(want.owner)} calls acceptOwnership()`);
  } else {
    row('owner', `${got.owner}${got.pending !== ethers.ZeroAddress ? dim(`  (pending: ${got.pending})`) : ''}`);
  }
  return got;
}

async function simulate(provider, zapAddr, art, got, from, quoter, problems) {
  const iface = new ethers.Interface(art.abi);
  const sim = await dustSimulation(provider, zapAddr, iface, {
    from, feeBps: got.feeBps, minLockAmount: got.minLock, launchStart: got.launchStart, quoter,
    pulp: got.pulp, hooks: got.hooks, lpFee: got.fee, tickSpacing: got.tickSpacing,
  });
  if (sim.note) say(yellow(`  ! ${sim.note}`));
  if (sim.problem) { say(red(`  ✗ dust zap: ${sim.problem}`)); problems.push(`dust zap: ${sim.problem}`); return sim; }
  if (!sim.ran) { problems.push('dust zap simulation skipped'); return sim; }
  const at = sim.override ? dim(' (simulated at the launch time)') : '';
  say(`  ${green('✓')} dust zap through the pool${at}: 0.000001 ETH buys ${ethers.formatUnits(sim.pulpOut)} PULP after fee and tax`);
  if (sim.quoted != null) {
    const ok = sim.quoted === sim.pulpOut;
    say(`  ${ok ? green('✓') : red('✗')} the v4 Quoter agrees${dim(`  ${ethers.formatUnits(sim.quoted)} PULP`)}`);
    if (!ok) problems.push('dust zap output differs from the Quoter');
  }
  say(`  ${sim.refund ? green('✓') : red('✗')} the OrRefund dust zap refunds (the bound is not met)`);
  return sim;
}

/* ---------- the run ---------- */
async function main() {
  const o = { ...ROBINHOOD, config: null, verify: true, dryRun: false, allowEoaOwner: false, check: null, from: null };
  let explorerSet = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) stop(`${a} needs a value`); return argv[++i]; };
    if (a === '--rpc') o.rpc = val();
    else if (a === '--chain-id') o.chainId = Number(val());
    else if (a === '--explorer') { const v = val(); o.explorer = v === 'none' ? null : v.replace(/\/+$/, ''); explorerSet = true; }
    else if (a === '--config') o.config = val();
    else if (a === '--no-verify') o.verify = false;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--allow-eoa-owner') o.allowEoaOwner = true;
    else if (a === '--check') o.check = val();
    else if (a === '--from') o.from = val();
    else if (a === '--help' || a === '-h') { say(HELP); process.exit(0); }
    else stop(`unknown option ${a} (see --help)`);
  }
  if (!Number.isInteger(o.chainId) || o.chainId <= 0) stop('--chain-id has to be a chain number');
  if (o.chainId !== ROBINHOOD.chainId && !explorerSet) o.explorer = null;
  const link = (kind, x) => (o.explorer ? `${o.explorer}/${kind}/${x}` : x);
  setupInput();

  const art = loadArtifact();
  const iface = new ethers.Interface(art.abi);
  const cfg = loadConfig(o.config);
  const known = KNOWN[o.chainId] || {};

  say(bold(`\npulp zap deploy${o.dryRun ? ' · dry run, nothing will be sent' : ''}${o.check ? ' · check only, nothing will be sent' : ''}`));
  const provider = new ethers.JsonRpcProvider(o.rpc, o.chainId, { staticNetwork: true, cacheTimeout: -1 });
  let chainId;
  try { chainId = Number(await provider.send('eth_chainId', [])); } catch (e) { stop(`can’t reach ${o.rpc}: ${e.shortMessage || e.message}`); }
  if (chainId !== o.chainId) stop(`${o.rpc} is chain ${chainId}, not ${o.chainId}. pass --chain-id ${chainId} if that’s really where you want the zap`);
  say(`\n${bold('network')}`);
  row('chain', `${chainName(chainId)} (${chainId})`);
  row('rpc', o.rpc);

  // --check: read an existing zap back and simulate, nothing else.
  if (o.check) {
    const zapAddr = await contractAt(provider, o.check, 'zap').catch((e) => stop(e.message));
    const zap = new ethers.Contract(zapAddr, art.abi, provider);
    const want = {
      vault: await zap.vault(), pulp: known.pulp || (await zap.pulp()), weth: known.weth || (await zap.weth()),
      poolManager: known.poolManager || (await zap.poolManager()), hooks: known.hooks || (await zap.hooks()),
      lpFee: known.lpFee ?? Number(await zap.fee()), tickSpacing: known.tickSpacing ?? Number(await zap.tickSpacing()),
      poolId: known.poolId || cfg.poolId || (await zap.poolId()), feeBps: Number(await zap.zapFeeBps()), feeRecipient: await zap.feeRecipient(),
      owner: cfg.owner ? toAddress(cfg.owner) : null,
    };
    const problems = [];
    say(`\n${bold('checks')}  ${dim(link('address', zapAddr))}`);
    const got = await readBack(provider, zapAddr, art, want, problems);
    const from = o.from ? toAddress(o.from) : got.feeRecipient;
    if ((await provider.getBalance(from)) < DUST) problems.push(`${from} has less than 0.000001 ETH; pass --from <an address with ETH> for the simulation`);
    else await simulate(provider, zapAddr, art, got, from, known.quoter || cfg.quoter || null, problems);
    if (problems.length) { say(yellow(`\n! ${problems.length} thing(s) to look at:`)); problems.forEach((p) => say(yellow(`  - ${p}`))); }
    else say(green('\n✓ everything checks out.'));
    provider.destroy();
    process.exit(problems.length ? 2 : 0);
  }

  // 1. the deployer
  say(`\n${bold('deployer')}`);
  const deployer = await askUntil('deployer private key (hidden)', (t) => {
    const w = toWallet(t, provider);
    if (chainId === 4663 && isHardhatAccount(w.address)) throw new Error('that is one of Hardhat’s public test keys: never use it on Robinhood Chain');
    return w;
  }, { hidden: true });
  const [balance, nonce] = await Promise.all([provider.getBalance(deployer.address), provider.getTransactionCount(deployer.address, 'pending')]);
  row('address', deployer.address);
  row('balance', `${eth(balance)} ETH, next nonce ${nonce}`);
  if (balance === 0n) stop('the deployer has no ETH for gas on this chain');

  // 2. settings
  say(`\n${bold('zap settings')}${o.config ? dim(`  (from ${o.config} where given)`) : ''}`);
  // The vault: from the config file, else the newest vault record deploy-vault.js left in deployments/ (as the
  // prompt's default, so it is confirmed with enter), else typed in.
  const vaultRecord = cfg.vault === undefined ? findVaultRecord(chainId) : null;
  if (vaultRecord) row('', dim(`vault record: ${path.relative(process.cwd(), vaultRecord.file)} (press enter to use it)`));
  const vaultAddr = await setting(cfg, 'vault', 'PulpVeVault address', (t) => contractAt(provider, t, 'vault'), vaultRecord ? vaultRecord.vault : undefined);
  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, provider);
  let vPulp, vWeth, minLock, launchStart, exitOn;
  try {
    [vPulp, vWeth, minLock, launchStart, exitOn] = await Promise.all([vault.pulp(), vault.weth(), vault.minLockAmount(), vault.launchStart(), vault.emergencyExit()]);
  } catch (e) { stop(`${vaultAddr} doesn’t answer like a PulpVeVault: ${e.shortMessage || e.message}`); }
  if (exitOn) stop('the vault’s emergency exit is on: nobody can lock there any more');
  if (known.pulp && vPulp.toLowerCase() !== known.pulp.toLowerCase()) stop(`the vault’s PULP is ${vPulp}, not ${known.pulp}`);
  if (known.weth && vWeth.toLowerCase() !== known.weth.toLowerCase()) stop(`the vault’s WETH is ${vWeth}, not ${known.weth}`);
  const pulpC = new ethers.Contract(vPulp, ERC20, provider);
  const pulpSym = await pulpC.symbol().catch(() => '?');
  row('', dim(`PULP ${vPulp} (${pulpSym}), WETH ${vWeth}, locking opens ${utc(launchStart)}`));
  const weth = await setting(cfg, 'weth', 'WETH address (must be the vault’s)', async (t) => {
    const a = await contractAt(provider, t, 'WETH');
    if (a.toLowerCase() !== vWeth.toLowerCase()) throw new Error(`the vault uses ${vWeth} as WETH`);
    return a;
  }, known.weth || vWeth);
  const poolManager = await setting(cfg, 'poolManager', 'Uniswap v4 PoolManager', (t) => contractAt(provider, t, 'PoolManager'), known.poolManager);
  const hooks = await setting(cfg, 'hooks', 'pool hook address', toAddress, known.hooks);
  const lpFee = await setting(cfg, 'lpFee', 'pool LP fee (v4 units, 0 for this pool)', (t) => { const v = Number(t); if (!Number.isInteger(v) || v < 0 || v > 0xffffff) throw new Error('a whole number below 2^24'); return v; }, known.lpFee ?? 0);
  const tickSpacing = await setting(cfg, 'tickSpacing', 'pool tick spacing', (t) => { const v = Number(t); if (!Number.isInteger(v) || v < 1 || v > 32767) throw new Error('a whole number from 1 to 32767'); return v; }, known.tickSpacing ?? 60);
  const poolId = computePoolId(vPulp, lpFee, tickSpacing, hooks);
  let expectedPoolId;
  if (known.poolId) {
    expectedPoolId = known.poolId;
    if (cfg.poolId !== undefined && toBytes32(cfg.poolId) !== known.poolId) stop(`config "poolId" ${cfg.poolId} is not the PULP pool ${known.poolId}`);
  } else {
    expectedPoolId = await setting(cfg, 'poolId', 'expected v4 pool id (0x…)', toBytes32);
  }
  if (poolId !== expectedPoolId) stop(`these settings give pool id ${poolId}, not ${expectedPoolId}: check the hook, fee and tick spacing`);
  const slot0 = BigInt(await new ethers.Contract(poolManager, PM_ABI, provider).extsload(slot0Slot(poolId)).catch(() => '0x0'));
  if ((slot0 & ((1n << 160n) - 1n)) === 0n) stop(`pool ${poolId} is not initialized on this PoolManager`);
  row('pool', `${poolId} ${green('✓ live')}`);

  const owner = await setting(cfg, 'owner', 'final owner (a multisig; it has to call acceptOwnership)', toAddress);
  const feeBps = await setting(cfg, 'zapFeeBps', `zap fee in basis points (50 = 0.5%, at most ${MAX_FEE_BPS})`, parseFeeBps, DEFAULT_FEE_BPS);
  let feeRecipient = null, standIn = false;
  feeRecipient = await setting(cfg, 'feeRecipient', `fee recipient = the treasury (also where sweep sends strays)${o.dryRun ? ', enter to leave it for later' : ''}`, (t) => {
    if (!String(t).trim()) {
      if (o.dryRun) return null;
      throw new Error('the treasury address is needed to deploy (only a dry run can leave it out)');
    }
    return toAddress(t);
  });
  if (feeRecipient === null) {
    feeRecipient = owner;
    standIn = true;
    say(yellow('  no fee recipient yet: the dry run simulates with the owner as a stand-in. a real deploy needs the treasury.'));
  }
  const settings = { vault: vaultAddr, pulp: vPulp, weth, poolManager, hooks };
  const rp = await roleProblems({ chainId, deployer: deployer.address, owner, feeRecipient, allowEoaOwner: o.allowEoaOwner, settings }, (a) => provider.getCode(a));
  if (rp.length) stop(rp.join('\n  '));
  const ownerHasCode = (await provider.getCode(owner)) !== '0x';
  if (!ownerHasCode) say(yellow(`  heads up: the owner ${owner} is a plain wallet${chainId === 4663 ? ' (allowed by --allow-eoa-owner)' : ''}. a multisig is safer.`));

  // 3. the plan: deploy owned by the deployer, then offer ownership to the final owner (two-step).
  const transfer = owner.toLowerCase() !== deployer.address.toLowerCase();
  const ctor = [poolManager, vaultAddr, weth, hooks, lpFee, tickSpacing, expectedPoolId, deployer.address, feeBps, feeRecipient];
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, deployer);
  const deployTx = await factory.getDeployTransaction(...ctor);
  try { await provider.call({ ...deployTx, from: deployer.address }); } catch (e) { stop(`the deployment would fail: ${reason(e, iface).text}`); }
  const gasDeploy = await provider.estimateGas({ ...deployTx, from: deployer.address });
  const fee = await provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const maxCost = ((gasDeploy * 12n) / 10n + (transfer ? TRANSFER_GAS : 0n)) * price;

  let ownerWallet = null;
  if (transfer && !o.dryRun && !ownerHasCode) {
    ownerWallet = await askUntil(`private key of ${short(owner)} to accept right away (hidden, enter to accept later)`, async (t) => {
      if (!t) return null;
      const w = toWallet(t, provider);
      if (w.address !== owner) throw new Error(`that key is for ${w.address}, not ${owner}`);
      if ((await provider.getBalance(owner)) === 0n) throw new Error(`${owner} has no ETH for gas: fund it, or press enter and accept later`);
      return w;
    }, { hidden: true });
  }

  const steps = ['deploy the zap (owned by the deployer)'];
  if (transfer) steps.push(`offer ownership to ${owner} (two-step: it only counts after acceptOwnership)`);
  if (ownerWallet) steps.push(`accept ownership as ${owner}`);
  say(`\n${bold('plan')}`);
  row('chain', `${chainName(chainId)} (${chainId})`);
  row('deployer', deployer.address);
  row('vault', vaultAddr);
  row('pool', `${poolId}  ${dim(`(ETH, ${short(vPulp)}, fee ${lpFee}, spacing ${tickSpacing}, hook ${short(hooks)})`)}`);
  row('PoolManager', poolManager);
  row('WETH', weth);
  row('owner', `${owner}${ownerHasCode ? dim(' (contract)') : yellow(' (plain wallet)')}`);
  row('zap fee', feeBps === 0 ? 'none' : `${pct(feeBps)} (${feeBps} bps), capped at 2%`);
  row('fee recipient', standIn ? yellow('not set yet (stand-in: the owner)') : `${feeRecipient} ${dim('(treasury; sweep goes here too)')}`);
  say(`\n${bold('transactions')}`);
  steps.forEach((s, i) => say(`  ${i + 1}. ${s}`));
  row('max cost', `${eth(maxCost)} ETH ${dim(`(deployer has ${eth(balance)})`)}`);
  row('simulation', green('the deployment goes through'));
  say(dim('  a dust zap is simulated with eth_call right after the deploy (or later with --check <zap>).'));
  if (balance < maxCost) stop(`the deployer needs about ${eth(maxCost)} ETH and has ${eth(balance)}`);
  if (o.dryRun) {
    say(green('\n✓ dry run: everything checks out. run it again without --dry-run to deploy.'));
    say(dim('  nothing was sent.'));
    process.exit(0);
  }
  const go = await ask('\ntype "deploy" to send these transactions, anything else cancels');
  if (go !== 'deploy') { say('cancelled. nothing was sent.'); process.exit(0); }

  // 4. send
  say(`\n${bold('sending')}`);
  let nextNonce = await provider.getTransactionCount(deployer.address, 'pending');
  sent = true;
  let contract, receipt;
  try {
    contract = await factory.deploy(...ctor, { nonce: nextNonce });
    nextNonce++;
    say(`  deploy        ${dim(link('tx', contract.deploymentTransaction().hash))}`);
    receipt = await contract.deploymentTransaction().wait(1, WAIT_MS);
  } catch (e) { stop(`the deployment failed: ${reason(e, iface).text}`); }
  const address = await contract.getAddress();
  say(green(`  ✓ zap deployed at ${address}`));
  const zap = new ethers.Contract(address, art.abi, deployer);
  const problems = [];
  async function step(label, sendIt, own = true) {
    try {
      const tx = await sendIt(own ? { nonce: nextNonce } : {});
      if (own) nextNonce++;
      say(`  ${label}  ${dim(link('tx', tx.hash))}`);
      const r = await tx.wait(1, WAIT_MS);
      if (!r || r.status !== 1) throw new Error('the transaction reverted');
      say(green(`  ✓ ${label}`));
      return true;
    } catch (e) {
      problems.push(`${label}: ${reason(e, iface).text}`);
      say(red(`  ✗ ${label}: ${reason(e, iface).text}`));
      return false;
    }
  }
  let handed = false;
  if (transfer) handed = await step(`offer ownership to ${short(owner)}`, (ov) => zap.transferOwnership(owner, ov));
  if (ownerWallet && handed) await step('accept ownership', () => zap.connect(ownerWallet).acceptOwnership(), false);

  // 5. read back + dust simulation
  say(`\n${bold('checks')}`);
  const want = { vault: vaultAddr, pulp: vPulp, weth, poolManager, hooks, lpFee, tickSpacing, poolId: expectedPoolId, feeBps, feeRecipient, owner };
  const got = await readBack(provider, address, art, want, problems);
  await simulate(provider, address, art, got, deployer.address, known.quoter || cfg.quoter || null, problems);

  // 6. record (deployments/ is not part of the source)
  const ctorArgs = iface.encodeDeploy(ctor);
  const record = {
    network: chainName(chainId), chainId, rpc: o.rpc, zap: address, deployTx: receipt.hash, block: receipt.blockNumber,
    deployer: deployer.address, settings: { vault: vaultAddr, pulp: vPulp, weth, poolManager, hooks, lpFee, tickSpacing, poolId: expectedPoolId, zapFeeBps: feeBps, feeRecipient, finalOwner: owner },
    owner: got.owner, pendingOwner: got.pending === ethers.ZeroAddress ? null : got.pending,
    compiler: art.compiler, constructorArgs: ctorArgs, deployedAt: new Date().toISOString(), problems,
  };
  fs.mkdirSync(path.join(ROOT, 'deployments'), { recursive: true });
  const recordFile = path.join(ROOT, 'deployments', `${chainId}-${address}.json`);
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  say(`\n${bold('saved')}`);
  row('record', path.relative(process.cwd(), recordFile));

  if (o.explorer && o.verify) {
    say(`\n${bold('source verification')}`);
    try { say(green(`  ✓ ${await verifySource(o.explorer, address, art, ctorArgs)}`)); } catch (e) {
      const inputFile = path.join(ROOT, 'deployments', `${chainId}-${address}-standard-input.json`);
      fs.writeFileSync(inputFile, JSON.stringify(art.input));
      say(yellow(`  couldn’t verify automatically: ${e.message}`));
      row('compiler', art.compiler);
      row('contract', `${SOURCE}:PulpZap`);
      row('input file', path.relative(process.cwd(), inputFile));
      row('constructor', ctorArgs.replace(/^0x/, ''));
    }
  }

  say(`\n${bold('next')}`);
  let n = 1;
  if (transfer && !(ownerWallet && got.owner === owner)) say(`  ${n++}. from ${owner}, call acceptOwnership() on the zap. until then the deployer stays owner.`);
  say(`  ${n++}. after locking opens (${utc(launchStart)}): npm run deploy:zap -- --check ${address}${chainId !== 4663 ? ` --rpc ${o.rpc} --chain-id ${chainId}` : ''}`);
  say(`  ${n++}. point your frontend at the zap: ${link('address', address)}`);
  if (problems.length) { say(yellow(`\n! ${problems.length} thing(s) to look at:`)); problems.forEach((p) => say(yellow(`  - ${p}`))); }
  provider.destroy();
  process.exit(problems.length ? 2 : 0);
}

if (require.main === module) main().catch((e) => stop(e?.shortMessage || e?.message || String(e)));
