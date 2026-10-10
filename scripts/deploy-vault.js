#!/usr/bin/env node
/* Deploys PulpVeVault with your own keys, sets it up, checks every setting on-chain, verifies the
   source on the explorer and, if asked, points a frontend's lock/config.js at the new vault.

     npm run deploy:vault -- --dry-run               rehearse: every check, the simulation and the cost, sends nothing
     npm run deploy:vault                            deploy to Robinhood Chain, asking for everything
     npm run deploy:vault -- --config vault.json     take the vault settings from a file (same shape as config/vault.example.json)
     npm run deploy:vault -- --site <frontend dir>   also write the new vault address into <dir>/lock/config.js
     npm run deploy:vault -- --check-handover 0x…    has the owner accepted? (non-zero until it has; after launch - 1h: 1)

   other flags: --rpc <url>  --chain-id <id>  --explorer <url|none>  --no-verify  --allow-eoa-owner  --force
                --wait-handover  --owner <addr>  --treasury <addr>  --deployer <addr> (for --check-handover)

   Ownership is always handed over in two steps: the vault is deployed owned by the deployer, set up, then
   offered to the final owner, who must call acceptOwnership() at least an hour before locking opens.

   Private keys are only ever typed into a hidden prompt. They are never read from arguments,
   environment variables or files, never written anywhere and never printed. Nothing is sent until the
   plan has been shown, the deployment has been simulated and you type "deploy". */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..');
const ART_DIR = path.join(ROOT, 'artifacts/contracts/PulpVeVault.sol');
const SOURCE = 'contracts/PulpVeVault.sol';
const ROBINHOOD = { rpc: 'https://rpc.mainnet.chain.robinhood.com', chainId: 4663, explorer: 'https://robinhoodchain.blockscout.com' };
const ERC20 = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const LAUNCH_MIN_AHEAD = 2 * 3600; // seconds: deploy, then at least an hour for the owner to accept, before launch
const HANDOVER_BEFORE_LAUNCH = 3600; // the final owner has to have accepted by launch - 1h
const DAY = 86400;
const SETUP_GAS = 150_000n; // per setup call, only for the up-front cost check
const WAIT_MS = 10 * 60 * 1000; // how long each transaction may take to confirm
const MAX_FEE_BPS = 200; // the contract's MAX_COMPOUND_FEE_BPS (2%)
// Contracts on Robinhood Chain that can never be the final owner or the treasury (tokens can't sign, and
// whatever reached them would be stuck). The PULP and WETH entered at the prompt are refused as well.
const KNOWN_ADDRESSES = new Map([
  ['0xBc2283d12B1f2f46c1613AE672E95C55b69Ca414', '$pulp'],
  ['0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 'WETH'],
  ['0x8366a39cc670b4001a1121b8f6a443a643e40951', 'the Uniswap v4 PoolManager (it holds the $pulp / ETH pool)'],
].map(([a, name]) => [ethers.getAddress(a.toLowerCase()), name]));
// Hardhat's and Anvil's default accounts: their keys are public, and on Robinhood Chain they are 7702-delegated
// to sweepers. Never a deployer or a role there.
// The first 1,000 of them (accounts #20 and up come from the same public mnemonic and are swept too).
const PUBLIC_TEST_ACCOUNTS = 1000;
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';
let testAccounts = null;
function publicTestAccounts() {
  if (!testAccounts) {
    const root = ethers.HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, "m/44'/60'/0'/0");
    testAccounts = new Set(Array.from({ length: PUBLIC_TEST_ACCOUNTS }, (_, i) => root.deriveChild(i).address));
  }
  return testAccounts;
}
// Config file keys, in the same units as the prompts. Old keys in contract units are refused by name.
const CONFIG_KEYS = ['pulp', 'weth', 'owner', 'distributor', 'treasury', 'launchStart', 'earlyWindowHours',
  'minLockAmountTokens', 'compoundFeeBps', 'pulpRewards', 'extraDistributors'];
const OLD_KEYS = { earlyWindow: 'earlyWindowHours (hours)', minLockAmount: 'minLockAmountTokens (whole PULP)', feeRecipient: 'treasury' };

const HELP = `usage: npm run deploy:vault -- [options]

  --dry-run              run every check and the simulation, show the plan and cost, send nothing
  --config <file>        vault settings from a JSON file shaped like config/vault.example.json, in the prompts'
                         units (launchStart as a 00:00 UTC date or unix time, earlyWindowHours, minLockAmountTokens)
  --allow-eoa-owner      on Robinhood Chain, accept a final owner with no contract code (a multisig is expected)
  --force                accept a minimum lock under 1 token or a launch bonus window under 1 hour
  --wait-handover        after deploying, wait until the final owner accepts (or launch - 1h passes)
  --check-handover <vault>  only check that vault's ownership handover; exits 0 once accepted by the expected
                         owner with no treasury change pending. the expected owner, treasury and deployer come
                         from deployments/<chain>-<vault>.json, or from:
    --owner <addr>       the final owner that should hold the vault
    --treasury <addr>    the treasury the vault was deployed with
    --deployer <addr>    the deployer, which must no longer own it
  --site <dir>           after deploying, write the vault address into <dir>/lock/config.js
  --rpc <url>            default ${ROBINHOOD.rpc}
  --chain-id <id>        the chain the RPC must be on (default ${ROBINHOOD.chainId})
  --explorer <url|none>  blockscout explorer for links and verification (default ${ROBINHOOD.explorer})
  --no-verify            skip source verification`;

/* ---------- output ---------- */
const tint = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tint ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint(1), dim = paint(2), red = paint(31), green = paint(32), yellow = paint(33);
const say = (s = '') => process.stdout.write(`${s}\n`);
const row = (k, v) => say(`  ${k.padEnd(17)}${v}`);
let sent = false;

