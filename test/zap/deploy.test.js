// scripts/deploy-zap.js: pure helpers (always) and, with DEPLOY_E2E=1 (npm run test:deploy), a full run of the script
// against a local Hardhat node it spawns, driven through stdin with Hardhat's public test keys only.
const { expect } = require('chai');
const { ethers, network, artifacts } = require('hardhat');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../../scripts/deploy-zap.js');

const WAD = 10n ** 18n;
const DAY = 86400n;
const HOOKS = '0x4Bc7Ba3a253d048Dc36C17Ac3f4E6484dAD120CC';
const ROOT = path.resolve(__dirname, '../..');
const MNEMONIC = 'test test test test test test test test test test test junk';
const hhKey = (i) => ethers.HDNodeWallet.fromPhrase(MNEMONIC, '', "m/44'/60'/0'/0").deriveChild(i).privateKey;

// Vault treasury: a dedicated account (Hardhat's #9), distinct from the deployer/owner/zap roles used in these tests.
const VAULT_TREASURY = new ethers.Wallet(hhKey(9)).address;

// The vault needs launchStart at 00:00 UTC: use the next midnight after the current block. Tests advance to
// `launch` (see `openLocking`) wherever locking must be open.
async function localSetup(provider, deployer) {
  const fac = async (name, ...args) => {
    const a = await artifacts.readArtifact(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const pulp = await fac('MockERC20', 'PULP', 'PULP', 18);
  const weth = await fac('MockWETH9');
  const now = BigInt((await provider.getBlock('latest')).timestamp);
  const launch = (now / DAY + 1n) * DAY;
  const vault = await fac('PulpVeVault', {
    pulp: await pulp.getAddress(), weth: await weth.getAddress(), owner: await deployer.getAddress(), distributor: await deployer.getAddress(),
    launchStart: launch, earlyWindow: DAY, minLockAmount: 1000n * WAD, compoundFeeBps: 0, treasury: VAULT_TREASURY,
  });
  const pm = await fac('MockPoolManager', await pulp.getAddress(), HOOKS, 0, 60, 2_000_000n * WAD);
  await (await pulp.mint(await pm.getAddress(), 10n ** 30n)).wait();
  return { pulp, weth, vault, pm, launch, poolId: D.computePoolId(await pulp.getAddress(), 0, 60, HOOKS) };
}

// Mine a block at the vault's launch time (00:00 UTC) so locking is open. `send` is a JSON-RPC sender.
async function openLocking(send, launch) {
  await send('evm_setNextBlockTimestamp', [Number(launch)]);
  await send('evm_mine', []);
}

describe('scripts/deploy-zap.js', function () {
  describe('pure helpers', function () {
    it('computePoolId gives the real Robinhood pool id; slot0Slot matches the PoolManager layout the zap reads', async function () {
      const k = D.KNOWN[4663];
      expect(D.computePoolId(k.pulp, k.lpFee, k.tickSpacing, k.hooks)).to.equal(k.poolId);
      expect(D.computePoolId(k.pulp, k.lpFee, 10, k.hooks)).to.not.equal(k.poolId);
      await network.provider.send('hardhat_reset');
      const [d] = await ethers.getSigners();
      const s = await localSetup(ethers.provider, d);
      expect(BigInt(await s.pm.extsload(D.slot0Slot(s.poolId)))).to.equal(await s.pm.sqrtPriceX96());
    });

    it('recognises Hardhat’s public accounts; parses the fee; validates addresses and pool ids', async function () {
      const signers = await ethers.getSigners();
      for (const sg of signers.slice(0, 20)) expect(D.isHardhatAccount(sg.address)).to.equal(true);
      expect(D.isHardhatAccount(ethers.Wallet.createRandom().address)).to.equal(false);
      expect(D.parseFeeBps('50')).to.equal(50);
      expect(D.parseFeeBps('0')).to.equal(0);
      expect(D.parseFeeBps('200')).to.equal(200);
      for (const bad of ['201', '1.5', '-1', 'x', '']) expect(() => D.parseFeeBps(bad)).to.throw();
      expect(() => D.toAddress(ethers.ZeroAddress)).to.throw();
      expect(() => D.toAddress('0x1234')).to.throw();
      expect(D.toBytes32(D.KNOWN[4663].poolId.toUpperCase().replace('0X', '0x'))).to.equal(D.KNOWN[4663].poolId);
      expect(() => D.toBytes32('0x1234')).to.throw();
    });

    it('findVaultRecord: the newest vault record for the chain from deployments/, ignoring zap records and other chains', function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zap-vault-record-'));
      try {
        expect(D.findVaultRecord(4663, dir)).to.equal(null);
        const w = (name, j) => fs.writeFileSync(path.join(dir, name), JSON.stringify(j));
        const a = (b) => '0x' + b.repeat(20);
        w(`4663-${a('11')}.json`, { chainId: 4663, vault: a('11'), deployedAt: '2026-10-01T00:00:00.000Z' });
        w(`4663-${a('22')}.json`, { chainId: 4663, vault: a('22'), deployedAt: '2026-10-02T00:00:00.000Z' });
        w(`4663-${a('33')}.json`, { chainId: 4663, zap: a('33'), settings: { vault: a('44') }, deployedAt: '2026-10-03T00:00:00.000Z' });
        w(`31337-${a('55')}.json`, { chainId: 31337, vault: a('55'), deployedAt: '2026-10-04T00:00:00.000Z' });
        w(`4663-${a('66')}-standard-input.json`, { vault: a('66') });
        w(`4663-${a('77')}.json`, 'not json');
        expect(D.findVaultRecord(4663, dir).vault).to.equal(ethers.getAddress(a('22')));
        expect(D.findVaultRecord(31337, dir).vault).to.equal(ethers.getAddress(a('55')));
        expect(D.findVaultRecord(1, dir)).to.equal(null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('role rules: on 4663 no Hardhat accounts and a contract owner unless --allow-eoa-owner; never a protocol address as fee recipient or owner', async function () {
      const [hh0, hh1, hh2] = await ethers.getSigners();
      const k = D.KNOWN[4663];
      const settings = { vault: '0x' + '11'.repeat(20), pulp: k.pulp, weth: k.weth, poolManager: k.poolManager, hooks: k.hooks };
      const multisig = ethers.Wallet.createRandom().address;
      const eoa = ethers.Wallet.createRandom().address;
      const treasury = ethers.Wallet.createRandom().address;
      const dep = ethers.Wallet.createRandom().address;
      const codeAt = async (a) => (a === multisig ? '0x6080' : '0x');
      const rp = (o) => D.roleProblems({ chainId: 4663, deployer: dep, owner: multisig, feeRecipient: treasury, allowEoaOwner: false, settings, ...o }, codeAt);
      expect(await rp({})).to.deep.equal([]);
      expect((await rp({ deployer: hh0.address })).join()).to.match(/deployer .* Hardhat test account/);
      expect((await rp({ owner: hh1.address, allowEoaOwner: true })).join()).to.match(/owner .* Hardhat test account/);
      expect((await rp({ feeRecipient: hh2.address })).join()).to.match(/fee recipient .* Hardhat test account/);
      expect((await rp({ owner: eoa })).join()).to.match(/no code/);
      expect(await rp({ owner: eoa, allowEoaOwner: true })).to.deep.equal([]);
      for (const bad of [settings.vault, k.pulp, k.weth, k.poolManager, k.hooks]) {
        expect((await rp({ feeRecipient: bad })).join()).to.match(/fee recipient .* protocol contracts/);
      }
      expect((await rp({ owner: k.weth, allowEoaOwner: true })).join()).to.match(/owner .* protocol contracts/);
      // Elsewhere (a local test chain) Hardhat accounts and plain-wallet owners are fine.
      expect(await D.roleProblems({ chainId: 31337, deployer: hh0.address, owner: hh1.address, feeRecipient: hh2.address, allowEoaOwner: false, settings }, codeAt)).to.deep.equal([]);
    });

    it('dustSimulation: the strict dust zap reaches the swap (InsufficientOutput with pulpOut > 0) and the OrRefund one refunds', async function () {
      await network.provider.send('hardhat_reset');
      const [d, owner, treasury] = await ethers.getSigners();
      const s = await localSetup(ethers.provider, d); // launches at the next 00:00 UTC
      const Zap = await ethers.getContractFactory('PulpZap');
      const zap = await Zap.deploy(await s.pm.getAddress(), await s.vault.getAddress(), await s.weth.getAddress(), HOOKS, 0, 60, s.poolId, owner.address, 50, treasury.address);
      const opts = { from: d.address, feeBps: 50, minLockAmount: 1000n * WAD, launchStart: await s.vault.launchStart(), quoter: null, pulp: await s.pulp.getAddress(), hooks: HOOKS, lpFee: 0, tickSpacing: 60 };
      // Before launch: needs a block-time override; Hardhat's eth_call may not support it, then it is reported as skipped.
      const pre = await D.dustSimulation(ethers.provider, await zap.getAddress(), Zap.interface, opts);
      if (process.env.SHOW_DEPLOY) console.log('      pre-launch simulation:', pre);
      expect(pre.override).to.equal(true);
      expect(pre.problem).to.equal(null);
      if (!pre.ran) expect(pre.note).to.match(/can’t simulate at the launch time/);
      await openLocking((m, a) => network.provider.send(m, a), s.launch); // advance to the midnight launch
      const sim = await D.dustSimulation(ethers.provider, await zap.getAddress(), Zap.interface, opts);
      expect(sim.ran).to.equal(true);
      expect(sim.problem).to.equal(null);
      const net = 10n ** 12n - (10n ** 12n * 50n) / 10_000n;
      const gross = (net * 2_000_000n * WAD) / WAD;
      expect(sim.pulpOut).to.equal(gross - (gross * 300n) / 10_000n);
      expect(sim.refund).to.equal(true);
      // A broken pool path is reported, not hidden.
      await s.pm.setPartialFill(true);
      const broken = await D.dustSimulation(ethers.provider, await zap.getAddress(), Zap.interface, opts);
      expect(broken.problem).to.match(/UnexpectedSwapDelta/);
    });
  });

  (process.env.DEPLOY_E2E === '1' ? describe : describe.skip)('end to end against a local Hardhat node (Hardhat test keys only)', function () {
    this.timeout(300_000);
    const PORT = 18545 + Math.floor(Math.random() * 1000);
    const RPC = `http://127.0.0.1:${PORT}`;
    let node, provider, s, cfgDir, created = [];

    before(async function () {
      node = spawn(process.execPath, [require.resolve('hardhat/internal/cli/cli'), 'node', '--hostname', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT, env: { ...process.env, FORK: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        let buf = '';
        const t = setTimeout(() => reject(new Error(`node did not start: ${buf.slice(-500)}`)), 120_000);
        const on = (d) => { buf += d; if (/Started HTTP/.test(buf)) { clearTimeout(t); resolve(); } };
        node.stdout.on('data', on); node.stderr.on('data', on);
        node.on('exit', (c) => { clearTimeout(t); reject(new Error(`node exited ${c}: ${buf.slice(-500)}`)); });
      });
      provider = new ethers.JsonRpcProvider(RPC, 31337, { staticNetwork: true });
      s = await localSetup(provider, await provider.getSigner(0));
      await openLocking((m, a) => provider.send(m, a), s.launch); // locking open (midnight launch), so the dust simulation runs for real
      cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapdeploy-'));
    });

    after(async function () {
      if (node) node.kill();
      for (const f of created) fs.rmSync(f, { force: true });
      const dep = path.join(ROOT, 'deployments');
      if (fs.existsSync(dep) && fs.readdirSync(dep).length === 0) fs.rmdirSync(dep);
      if (cfgDir) fs.rmSync(cfgDir, { recursive: true, force: true });
    });

    function run(args, input) {
      return new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(ROOT, 'scripts/deploy-zap.js'), '--rpc', RPC, '--chain-id', '31337', ...args], { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' } });
        let outp = '';
        p.stdout.on('data', (d) => { outp += d; });
        p.stderr.on('data', (d) => { outp += d; });
        p.on('exit', (code) => resolve({ code, out: outp }));
        p.stdin.end(input);
      });
    }
    async function config(over = {}) {
      const owner = new ethers.Wallet(hhKey(3)).address;
      const treasury = new ethers.Wallet(hhKey(4)).address;
      const c = { vault: await s.vault.getAddress(), weth: await s.weth.getAddress(), poolManager: await s.pm.getAddress(), hooks: HOOKS, lpFee: 0, tickSpacing: 60, poolId: s.poolId, owner, zapFeeBps: 50, feeRecipient: treasury, ...over };
      const f = path.join(cfgDir, `cfg-${Math.random().toString(16).slice(2)}.json`);
      fs.writeFileSync(f, JSON.stringify(c));
      return { file: f, owner, treasury };
    }
    const deployerAddr = () => new ethers.Wallet(hhKey(1)).address;

    it('--dry-run: every check and the simulation, nothing sent', async function () {
      const { file } = await config();
      const nonce = await provider.getTransactionCount(deployerAddr());
      const r = await run(['--dry-run', '--config', file], `${hhKey(1)}\n`);
      expect(r.code, r.out).to.equal(0);
      expect(r.out).to.match(/dry run: everything checks out/);
      expect(r.out).to.not.include(hhKey(1).slice(2)); // the key is never echoed
      expect(await provider.getTransactionCount(deployerAddr())).to.equal(nonce);
    });

    it('takes the vault from the vault deployment record in deployments/ when the config has none (dry run)', async function () {
      const vault = await s.vault.getAddress();
      const dep = path.join(ROOT, 'deployments');
      fs.mkdirSync(dep, { recursive: true });
      const rec = path.join(dep, `31337-${vault}.json`);
      created.push(rec);
      fs.writeFileSync(rec, JSON.stringify({ network: 'local test chain', chainId: 31337, vault, deployedAt: new Date().toISOString() }));
      const { file } = await config({ vault: undefined });
      const nonce = await provider.getTransactionCount(deployerAddr());
      const r = await run(['--dry-run', '--config', file], `${hhKey(1)}\n\n`); // enter = the vault from the record
      expect(r.code, r.out).to.equal(0);
      expect(r.out).to.include(`vault record: deployments/31337-${vault}.json`);
      expect(r.out).to.match(new RegExp(`vault\\s+${vault}`));
      expect(r.out).to.match(/dry run: everything checks out/);
      expect(await provider.getTransactionCount(deployerAddr())).to.equal(nonce);
      fs.rmSync(rec, { force: true });
    });

    it('refuses a pool id that the settings do not produce, and a protocol address as fee recipient; nothing sent', async function () {
      const nonce = await provider.getTransactionCount(deployerAddr());
      const bad = await config({ poolId: D.KNOWN[4663].poolId });
      let r = await run(['--config', bad.file], `${hhKey(1)}\ndeploy\n`);
      expect(r.code).to.equal(1);
      expect(r.out).to.match(/give pool id 0x[0-9a-f]{64}, not 0xdd086a55/);
      const sink = await config({ feeRecipient: await s.vault.getAddress() });
      r = await run(['--config', sink.file], `${hhKey(1)}\ndeploy\n`);
      expect(r.code).to.equal(1);
      expect(r.out).to.match(/fee recipient .* protocol contracts/);
      const wrongTs = await config({ tickSpacing: 10 });
      r = await run(['--config', wrongTs.file], `${hhKey(1)}\ndeploy\n`);
      expect(r.code).to.equal(1);
      expect(await provider.getTransactionCount(deployerAddr())).to.equal(nonce);
    });

    it('anything but "deploy" at the confirmation cancels', async function () {
      const { file } = await config();
      const nonce = await provider.getTransactionCount(deployerAddr());
      const r = await run(['--config', file], `${hhKey(1)}\n\nyes\n`);
      expect(r.code).to.equal(0);
      expect(r.out).to.match(/cancelled\. nothing was sent/);
      expect(await provider.getTransactionCount(deployerAddr())).to.equal(nonce);
    });

    it('deploys, hands ownership over two-step (accepted with the owner key), reads everything back and simulates a dust zap; --check agrees', async function () {
      const { file, owner, treasury } = await config();
      const r = await run(['--config', file], `${hhKey(1)}\n${hhKey(3)}\ndeploy\n`);
      if (process.env.SHOW_DEPLOY) console.log(r.out);
      expect(r.code, r.out).to.equal(0);
      const addr = r.out.match(/zap deployed at (0x[0-9a-fA-F]{40})/)[1];
      created.push(path.join(ROOT, 'deployments', `31337-${addr}.json`));
      expect(r.out).to.match(/✓ pool id/);
      expect(r.out).to.match(/✓ dust zap through the pool: 0\.000001 ETH buys 1\.93\d* PULP/);
      expect(r.out).to.match(/✓ the OrRefund dust zap refunds/);
      expect(r.out).to.not.match(/✗/);
      expect(r.out).to.not.include(hhKey(1).slice(2)); // keys are never echoed
      const a = await artifacts.readArtifact('PulpZap');
      const zap = new ethers.Contract(addr, a.abi, provider);
      expect(await zap.owner()).to.equal(owner);
      expect(await zap.pendingOwner()).to.equal(ethers.ZeroAddress);
      expect(await zap.feeRecipient()).to.equal(treasury);
      expect(await zap.zapFeeBps()).to.equal(50n);
      expect(await zap.poolId()).to.equal(s.poolId);
      const rec = JSON.parse(fs.readFileSync(created[created.length - 1], 'utf8'));
      expect(rec.problems).to.deep.equal([]);
      expect(JSON.stringify(rec)).to.not.include(hhKey(1).slice(2));
      const c = await run(['--check', addr, '--from', deployerAddr()], '');
      expect(c.code, c.out).to.equal(0);
      expect(c.out).to.match(/everything checks out/);
    });

    it('without the owner key the ownership stays offered (pendingOwner) and the run says what is left to do', async function () {
      const { file, owner } = await config();
      const r = await run(['--config', file], `${hhKey(1)}\n\ndeploy\n`);
      expect(r.code, r.out).to.equal(0);
      const addr = r.out.match(/zap deployed at (0x[0-9a-fA-F]{40})/)[1];
      created.push(path.join(ROOT, 'deployments', `31337-${addr}.json`));
      expect(r.out).to.match(/✓ ownership offered to/);
      expect(r.out).to.match(/call acceptOwnership\(\) on the zap/);
      const a = await artifacts.readArtifact('PulpZap');
      const zap = new ethers.Contract(addr, a.abi, provider);
      expect(await zap.owner()).to.equal(deployerAddr());
      expect(await zap.pendingOwner()).to.equal(owner);
    });
  });
});
