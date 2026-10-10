// scripts/deploy-vault.js helpers (re-review L-3, I-5): calendar dates, refused owner/treasury addresses, and the
// handover verdict. Unit level: nothing is deployed to any real network and no key is involved.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('chai');
const { ethers, fixture } = require('./helpers');
const d = require('../../scripts/deploy-vault.js');

const ZERO = ethers.ZeroAddress;
const addr = (n) => ethers.getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const [OWNER, DEPLOYER, TREASURY, OTHER, PULP_LOCAL, WETH_LOCAL] = [0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6].map(addr);
const PULP_RH = '0xBc2283d12B1f2f46c1613AE672E95C55b69Ca414';
const WETH_RH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const POOL_MANAGER = ethers.getAddress('0x8366a39cc670b4001a1121b8f6a443a643e40951');
const HARDHAT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

describe('deploy-vault.js: launch dates (I-5)', function () {
  const chainNow = Date.UTC(2026, 0, 10) / 1000; // 2026-01-10 00:00 UTC
  it('accepts real dates at 00:00 UTC, including a leap day', function () {
    expect(d.parseLaunch('2026-03-01', chainNow)).to.equal(Date.UTC(2026, 2, 1) / 1000);
    expect(d.parseLaunch('2026-2-28 00:00 UTC', chainNow)).to.equal(Date.UTC(2026, 1, 28) / 1000);
    expect(d.parseLaunch(String(Date.UTC(2026, 5, 30) / 1000), chainNow)).to.equal(Date.UTC(2026, 5, 30) / 1000);
    expect(d.parseLaunch('2026-12-31', chainNow)).to.equal(Date.UTC(2026, 11, 31) / 1000);
    const later = Date.UTC(2027, 6, 1) / 1000;
    expect(d.parseLaunch('2028-02-29', later)).to.equal(Date.UTC(2028, 1, 29) / 1000);
  });
  it('refuses dates that do not exist instead of rolling them over', function () {
    for (const bad of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-03-00', '2026-03-32',
      '2026-03-01 24:00', '2026-03-01 00:60', '2026-03-01 00:00:60']) {
      expect(() => d.parseLaunch(bad, chainNow), bad).to.throw(/isn’t a real date/);
    }
  });
  it('still refuses anything but 00:00 UTC, too soon, or more than a year away', function () {
    expect(() => d.parseLaunch('2026-03-01 01:00', chainNow)).to.throw(/00:00 UTC/);
    expect(() => d.parseLaunch(String(chainNow + 3600), chainNow)).to.throw(/00:00 UTC/);
    expect(() => d.parseLaunch('2026-01-10', chainNow)).to.throw(/too soon/);
    expect(() => d.parseLaunch('2027-02-01', chainNow)).to.throw(/more than a year/);
    expect(() => d.parseLaunch('10/03/2026', chainNow)).to.throw(/use a UTC date/);
  });
});