function stop(msg) {
  out.muted = false;
  say(red(`\n✗ ${msg}`));
  say(sent ? yellow('  transactions were already sent: check the explorer before running this again.') : dim('  nothing was sent.'));
  process.exit(1);
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const utc = (t) => `${new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
const hours = (s) => `${+(s / 3600).toFixed(2)} hours`;
function tokens(v, decimals) {
  const [i, f = ''] = ethers.formatUnits(v, decimals).split('.');
  const frac = f.replace(/0+$/, '');
  return `${BigInt(i).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
}
const eth = (v) => Number(ethers.formatEther(v)).toLocaleString('en-US', { maximumSignificantDigits: 4 });
function ahead(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.round((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const chainName = (id) => (id === 4663 ? 'Robinhood Chain' : id === 31337 ? 'local test chain' : `chain ${id}`);

/* ---------- input: one line at a time, typed characters hidden for keys ---------- */
const out = new Writable({ write(chunk, enc, cb) { if (!out.muted) process.stdout.write(chunk, enc); cb(); } });
out.muted = false;
const tty = !!process.stdin.isTTY;
// opened on the first question, so requiring this file (the tests do) never touches stdin
let rl = null, lines = null;
function input() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: out, terminal: tty, historySize: 0 });
    lines = rl[Symbol.asyncIterator]();
    rl.on('SIGINT', () => {
      out.muted = false;
      say(sent ? yellow('\nstopped. transactions already sent may still confirm: check the explorer.') : '\ncancelled. nothing was sent.');
      process.exit(130);
    });
  }
  return rl;
}

async function ask(question, { hidden = false, def = null } = {}) {
  input().setPrompt(def != null && def !== '' ? `${question} [${def}]: ` : `${question}: `);
  rl.prompt();
  out.muted = hidden;
  const { value, done } = await lines.next();
  out.muted = false;
  if (done) stop('input ended before the deploy was confirmed');
  if (hidden && tty) process.stdout.write('\n');
  if (!tty) say(hidden ? '(hidden)' : value); // keep piped runs readable
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

// a setting from --config if it's there, otherwise asked for. the file uses the prompts' units
async function setting(cfg, key, question, parse, def) {
  if (cfg[key] === undefined) return askUntil(question, parse, { def });
  try {
    const v = await parse(Array.isArray(cfg[key]) ? cfg[key].join(',') : String(cfg[key]));
    say(`${question}: ${dim('from the config file')}`);
    return v;
  } catch (e) { return stop(`config "${key}": ${e.message}`); }
}

/* ---------- parsing ---------- */
function toAddress(text) {
  const t = String(text).trim();
  if (!ethers.isAddress(t)) throw new Error('that isn’t a valid address');
  const a = ethers.getAddress(t);
  if (a === ethers.ZeroAddress) throw new Error('the zero address can’t be used here');
  return a;
}

function toWallet(text, provider) {
  let k = String(text).trim();
  if (!k) throw new Error('no key entered');
  if (!/^0x/i.test(k)) k = `0x${k}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error('that isn’t a private key (64 hex characters)');
  try { return new ethers.Wallet(k, provider); } catch { throw new Error('that isn’t a usable private key'); }
}

async function erc20(provider, text, label) {
  const address = toAddress(text);
  if ((await provider.getCode(address)) === '0x') throw new Error(`there’s no contract at ${address} on this chain`);
  const c = new ethers.Contract(address, ERC20, provider);
  const decimals = await c.decimals().catch(() => null);
  if (decimals == null) throw new Error(`${address} doesn’t answer decimals(), so it can’t be the ${label} token`);
  const symbol = await c.symbol().catch(() => '?');
  return { address, symbol, decimals: Number(decimals) };
}

// 00:00 UTC only: a date (2026-10-12, optionally with 00:00) or a unix time that is a whole day.
// A date that doesn't exist (2026-02-30, 2026-13-01, 24:00) is refused, never rolled over.
function parseLaunch(text, chainNow) {
  const t = String(text).trim().toLowerCase();
  let ts, m;
  if (/^\d{9,11}$/.test(t)) {
    ts = Number(t);
  } else if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(?:utc|z)?$/))) {
    const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] || 0));
    const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
      throw new Error(`${m[0].trim()} isn’t a real date and time: check the day of the month`);
    }
    ts = date.getTime() / 1000;
  } else {
    throw new Error('use a UTC date like 2026-10-12 (locking opens at 00:00 UTC) or a unix timestamp');
  }
  if (!Number.isInteger(ts) || ts % DAY !== 0) throw new Error(`locking has to open at 00:00 UTC (${utc(ts)} isn’t): the vault refuses anything else`);
  if (ts < chainNow + LAUNCH_MIN_AHEAD) throw new Error(`that’s too soon: the owner needs time to accept before launch - 1h. pick a day at least ${LAUNCH_MIN_AHEAD / 3600} hours after the chain’s clock (${utc(chainNow)})`);
  if (ts > chainNow + 365 * DAY) throw new Error('that’s more than a year away');
  return ts;
}

const nextMidnight = (chainNow) => (Math.floor((chainNow + LAUNCH_MIN_AHEAD) / DAY) + 1) * DAY;

function parseHours(text, force) {
  const h = Number(String(text).trim());
  if (!Number.isFinite(h) || h <= 0 || h > 720) throw new Error('give a number of hours above 0 and at most 720');
  if (h < 1 && !force) throw new Error('a launch bonus window under 1 hour is almost certainly a units mistake (pass --force if it is meant)');
  return Math.round(h * 3600);
}

function parseFeeBps(text) {
  const t = String(text).trim();
  const v = Number(t);
  if (!/^\d+$/.test(t) || v > MAX_FEE_BPS) throw new Error(`the compound fee is in basis points: a whole number from 0 to ${MAX_FEE_BPS} (2%)`);
  return v;
}
const pct = (bps) => `${+(bps / 100).toFixed(2)}%`;

function parseAmount(text, decimals) {
  let v;
  try { v = ethers.parseUnits(String(text).trim().replace(/[,_\s]/g, ''), decimals); } catch { throw new Error('give a plain number, like 1000'); }
  if (v <= 0n) throw new Error('it has to be more than 0');
  return v;
}

function parseMinLock(text, decimals, force) {
  const v = parseAmount(text, decimals);
  if (v < 10n ** BigInt(decimals) && !force) throw new Error('a minimum lock under 1 token is almost certainly a units mistake: it is in whole tokens (pass --force if it is meant)');
  return v;
}

function yesNo(text) {
  const t = String(text).trim().toLowerCase();
  if (['y', 'yes', 'true'].includes(t)) return true;
  if (['n', 'no', 'false'].includes(t)) return false;
  throw new Error('answer y or n');
}

const addressList = (text) => [...new Set(String(text).split(/[\s,]+/).filter(Boolean).map(toAddress))];

// the contract's custom errors by name, so a failed simulation or call says why
function reason(e, iface) {
  const data = [e?.data, e?.info?.error?.data, e?.error?.data, e?.info?.error?.data?.data]
    .find((d) => typeof d === 'string' && /^0x[0-9a-f]{8}/i.test(d));
  if (data) {
    try { const p = iface.parseError(data); if (p) return p.args.length ? `${p.name}(${p.args.join(', ')})` : p.name; } catch { /* not one of ours */ }
  }
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

/* ---------- build output ---------- */
function loadArtifact() {
  const file = path.join(ART_DIR, 'PulpVeVault.json');
  if (!fs.existsSync(file)) stop('no compiled contract found: run npm run build first (npm run deploy:vault does it for you)');
  const art = JSON.parse(fs.readFileSync(file, 'utf8'));
  const dbg = JSON.parse(fs.readFileSync(path.join(ART_DIR, 'PulpVeVault.dbg.json'), 'utf8'));
  const build = JSON.parse(fs.readFileSync(path.resolve(ART_DIR, dbg.buildInfo), 'utf8'));
  const compiled = build.input.sources[SOURCE] && build.input.sources[SOURCE].content;
  if (compiled !== fs.readFileSync(path.join(ROOT, SOURCE), 'utf8')) stop(`the compiled contract is older than ${SOURCE}: run npm run build`);
  const m = String(build.solcLongVersion || '').match(/^\d+\.\d+\.\d+\+commit\.[0-9a-f]+/); // drop solc-js's ".Emscripten.clang"
  return { abi: art.abi, bytecode: art.bytecode, input: build.input, compiler: m ? `v${m[0]}` : null };
}

function loadConfig(file) {
  if (!file) return {};
  let j;
  try { j = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { return stop(`can’t read ${file}: ${e.message}`); }
  for (const k of Object.keys(j)) {
    if (/key|secret|mnemonic|seed|phrase/i.test(k)) stop(`${file} has a "${k}" field. keys are only ever typed at the prompt, never kept in files`);
  }
  for (const k of Object.keys(j)) {
    if (OLD_KEYS[k]) stop(`${file}: "${k}" was in contract units; use ${OLD_KEYS[k]}, the same units as the prompt`);
    if (!CONFIG_KEYS.includes(k)) stop(`${file}: unknown setting "${k}" (known: ${CONFIG_KEYS.join(', ')})`);
  }
  const cfg = {};
  for (const [k, v] of Object.entries(j)) if (v !== null && v !== '' && !(typeof v === 'string' && v.startsWith('REQUIRED'))) cfg[k] = v;
  return cfg;
}

/* ---------- after the deploy ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// blockscout's etherscan-style API, with the exact standard-JSON input this build was compiled from
async function verifySource(explorer, address, art, args) {
  if (!art.compiler) throw new Error('unknown compiler version');
  const api = `${explorer}/api`;
  const body = new URLSearchParams({
    module: 'contract', action: 'verifysourcecode', codeformat: 'solidity-standard-json-input',
    contractaddress: address, contractname: `${SOURCE}:PulpVeVault`, compilerversion: art.compiler,
    sourceCode: JSON.stringify(art.input), constructorArguements: args.replace(/^0x/, ''), licenseType: '3',
  });
  let guid = null;
  for (let i = 0; !guid; i++) { // a brand-new contract can take a few seconds to be indexed
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

function pointSite(dir, address, chainId) {
  const file = path.join(path.resolve(dir), 'lock', 'config.js');
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return say(yellow(`  no lock/config.js in ${dir}: set vault: '${address}' there by hand.`)); }
  const id = src.match(/\bid:\s*(\d+)/);
  if (!id || Number(id[1]) !== chainId) return say(yellow(`  ${file} is set up for chain ${id ? id[1] : '?'}, not ${chainId}, so it was left alone.`));
  const line = /(\bvault:\s*)(null|'0x[0-9a-fA-F]{40}'|"0x[0-9a-fA-F]{40}")/;
  if (!line.test(src)) return say(yellow(`  couldn’t find the vault line in ${file}: set vault: '${address}' by hand.`));
  fs.writeFileSync(file, src.replace(line, `$1'${address}'`));
  return say(green(`  ✓ ${file} now points at the vault`));
}

/* ---------- roles and the ownership handover ---------- */
const isEoaCode = (code) => code === '0x' || /^0xef0100/i.test(code); // 7702-delegated accounts are still EOAs

// Is `address` a usable final owner on this chain? On Robinhood Chain it has to be a contract (a multisig),
// not a plain or 7702-delegated EOA, unless --allow-eoa-owner.
async function ownerCheck(provider, address, chainId, allowEoa) {
  const code = await provider.getCode(address);
  const eoa = isEoaCode(code);
  if (chainId === ROBINHOOD.chainId && eoa && !allowEoa) {
    throw new Error(`${address} is ${code === '0x' ? 'not a contract' : 'a 7702-delegated EOA'}: the owner should be a multisig. pass --allow-eoa-owner if a single key is really meant`);
  }
  return eoa;
}

function refuseTestAccount(chainId, address, label) {
  if (chainId === ROBINHOOD.chainId && publicTestAccounts().has(address)) {
    throw new Error(`${address} is one of Hardhat's public test accounts (anyone has its key; on Robinhood Chain it is a 7702 sweeper): never the ${label}`);
  }
}