describe('deploy-vault.js: owner and treasury addresses (I-5)', function () {
  const ctx = { deployer: DEPLOYER, pulp: PULP_LOCAL, weth: WETH_LOCAL, chainId: 4663 };
  it('the final owner is never the deployer, PULP, WETH, a known token or pool, or a public test key', function () {
    expect(d.checkFinalOwner(OWNER, ctx)).to.equal(OWNER);
    expect(() => d.checkFinalOwner(DEPLOYER, ctx)).to.throw(/deployer/);
    expect(() => d.checkFinalOwner(PULP_LOCAL, ctx)).to.throw(/PULP token/);
    expect(() => d.checkFinalOwner(WETH_LOCAL, ctx)).to.throw(/WETH token/);
    // The real Robinhood Chain contracts are refused whatever tokens were entered.
    for (const known of [PULP_RH, WETH_RH, POOL_MANAGER]) {
      expect(() => d.checkFinalOwner(known, ctx), known).to.throw(/can’t be the owner/);
      expect(() => d.checkFinalOwner(known, { ...ctx, chainId: 31337 }), known).to.throw(/can’t be the owner/);
    }
    expect(d.KNOWN_ADDRESSES.get(POOL_MANAGER)).to.match(/PoolManager/);
    expect(() => d.checkFinalOwner(HARDHAT_0, ctx)).to.throw(/public test accounts/);
    expect(d.checkFinalOwner(HARDHAT_0, { ...ctx, chainId: 31337 })).to.equal(HARDHAT_0); // fine on a local chain
  });
  it('the treasury may be any other address, EOAs included, but never a token, the pool or the vault', function () {
    const t = { pulp: PULP_LOCAL, weth: WETH_LOCAL, vault: OTHER, chainId: 4663 };
    expect(d.checkTreasuryAddress(TREASURY, t)).to.equal(TREASURY);
    expect(d.checkTreasuryAddress(DEPLOYER, t)).to.equal(DEPLOYER); // allowed, with a warning in main()
    for (const bad of [PULP_LOCAL, WETH_LOCAL, PULP_RH, WETH_RH, POOL_MANAGER, OTHER, HARDHAT_0]) {
      expect(() => d.checkTreasuryAddress(bad, t), bad).to.throw();
    }
  });
  it('tells EOAs (plain or 7702-delegated) from contracts', function () {
    expect(d.isEoaCode('0x')).to.equal(true);
    expect(d.isEoaCode(`0xef0100${'ab'.repeat(20)}`)).to.equal(true);
    expect(d.isEoaCode('0x6080604052')).to.equal(false);
  });
});