// Never a token or pool contract: the known Robinhood Chain ones, plus the PULP and WETH given (`tokens`).
function refuseKnownAddress(address, label, tokens = {}) {
  for (const [name, a] of Object.entries(tokens)) {
    if (a && address === a) throw new Error(`${address} is the ${name} token: it can’t be the ${label}`);
  }
  const known = KNOWN_ADDRESSES.get(address);
  if (known) throw new Error(`${address} is ${known}: it can’t be the ${label}`);
}

// The final owner: given (no default), never the deployer, a public test account, a token or the pool.
function checkFinalOwner(address, { deployer, pulp, weth, chainId }) {
  refuseTestAccount(chainId, address, 'owner');
  if (address === deployer) throw new Error('the final owner can’t be the deployer: give the multisig that will own the vault');
  refuseKnownAddress(address, 'owner', { PULP: pulp, WETH: weth });
  return address;
}

// The treasury: never a token, the pool or the vault. It may be an EOA (main() prints a note).
function checkTreasuryAddress(address, { pulp, weth, vault, chainId }) {
  refuseTestAccount(chainId, address, 'treasury');
  refuseKnownAddress(address, 'treasury', { PULP: pulp, WETH: weth });
  if (address === vault) throw new Error('the treasury can’t be the vault itself');
  return address;
}

// Who should hold the vault, from the flags or else the deployments/ record of that vault.
function readRecord(chainId, vault, dir = path.join(ROOT, 'deployments')) {
  const file = path.join(dir, `${chainId}-${vault}.json`);
  if (!fs.existsSync(file)) return null;
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (r.vault && ethers.getAddress(r.vault) !== vault) throw new Error(`${file} is the record of ${r.vault}, not ${vault}`);
  return { file, owner: r.settings?.finalOwner, treasury: r.settings?.treasury, deployer: r.deployer };
}

function expectedHandover(flags, record) {
  const pick = (k) => (flags[k] ? toAddress(flags[k]) : record?.[k] ? ethers.getAddress(record[k]) : null);
  const want = { owner: pick('owner'), treasury: pick('treasury'), deployer: pick('deployer') };
  if (!want.owner) throw new Error('who should own the vault? pass --owner <multisig>, or run this where deployments/ has the vault’s record');
  if (!want.treasury) throw new Error('which treasury was it deployed with? pass --treasury <address>, or run this where deployments/ has the vault’s record');
  if (want.deployer && want.owner === want.deployer) throw new Error('the expected owner is the deployer: that is never a finished handover');
  return want;
}

// Everything the handover check reads from the chain.
async function handoverState(vault, provider) {
  const [owner, pending, launch, treasury, pendingTreasury] = await Promise.all([
    vault.owner(), vault.pendingOwner(), vault.launchStart(), vault.treasury(), vault.pendingTreasury()]);
  const [block, code] = await Promise.all([provider.getBlock('latest'), provider.getCode(owner)]);
  const deadline = Number(launch) - HANDOVER_BEFORE_LAUNCH;
  return { owner, pending, treasury, pendingTreasury, launch: Number(launch), deadline, now: block.timestamp, ownerIsEoa: isEoaCode(code) };
}

// The verdict, from plain values: 0 accepted, 3 offered to the right owner and not yet due, 1 anything else.
// Accepted means nothing pending AND the owner is the expected final owner AND not the deployer (AND, on
// Robinhood Chain, a contract unless --allow-eoa-owner). With an expected treasury, also no treasury change
// pending and the treasury still the deployed one.
// want: { owner, deployer?, treasury?, chainId, allowEoa }
function evaluateHandover(h, want) {
  const msgs = [];
  const fail = (t) => msgs.push(['fail', t]);
  const zero = ethers.ZeroAddress;
  let pendingOk = false, accepted = false;
  if (h.pending !== zero) {
    if (h.pending !== want.owner) fail(`ownership is offered to ${h.pending}, not to the final owner ${want.owner}. offer it again with transferOwnership(${want.owner}).`);
    else if (h.now >= h.deadline) fail(`${h.pending} has NOT accepted ownership, and launch - 1h (${utc(h.deadline)}) has passed. ${h.owner} still owns the vault. accept now from the multisig, or pause locks / do not announce until it has.`);
    else {
      pendingOk = true;
      msgs.push(['wait', `${h.pending} has not accepted ownership yet. it must call acceptOwnership() before ${utc(h.deadline)} (in ${ahead(h.deadline - h.now)}). until then ${h.owner} owns the vault.`]);
    }
  } else if (want.deployer && h.owner === want.deployer) {
    fail(`the deployer ${h.owner} still owns the vault and nothing is offered: the transferOwnership(${want.owner}) step didn't land. send it again from the deployer.`);
  } else if (h.owner !== want.owner) {
    fail(`the vault is owned by ${h.owner}, not by the final owner ${want.owner}.`);
  } else if (want.chainId === ROBINHOOD.chainId && h.ownerIsEoa && !want.allowEoa) {
    fail(`the owner ${h.owner} has no contract code (an EOA, or 7702-delegated): it should be a multisig. pass --allow-eoa-owner if a single key is really meant.`);
  } else {
    accepted = true;
    msgs.push(['ok', `ownership accepted: the owner is ${h.owner}${h.ownerIsEoa ? ' (an EOA)' : ''}`]);
  }
  if (want.treasury) {
    if (h.pendingTreasury !== zero) fail(`a treasury change to ${h.pendingTreasury} is pending: cancel it with proposeTreasury(0x0) from the owner unless it is really meant.`);
    if (h.treasury !== want.treasury) fail(`the treasury is ${h.treasury}, not the deployed ${want.treasury}.`);
  }
  const failed = msgs.some(([k]) => k === 'fail');
  return { code: failed ? 1 : accepted ? 0 : pendingOk ? 3 : 1, accepted: accepted && !failed, msgs };
}

function reportHandover(h, want) {
  const e = evaluateHandover(h, want);
  for (const [kind, text] of e.msgs) say(kind === 'ok' ? green(`  ✓ ${text}`) : kind === 'wait' ? yellow(`  ! ${text}`) : red(`  ✗ ${text}`));
  if (e.code === 3) say(yellow('    check with: npm run deploy:vault -- --check-handover <vault>'));
  return e;
}

async function waitHandover(vault, provider, want) {
  for (;;) {
    const h = await handoverState(vault, provider);
    if (evaluateHandover(h, want).code !== 3) return h;
    say(dim(`  waiting for ${short(h.pending)} to accept (deadline ${utc(h.deadline)})…`));
    await sleep(30_000);
  }
}

/* ---------- the run ---------- */
async function main() {
  const o = { ...ROBINHOOD, config: null, site: null, verify: true, dryRun: false, allowEoaOwner: false, force: false, check: null, wait: false, expect: {} };
  let explorerSet = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) stop(`${a} needs a value`); return argv[++i]; };
    if (a === '--rpc') o.rpc = val();
    else if (a === '--chain-id') o.chainId = Number(val());
    else if (a === '--explorer') { const v = val(); o.explorer = v === 'none' ? null : v.replace(/\/+$/, ''); explorerSet = true; }
    else if (a === '--config') o.config = val();
    else if (a === '--site') o.site = val();
    else if (a === '--no-verify') o.verify = false;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--allow-eoa-owner') o.allowEoaOwner = true;
    else if (a === '--force') o.force = true;
    else if (a === '--wait-handover') o.wait = true;
    else if (a === '--check-handover') o.check = val();
    else if (a === '--owner' || a === '--treasury' || a === '--deployer') o.expect[a.slice(2)] = val();
    else if (a === '--help' || a === '-h') { say(HELP); process.exit(0); }
    else stop(`unknown option ${a} (see --help)`);
  }
  if (!Number.isInteger(o.chainId) || o.chainId <= 0) stop('--chain-id has to be a chain number');
  if (Object.keys(o.expect).length && !o.check) stop('--owner, --treasury and --deployer only go with --check-handover');
  if (o.chainId !== ROBINHOOD.chainId && !explorerSet) o.explorer = null; // robinhood's explorer can't see other chains
  const link = (kind, x) => (o.explorer ? `${o.explorer}/${kind}/${x}` : x);

  const art = loadArtifact();
  const iface = new ethers.Interface(art.abi);

  // 1. the chain
  // no request cache: on a fast chain a cached nonce or balance can be stale by the next transaction
  const provider = new ethers.JsonRpcProvider(o.rpc, o.chainId, { staticNetwork: true, cacheTimeout: -1 });
  let chainId;
  try { chainId = Number(await provider.send('eth_chainId', [])); } catch (e) { stop(`can’t reach ${o.rpc}: ${e.shortMessage || e.message}`); }
  if (chainId !== o.chainId) stop(`${o.rpc} is chain ${chainId}, not ${o.chainId}. pass --chain-id ${chainId} if that’s really where you want the vault`);

  // only the handover check: no key, nothing sent
  if (o.check) {
    let address;
    try { address = toAddress(o.check); } catch (e) { stop(`--check-handover: ${e.message}`); }
    let want, record;
    try {
      record = readRecord(chainId, address);
      want = { ...expectedHandover(o.expect, record), chainId, allowEoa: o.allowEoaOwner };
    } catch (e) { stop(`--check-handover: ${e.message}`); }
    const vault = new ethers.Contract(address, art.abi, provider);
    say(bold(`\nownership handover · ${chainName(chainId)} · ${address}`));
    let h;
    try { h = o.wait ? await waitHandover(vault, provider, want) : await handoverState(vault, provider); } catch (e) { stop(`can’t read the vault: ${e.shortMessage || e.message}`); }
    row('expected from', record ? path.relative(process.cwd(), record.file) + (Object.keys(o.expect).length ? ' and the flags' : '') : 'the flags');
    row('final owner', want.owner);
    row('treasury', want.treasury);
    row('deployer', want.deployer || dim('unknown (no record, no --deployer)'));
    row('locking opens', utc(h.launch));
    row('accept by', utc(h.deadline));
    const { code } = reportHandover(h, want);
    provider.destroy();
    process.exit(code);
  }

  const cfg = loadConfig(o.config);
  say(bold(`\npulp vault deploy${o.dryRun ? ' · dry run, nothing will be sent' : ''}`));
  say(`\n${bold('network')}`);
  row('chain', `${chainName(chainId)} (${chainId})`);
  row('rpc', o.rpc);

  // 2. the deployer
  say(`\n${bold('deployer')}`);
  const deployer = await askUntil('deployer private key (hidden)', (t) => {
    const w = toWallet(t, provider);
    refuseTestAccount(chainId, w.address, 'deployer (its key is public)');
    return w;
  }, { hidden: true });
  const [balance, nonce] = await Promise.all([provider.getBalance(deployer.address), provider.getTransactionCount(deployer.address, 'pending')]);
  row('address', deployer.address);
  row('balance', `${eth(balance)} ETH, next nonce ${nonce}`);
  if (balance === 0n) stop('the deployer has no ETH for gas on this chain');
  const predicted = ethers.getCreateAddress({ from: deployer.address, nonce });

  // 3. the vault's settings
  say(`\n${bold('vault settings')}${o.config ? dim(`  (from ${o.config} where given)`) : ''}`);
  const pulp = await setting(cfg, 'pulp', 'PULP token address', (t) => erc20(provider, t, 'PULP'));
  row('', dim(`${pulp.symbol}, ${pulp.decimals} decimals`));
  if (!/pulp/i.test(pulp.symbol)) say(yellow(`  heads up: that token’s symbol is ${pulp.symbol}, not PULP. check the address before you confirm.`));
  const weth = await setting(cfg, 'weth', 'WETH (wrapped ETH) address on this chain', async (t) => {
    const w = await erc20(provider, t, 'WETH');
    if (w.address === pulp.address) throw new Error('WETH and PULP have to be different tokens');
    // the vault wraps native fees with deposit(), so make sure this token really takes ETH
    try { await provider.call({ from: deployer.address, to: w.address, data: '0xd0e30db0', value: 1n }); } catch { throw new Error(`${w.address} (${w.symbol}) doesn’t take ETH through deposit(), so it isn’t wrapped ETH`); }
    return w;
  });
  row('', dim(`${weth.symbol}, ${weth.decimals} decimals`));
  const role = (label) => (t) => { const a = toAddress(t); refuseTestAccount(chainId, a, label); return a; };
  const distributor = await setting(cfg, 'distributor', 'fee distributor (the wallet that sends trading fees to the vault)', role('fee distributor'), deployer.address);
  // no default: the final owner is always given, and is never the deployer's hot key, a token or the pool
  const owner = await setting(cfg, 'owner', 'final owner (a Safe multisig; it accepts ownership itself, in a second step)', async (t) => {
    const a = checkFinalOwner(toAddress(t), { deployer: deployer.address, pulp: pulp.address, weth: weth.address, chainId });
    const eoa = await ownerCheck(provider, a, chainId, o.allowEoaOwner);
    if (eoa) say(yellow(`  heads up: ${a} has no contract code${chainId === ROBINHOOD.chainId ? ' (allowed by --allow-eoa-owner)' : ''}. a multisig is safest.`));
    return a;
  });
  // no default: everything the owner can ever recover goes here, and only here
  const treasury = await setting(cfg, 'treasury', 'treasury (receives the compound fee and everything recovered; a Safe multisig)',
    (t) => checkTreasuryAddress(toAddress(t), { pulp: pulp.address, weth: weth.address, vault: predicted, chainId }));
  if (treasury === deployer.address) say(yellow('  heads up: the treasury is the deployer’s hot key. a multisig is safest; it can be changed later (two-step, 8-day delay).'));
  else if (isEoaCode(await provider.getCode(treasury))) say(yellow(`  note: the treasury ${treasury} is an EOA (no contract code): one key receives the compound fee and every recovery. allowed, but a multisig is safest; changing it later takes 8 days.`));
  const chainNow = (await provider.getBlock('latest')).timestamp;
  const launchStart = await setting(cfg, 'launchStart', 'locking opens on (a UTC date; it opens at 00:00 UTC; or a unix time)', (t) => parseLaunch(t, chainNow),
    new Date(nextMidnight(chainNow) * 1000).toISOString().slice(0, 10));
  const earlyWindow = await setting(cfg, 'earlyWindowHours', 'launch bonus: hours for 2× to fall to 1×', (t) => parseHours(t, o.force), 24);
  const minLock = await setting(cfg, 'minLockAmountTokens', `minimum lock in whole ${pulp.symbol}`, (t) => parseMinLock(t, pulp.decimals, o.force), 35000);
  const pulpRewards = await setting(cfg, 'pulpRewards', `also pay rewards in ${pulp.symbol}? (y/n)`, yesNo, 'y');
  const extras = (await setting(cfg, 'extraDistributors', 'more wallets allowed to send fees, comma separated (enter for none)',
    (t) => addressList(t).map((a) => role('fee distributor')(a)), ''))
    .filter((a) => a !== distributor);
  const feeBps = await setting(cfg, 'compoundFeeBps', `compound fee in basis points (100 = 1%, at most ${MAX_FEE_BPS}); paid to the treasury`, parseFeeBps, 100);

  // 4. the plan: the deployer owns the vault while it's set up, then offers it to the final owner
  const config = {
    pulp: pulp.address, weth: weth.address, owner: deployer.address, distributor, launchStart, earlyWindow,
    minLockAmount: minLock, compoundFeeBps: feeBps, treasury,
  };
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, deployer);
  const deployTx = await factory.getDeployTransaction(config);
  try { await provider.call({ ...deployTx, from: deployer.address }); } catch (e) { stop(`the deployment would fail: ${reason(e, iface)}`); }
  const gasDeploy = await provider.estimateGas({ ...deployTx, from: deployer.address });

  const steps = ['deploy the vault (owned by the deployer while it is set up)'];
  if (pulpRewards) steps.push(`add ${pulp.symbol} as a reward token`);
  extras.forEach((a) => steps.push(`allow ${a} to send fees`));
  steps.push(`offer ownership to ${owner} (it then calls acceptOwnership(), at the latest by ${utc(launchStart - HANDOVER_BEFORE_LAUNCH)})`);
  const fee = await provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const maxCost = ((gasDeploy * 12n) / 10n + SETUP_GAS * BigInt(steps.length - 1)) * price;

  say(`\n${bold('plan')}`);
  row('chain', `${chainName(chainId)} (${chainId})`);
  row('deployer', deployer.address);
  row('PULP', `${pulp.address}  ${dim(`${pulp.symbol}, ${pulp.decimals} decimals`)}`);
  row('WETH', `${weth.address}  ${dim(`${weth.symbol}, ${weth.decimals} decimals`)}`);
  row('fees sent by', [distributor, ...extras].join(', '));
  row('final owner', `${owner} ${dim('(two-step: offered here, accepted by the owner)')}`);
  row('treasury', `${treasury} ${dim('(compound fee and every recovery; changes only two-step, 8 days after a proposal)')}`);
  row('locking opens', `${utc(launchStart)} ${dim(`(in ${ahead(launchStart - chainNow)})`)}`);
  row('owner accepts by', utc(launchStart - HANDOVER_BEFORE_LAUNCH));
  row('launch bonus', `2× at launch, falling to 1× over ${hours(earlyWindow)}`);
  row('minimum lock', `${tokens(minLock, pulp.decimals)} ${pulp.symbol}`);
  row('rewards paid in', pulpRewards ? `${weth.symbol} and ${pulp.symbol}` : weth.symbol);
  row('compound fee', feeBps === 0 ? 'none' : `${pct(feeBps)} (${feeBps} bps) of compounded ${pulp.symbol}, to the treasury`);
  say(`\n${bold('transactions')}`);
  steps.forEach((s, i) => say(`  ${i + 1}. ${s}`));
  row('max cost', `${eth(maxCost)} ETH ${dim(`(deployer has ${eth(balance)})`)}`);
  row('simulation', green('the deployment goes through'));
  if (balance < maxCost) stop(`the deployer needs about ${eth(maxCost)} ETH and has ${eth(balance)}`);

  if (o.dryRun) {
    say(green('\n✓ dry run: everything checks out. run it again without --dry-run to deploy.'));
    say(dim('  nothing was sent.'));
    process.exit(0);
  }

  const go = await ask('\ntype "deploy" to send these transactions, anything else cancels');
  if (go !== 'deploy') { say('cancelled. nothing was sent.'); process.exit(0); }
  const latest = (await provider.getBlock('latest')).timestamp;
  if (launchStart < latest + LAUNCH_MIN_AHEAD) stop('the launch is now too close for the owner to accept in time (time passed while waiting). run again with a later day');

  // 5. send. the deployer's nonces are counted here, and only once a transaction has actually gone out
  say(`\n${bold('sending')}`);
  let nextNonce = await provider.getTransactionCount(deployer.address, 'pending');
  sent = true;
  let contract, receipt;
  try {
    contract = await factory.deploy(config, { nonce: nextNonce });
    nextNonce++;
    say(`  deploy        ${dim(link('tx', contract.deploymentTransaction().hash))}`);
    receipt = await contract.deploymentTransaction().wait(1, WAIT_MS);
  } catch (e) { stop(`the deployment failed: ${reason(e, iface)}`); }
  const address = await contract.getAddress();
  say(green(`  ✓ vault deployed at ${address}`));

  const vault = new ethers.Contract(address, art.abi, deployer);
  const problems = [];
  async function step(label, sendIt) {
    try {
      const tx = await sendIt({ nonce: nextNonce });
      nextNonce++;
      say(`  ${label}  ${dim(link('tx', tx.hash))}`);
      const r = await tx.wait(1, WAIT_MS);
      if (!r || r.status !== 1) throw new Error('the transaction reverted');
      say(green(`  ✓ ${label}`));
      return true;
    } catch (e) {
      problems.push(`${label}: ${reason(e, iface)}`);
      say(red(`  ✗ ${label}: ${reason(e, iface)}`));
      return false;
    }
  }
  if (pulpRewards) await step(`add ${pulp.symbol} as a reward token`, (ov) => vault.addRewardToken(pulp.address, ov));
  for (const a of extras) await step(`allow ${short(a)} to send fees`, (ov) => vault.setDistributor(a, true, ov));
  await step(`offer ownership to ${short(owner)}`, (ov) => vault.transferOwnership(owner, ov));

  // 6. read every setting back from the chain
  say(`\n${bold('checks')}`);
  const got = {
    pulp: await vault.pulp(), weth: await vault.weth(), launchStart: Number(await vault.launchStart()),
    earlyWindow: Number(await vault.earlyWindow()), minLock: await vault.minLockAmount(),
    rewards: await vault.getRewardTokens(), owner: await vault.owner(), pending: await vault.pendingOwner(),
    feeBps: Number(await vault.compoundFeeBps()), treasury: await vault.treasury(), pendingTreasury: await vault.pendingTreasury(),
    emergencyExit: await vault.emergencyExit(), locksPaused: await vault.locksPaused(),
    retired: await vault.getRetiredRewardTokens(),
    treasuryDelay: Number(await vault.TREASURY_DELAY()),
  };
  const check = (label, ok, detail = '') => {
    say(`  ${ok ? green('✓') : red('✗')} ${label}${detail ? dim(`  ${detail}`) : ''}`);
    if (!ok) problems.push(`check failed: ${label}`);
  };
  check('PULP token', got.pulp === pulp.address, got.pulp);
  check('WETH', got.weth === weth.address, got.weth);
  check('locking opens at 00:00 UTC', got.launchStart === launchStart && got.launchStart % DAY === 0, utc(got.launchStart));
  check('launch bonus window', got.earlyWindow === earlyWindow, hours(got.earlyWindow));
  check('minimum lock', got.minLock === minLock, `${tokens(got.minLock, pulp.decimals)} ${pulp.symbol}`);
  check('compound fee', got.feeBps === feeBps, `${pct(got.feeBps)} (${got.feeBps} bps)`);
  check('treasury', got.treasury === treasury && got.pendingTreasury === ethers.ZeroAddress, got.treasury);
  check('locks not paused', got.locksPaused === false, String(got.locksPaused));
  // One-way switch, off at deploy: if it were on, nobody could ever lock in this vault.
  check('emergency exit off', got.emergencyExit === false, String(got.emergencyExit));
  for (const a of [distributor, ...extras]) check(`${short(a)} can send fees`, await vault.isDistributor(a));
  const want = [weth.address, ...(pulpRewards ? [pulp.address] : [])];
  const names = got.rewards.map((a) => (a === weth.address ? weth.symbol : a === pulp.address ? pulp.symbol : a)).join(', ');
  check('reward tokens', got.rewards.length === want.length && want.every((a) => got.rewards.includes(a)), names);
  check('no retired reward tokens', got.retired.length === 0);
  check('treasury delay', got.treasuryDelay === 8 * DAY, `${got.treasuryDelay / DAY} days after a proposal`);
  check(`ownership offered to ${short(owner)}`, got.pending === owner && got.owner === deployer.address,
    `pendingOwner ${got.pending}; the deployer owns it until ${short(owner)} calls acceptOwnership()`);

  // 7. a record of what was deployed (deployments/ is gitignored)
  const ctorArgs = iface.encodeDeploy([config]);
  const record = {
    network: chainName(chainId), chainId, rpc: o.rpc, explorer: o.explorer,
    vault: address, deployTx: receipt.hash, block: receipt.blockNumber, deployer: deployer.address,
    settings: { pulp: pulp.address, weth: weth.address, distributor, extraDistributors: extras, treasury, launchStart, earlyWindowHours: earlyWindow / 3600, minLockAmount: minLock.toString(), compoundFeeBps: feeBps, pulpRewards, finalOwner: owner },
    owner: got.owner, pendingOwner: got.pending === ethers.ZeroAddress ? null : got.pending, acceptBy: launchStart - HANDOVER_BEFORE_LAUNCH,
    rewardTokens: got.rewards, compiler: art.compiler, constructorArgs: ctorArgs, deployedAt: new Date().toISOString(), problems,
  };
  fs.mkdirSync(path.join(ROOT, 'deployments'), { recursive: true });
  const recordFile = path.join(ROOT, 'deployments', `${chainId}-${address}.json`);
  fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  say(`\n${bold('saved')}`);
  row('record', path.relative(process.cwd(), recordFile));

  // 8. verify the source so anyone can read the contract on the explorer
  if (o.explorer && o.verify) {
    say(`\n${bold('source verification')}`);
    try {
      say(green(`  ✓ ${await verifySource(o.explorer, address, art, ctorArgs)}`));
    } catch (e) {
      const inputFile = path.join(ROOT, 'deployments', `${chainId}-${address}-standard-input.json`);
      fs.writeFileSync(inputFile, JSON.stringify(art.input));
      say(yellow(`  couldn’t verify automatically: ${e.message}`));
      say(`  do it by hand: ${link('address', address)} → verify & publish → solidity, standard JSON input`);
      row('compiler', art.compiler);
      row('contract', `${SOURCE}:PulpVeVault`);
      row('input file', path.relative(process.cwd(), inputFile));
      row('constructor', ctorArgs.replace(/^0x/, ''));
    }
  }

  // 9. the site
  if (o.site) { say(`\n${bold('site')}`); pointSite(o.site, address, chainId); }

  // 10. the handover: never accepted here; the owner has to do it by launch - 1h
  say(`\n${bold('ownership handover')}`);
  const expected = { owner, deployer: deployer.address, treasury, chainId, allowEoa: o.allowEoaOwner };
  const h = o.wait ? await waitHandover(vault, provider, expected) : await handoverState(vault, provider);
  const { code: handover, accepted } = reportHandover(h, expected);

  say(`\n${bold('next')}`);
  let n = 1;
  if (!accepted) say(`  ${n++}. from ${owner}, call acceptOwnership() on the vault before ${utc(h.deadline)}. check: npm run deploy:vault -- --check-handover ${address}`);
  say(o.site
    ? `  ${n++}. publish the frontend so it uses the vault.`
    : `  ${n++}. point your frontend at the vault: ${address}`);
  say(`  ${n++}. deploy the zap next (optional): npm run deploy:zap reads this vault from deployments/.`);
  say(`  ${n++}. fund rewards from ${short(distributor)}: call notifyRewardETH() on the vault with ETH attached (about 250k gas; don't cap it lower). it’s wrapped to ${weth.symbol} and shared out over the next 7 days; once a week is enough.`);
  if (pulpRewards) say(`     ${pulp.symbol} fees: approve the vault, then call notifyRewardAmount(${pulp.address}, amount). never send tokens to the vault directly.`);
  say(`  locking opens ${utc(launchStart)}. vault: ${link('address', address)}`);
  if (problems.length) {
    say(yellow(`\n! ${problems.length} thing${problems.length > 1 ? 's' : ''} to look at:`));
    problems.forEach((p) => say(yellow(`  - ${p}`)));
  }
  provider.destroy();
  process.exit(problems.length ? 2 : handover === 1 ? 1 : 0);
}

if (require.main === module) main().catch((e) => stop(e?.shortMessage || e?.message || String(e)));

// pure helpers, for the unit tests (test/deploy.test.js)
module.exports = {
  KNOWN_ADDRESSES, parseLaunch, checkFinalOwner, checkTreasuryAddress, refuseKnownAddress, isEoaCode,
  readRecord, expectedHandover, handoverState, evaluateHandover,
};