describe('deploy-vault.js: the handover verdict (L-3)', function () {
  const base = { owner: OWNER, pending: ZERO, treasury: TREASURY, pendingTreasury: ZERO, launch: 1_000_000 * 86400, ownerIsEoa: false };
  base.deadline = base.launch - 3600;
  base.now = base.deadline - 7200;
  const want = { owner: OWNER, deployer: DEPLOYER, treasury: TREASURY, chainId: 4663, allowEoa: false };
  const verdict = (h, w = {}) => d.evaluateHandover({ ...base, ...h }, { ...want, ...w });

  it('accepted only when nothing is pending and the expected (contract) owner, not the deployer, holds it', function () {
    expect(verdict({})).to.include({ code: 0, accepted: true });
    // The bug: nothing pending was read as accepted even with the deployer still the owner.
    const failedOffer = verdict({ owner: DEPLOYER });
    expect(failedOffer).to.include({ code: 1, accepted: false });
    expect(failedOffer.msgs[0][1]).to.match(/deployer .* still owns the vault and nothing is offered/);
    expect(verdict({ owner: OTHER })).to.include({ code: 1, accepted: false });
    expect(verdict({ owner: DEPLOYER }, { deployer: undefined })).to.include({ code: 1, accepted: false }); // not the expected owner
  });
  it('on Robinhood Chain an owner with no code fails unless --allow-eoa-owner', function () {
    expect(verdict({ ownerIsEoa: true })).to.include({ code: 1, accepted: false });
    expect(verdict({ ownerIsEoa: true }, { allowEoa: true })).to.include({ code: 0, accepted: true });
    expect(verdict({ ownerIsEoa: true }, { chainId: 31337 })).to.include({ code: 0, accepted: true });
  });
  it('pending: 3 before launch - 1h when offered to the expected owner, otherwise 1', function () {
    expect(verdict({ owner: DEPLOYER, pending: OWNER })).to.include({ code: 3, accepted: false });
    expect(verdict({ owner: DEPLOYER, pending: OWNER, now: base.deadline })).to.include({ code: 1, accepted: false });
    expect(verdict({ owner: DEPLOYER, pending: OTHER })).to.include({ code: 1, accepted: false });
  });
  it('with an expected treasury, a pending treasury change or a different treasury fails even an accepted handover', function () {
    expect(verdict({ pendingTreasury: OTHER })).to.include({ code: 1, accepted: false });
    expect(verdict({ treasury: OTHER })).to.include({ code: 1, accepted: false });
    expect(verdict({ owner: DEPLOYER, pending: OWNER, pendingTreasury: OTHER })).to.include({ code: 1 });
    expect(verdict({ treasury: OTHER }, { treasury: undefined })).to.include({ code: 0 }); // only checked when known
  });

  it('expected values come from the flags, else the deployments/ record', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-record-'));
    try {
      const vault = addr(0x1234);
      expect(d.readRecord(4663, vault, dir)).to.equal(null);
      fs.writeFileSync(path.join(dir, `4663-${vault}.json`), JSON.stringify({
        vault, deployer: DEPLOYER, settings: { finalOwner: OWNER, treasury: TREASURY },
      }));
      const record = d.readRecord(4663, vault, dir);
      expect(d.expectedHandover({}, record)).to.deep.equal({ owner: OWNER, treasury: TREASURY, deployer: DEPLOYER });
      expect(d.expectedHandover({ owner: OTHER.toLowerCase() }, record)).to.deep.equal({ owner: OTHER, treasury: TREASURY, deployer: DEPLOYER });
      expect(d.expectedHandover({ owner: OWNER, treasury: TREASURY }, null)).to.deep.equal({ owner: OWNER, treasury: TREASURY, deployer: null });
      expect(() => d.expectedHandover({}, null)).to.throw(/--owner/);
      expect(() => d.expectedHandover({ owner: OWNER }, null)).to.throw(/--treasury/);
      expect(() => d.expectedHandover({ owner: DEPLOYER }, record)).to.throw(/deployer/);
      const elsewhere = addr(0x5678);
      fs.writeFileSync(path.join(dir, `4663-${elsewhere}.json`), JSON.stringify({ vault, settings: {} }));
      expect(() => d.readRecord(4663, elsewhere, dir)).to.throw(/not 0x/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a real vault: offered (3), a stray treasury proposal (1), accepted (0), and a handover that never happened (1)', async function () {
    const f = await fixture();
    const [vault, provider] = [f.vault, ethers.provider];
    const want31337 = { owner: f.carol.address, deployer: f.owner.address, treasury: f.treasury.address, chainId: 31337, allowEoa: false };
    // The offer step failed: the deployer still owns the vault and nothing is pending.
    let h = await d.handoverState(vault, provider);
    expect(h).to.include({ owner: f.owner.address, pending: ZERO, treasury: f.treasury.address, pendingTreasury: ZERO, ownerIsEoa: true });
    expect(BigInt(h.launch)).to.equal(f.launch);
    expect(d.evaluateHandover(h, want31337)).to.include({ code: 1, accepted: false });
    await vault.transferOwnership(f.carol.address);
    expect(d.evaluateHandover(await d.handoverState(vault, provider), want31337)).to.include({ code: 3 });
    await vault.proposeTreasury(f.stranger.address);
    expect(d.evaluateHandover(await d.handoverState(vault, provider), want31337)).to.include({ code: 1 });
    // Accepting ownership also cancels the deployer's treasury proposal (L-1), so the check passes.
    await vault.connect(f.carol).acceptOwnership();
    h = await d.handoverState(vault, provider);
    expect(h.pendingTreasury).to.equal(ZERO);
    expect(d.evaluateHandover(h, want31337)).to.include({ code: 0, accepted: true });
    // The same state on Robinhood Chain: Carol is an EOA, so only with --allow-eoa-owner.
    expect(d.evaluateHandover(h, { ...want31337, chainId: 4663 })).to.include({ code: 1 });
    expect(d.evaluateHandover(h, { ...want31337, chainId: 4663, allowEoa: true })).to.include({ code: 0 });
    // After launch - 1h a pending offer is a failure, not a wait.
    const g = await fixture();
    await g.vault.transferOwnership(g.carol.address);
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(g.launch - 3600n)]);
    await ethers.provider.send('evm_mine');
    expect(d.evaluateHandover(await d.handoverState(g.vault, provider), { ...want31337, deployer: g.owner.address, treasury: g.treasury.address }))
      .to.include({ code: 1, accepted: false });
  });
});
