// Internal review 3 (2026-10-10, an adversarial review of the fixes for external audits A1/A2).
//   H-1, M-1  ACCEPTED owner-trust residuals. Both need the owner (a Safe multisig) to be compromised, and both
//             reach only the protocol's own unearned reward budgets: never a locker's principal or earned rewards.
//             H-1: a hostile owner-registered "reward token" vetoes the current treasury's sweeps until a newly
//             accepted treasury takes the released budgets. M-1: pausing locks through the funded launch week
//             makes zero-power days whose budgets reach a newly accepted treasury. The tests below replay the
//             reviewer's PoCs and pin down exactly that bound.
//   L-1       FIXED: a "return bomb" in the recovery balance reads (all returndata copied into memory) made a
//             recovery cost up to ~69M gas with 15 hostile tokens; reads now use a fixed 32-byte output buffer.
//   I-1       FIXED: the treasury check also refuses WETH (by address) and expired reward tokens.
const { expect } = require('chai');
const { ethers, DAY, WAD, PULP, mineAt, txAt, fixture, addReward, passTreasuryDelay } = require('./helpers');

const stampOf = async (tx) => BigInt((await ethers.provider.getBlock((await (await tx).wait()).blockNumber)).timestamp);

describe('PulpVeVault: review 3 H-1 (accepted): a vetoing reward token needs the owner and reaches only unearned budgets', function () {
  it('the reviewer\'s PoC: the attacker\'s treasury gets exactly the released unearned budgets; lockers lose nothing earned', async function () {
    const f = await fixture({ launchInDays: 2 });
    const weth = await f.weth.getAddress(), vaultAddr = await f.vault.getAddress(), attacker = f.stranger, L = f.launch / DAY;
    await txAt(f.launch + 60n, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.bob).lock(PULP, 30);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD }); // days L+1..L+7
    await txAt((L + 2n) * DAY, () => f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD })); // L+3..L+9
    const H = await (await ethers.getContractFactory('MockReserveVeto')).deploy();
    const h = await H.getAddress();
    // Every step needs the owner: nobody else can register a token or propose a treasury.
    await expect(f.vault.connect(attacker).addRewardToken(h)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.connect(attacker).proposeTreasury(attacker.address)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    // A compromised owner (Safe): hostile token, own treasury, exit mid funded period, release.
    await f.vault.addRewardToken(h);
    await H.arm(vaultAddr, weth, true);
    await f.vault.proposeTreasury(attacker.address);
    await mineAt((L + 4n) * DAY + 3600n);
    await f.vault.enableEmergencyExit();
    const r = await stampOf(f.vault.releasePostExitRewards(weth));
    const unearned = await f.vault.totalReleased(weth);
    // The veto holds up the current treasury's sweep through the 8 days (the residual being accepted).
    for (const t of [r + 60n, r + 8n * DAY - 5n]) {
      await expect(txAt(t, () => f.vault.connect(f.treasury).recoverExcess(weth)))
        .to.be.revertedWithCustomError(f.vault, 'ReserveBreached').withArgs(h);
    }
    await txAt(r + 8n * DAY, () => f.vault.connect(attacker).acceptTreasury());
    await H.arm(vaultAddr, weth, false);
    await expect(f.vault.connect(attacker).recoverExcess(weth)).to.changeTokenBalance(f.weth, attacker, unearned);
    // The bound: lockers claim everything they earned, withdraw all principal, and only dust stays.
    const before = (await f.weth.balanceOf(f.alice.address)) + (await f.weth.balanceOf(f.bob.address));
    await f.vault.connect(f.alice).claim(weth, 64);
    await f.vault.connect(f.bob).claim(weth, 64);
    const earned = (await f.weth.balanceOf(f.alice.address)) + (await f.weth.balanceOf(f.bob.address)) - before;
    expect(earned + unearned).to.be.greaterThan(140n * WAD - 10n);
    expect(earned + unearned).to.be.lessThanOrEqual(140n * WAD);
    await expect(f.vault.connect(f.alice).withdraw()).to.changeTokenBalance(f.pulp, f.alice, PULP);
    await expect(f.vault.connect(f.bob).withdraw()).to.changeTokenBalance(f.pulp, f.bob, PULP);
    expect(await f.weth.balanceOf(vaultAddr)).to.be.lessThan(10n);
  });
});

describe('PulpVeVault: review 3 M-1 (accepted): zero-power days made by pausing locks need the owner and hold no user funds', function () {
  it('the reviewer\'s PoC: locks paused through the funded launch week; the budgets nobody could earn reach the new treasury', async function () {
    const f = await fixture({ launchInDays: 60 });
    const weth = await f.weth.getAddress(), attacker = f.stranger, L = f.launch / DAY;
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD });
    await expect(f.vault.connect(attacker).setLocksPaused(true)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await f.vault.setLocksPaused(true);
    await mineAt(f.launch - DAY);
    await f.vault.proposeTreasury(attacker.address);
    await expect(txAt(f.launch + 10n, () => f.vault.connect(f.alice).lock(PULP, 30))).to.be.revertedWithCustomError(f.vault, 'LocksArePaused');
    // Nobody could lock, so nobody earned anything and no principal is in the vault.
    await txAt((L + 7n) * DAY, () => f.vault.connect(attacker).acceptTreasury());
    expect(await f.vault.totalLocked()).to.equal(0n);
    await f.vault.enableEmergencyExit();
    for (let d = L; d < L + 7n; d++) await f.vault.connect(attacker).releaseEmptyRewards(weth, d);
    await expect(f.vault.connect(attacker).recoverExcess(weth)).to.changeTokenBalance(f.weth, attacker, 70n * WAD);
    // Defence for an honest operation: anyone can recycle each zero-power day as it closes, which keeps the
    // budget scheduled and blocks acceptance (see docs/SECURITY.md, review 3).
  });

  it('anyone recycling each zero-power day as it closes keeps acceptance blocked', async function () {
    const f = await fixture({ launchInDays: 60 });
    const weth = await f.weth.getAddress(), attacker = f.stranger, L = f.launch / DAY;
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD });
    await f.vault.setLocksPaused(true);
    await mineAt(f.launch - DAY);
    await f.vault.proposeTreasury(attacker.address);
    for (let d = L; d < L + 7n; d++) await txAt((d + 1n) * DAY + 1n, () => f.vault.connect(f.bob).recycleEmptyRewards(weth, d));
    await expect(f.vault.connect(attacker).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled');
  });
});

describe('PulpVeVault: review 3 I-1: the treasury is never WETH or an expired reward token', function () {
  it('proposeTreasury refuses WETH even once it is no longer a reward token, and every expired token', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    const reward = await addReward(f, 'R');
    const token = await reward.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.bob).lock(PULP, 30);
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD + 1n);
    await mineAt(f.launch + 9n * DAY);
    await f.vault.removeRewardToken(weth); // never funded: dropped entirely, no books left
    expect([await f.vault.isRewardToken(weth), await f.vault.isRetiredRewardToken(weth)]).to.deep.equal([false, false]);
    await expect(f.vault.proposeTreasury(weth)).to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
    await f.vault.connect(f.alice).claim(token, 64); // Bob never claims: retired, then expired
    const retired = await stampOf(f.vault.removeRewardToken(token));
    await mineAt(retired + 120n * DAY);
    await f.vault.expireRewardToken(token);
    expect(await f.vault.isExpiredRewardToken(token)).to.equal(true);
    await expect(f.vault.proposeTreasury(token)).to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
    // A pending proposal is re-checked on acceptance.
    const later = await (await ethers.getContractFactory('MockERC20')).deploy('L', 'L', 18);
    await f.vault.proposeTreasury(await later.getAddress());
    await expect(f.vault.addRewardToken(await later.getAddress())).to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
    await expect(f.vault.proposeTreasury(f.carol.address)).to.emit(f.vault, 'TreasuryProposed');
    await passTreasuryDelay(f.vault);
    await f.vault.connect(f.carol).acceptTreasury();
  });

  it('the constructor refuses WETH as the treasury', async function () {
    const f = await fixture();
    const factory = await ethers.getContractFactory('PulpVeVault');
    await expect(factory.deploy({ ...f.config, launchStart: f.launch + DAY, treasury: f.config.weth }))
      .to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
  });
});

describe('PulpVeVault: no return bomb in the recovery balance reads (review 3, L-1)', function () {
  this.timeout(600_000);
  const MODES = ['normal', 'gas-burning', 'return-bomb', 'short return (31 bytes)', 'balance + 4 KB junk'];

  it('15 hostile reward tokens (5 active + 10 retired): every recovery stays far below 32M gas', async function () {
    const f = await fixture({ nativeDisabled: true, launchInDays: 2 });
    const L = f.launch / DAY, vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress();
    await txAt(f.launch + 10n, () => f.vault.connect(f.alice).lock(PULP, 30));
    const H = await ethers.getContractFactory('MockHostileERC20');
    const all = [];
    for (let r = 0n; r < 3n; r++) {
      await mineAt((L + 8n * r) * DAY + 100n);
      const batch = [];
      for (let i = 0; i < 5; i++) {
        const t = await H.deploy(`H${r}${i}`, 'H', 18);
        await f.vault.addRewardToken(await t.getAddress());
        await t.mint(f.distributor.address, 10n ** 24n);
        await t.connect(f.distributor).approve(vault, ethers.MaxUint256);
        await f.vault.connect(f.distributor).notifyRewardAmount(await t.getAddress(), 7n * WAD);
        batch.push(t);
        all.push(t);
      }
      if (r < 2n) {
        await mineAt((L + 8n * r + 8n) * DAY + 100n);
        for (const t of batch) await f.vault.removeRewardToken(await t.getAddress()); // still owed: retired
      }
    }
    expect((await f.vault.getRewardTokens()).length).to.equal(5);
    expect((await f.vault.getRetiredRewardTokens()).length).to.equal(10);
    await mineAt((L + 24n) * DAY + 100n);
    const stray = await (await ethers.getContractFactory('MockERC20')).deploy('S', 'S', 18);
    const G = 30_000_000; // the whole block: the old code needed ~69M for recoverExcess with 15 return bombs
    const results = {};
    let snap = await ethers.provider.send('evm_snapshot', []);
    for (let mode = 0; mode < MODES.length; mode++) {
      await ethers.provider.send('evm_revert', [snap]);
      snap = await ethers.provider.send('evm_snapshot', []);
      for (const t of all) await t.setMode(mode);
      const g = {};
      const run = async (name, p) => { g[name] = Number((await (await p).wait()).gasUsed); };
      await f.pulp.connect(f.carol).transfer(vault, 5n);
      await expect(f.vault.recoverExcess(pulp, { gasLimit: G })).to.changeTokenBalance(f.pulp, f.treasury, 5n);
      await f.pulp.connect(f.carol).transfer(vault, 5n);
      await run('recoverExcess(pulp)', f.vault.recoverExcess(pulp, { gasLimit: G }));
      await stray.mint(vault, 1000n);
      await run('recoverERC20(stray)', f.vault.connect(f.treasury).recoverERC20(await stray.getAddress(), 1000n, { gasLimit: G }));
      expect(await stray.balanceOf(f.treasury.address)).to.equal(1000n);
      await run('claimAll(64)', f.vault.connect(f.alice).claimAll(64, { gasLimit: G }));
      await run('enableEmergencyExit', f.vault.enableEmergencyExit({ gasLimit: G }));
      await run('withdraw (after exit)', f.vault.connect(f.alice).withdraw({ gasLimit: G }));
      for (const name of ['recoverExcess(pulp)', 'recoverERC20(stray)']) {
        expect(g[name], `${MODES[mode]}: ${name}`).to.be.lessThan(4_000_000);
      }
      results[MODES[mode]] = g;
    }
    console.table(results);
    console.log(`      gas, 15 return-bomb tokens: recoverExcess(pulp)=${results['return-bomb']['recoverExcess(pulp)']}, ` +
      `recoverERC20(stray)=${results['return-bomb']['recoverERC20(stray)']}`);
  });

  it('a balance read counts only with at least 32 bytes returned; extra returned data is ignored, not copied', async function () {
    const f = await fixture();
    const t = await addReward(f, 'HOSTILE', 18, 'MockHostileERC20');
    const token = await t.getAddress(), vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD);
    for (const mode of [3, 4, 2]) {
      await t.setMode(mode);
      // Unreadable (too short) or readable, the hostile token blocks no other recovery.
      await f.pulp.connect(f.bob).transfer(vault, 3n);
      await expect(f.vault.recoverExcess(pulp)).to.changeTokenBalance(f.pulp, f.treasury, 3n);
    }
    // With a correct balance followed by junk, its own excess is measured exactly and owed rewards stay put.
    await t.setMode(4);
    await t.mint(vault, 11n);
    await expect(f.vault.recoverExcess(token)).to.changeTokenBalance(t, f.treasury, 11n);
    await t.setMode(0);
    expect(await t.balanceOf(vault)).to.equal(7n * WAD);
    await mineAt(f.launch + 9n * DAY);
    await expect(f.vault.connect(f.alice).claim(token, 64)).to.changeTokenBalance(t, f.alice, 7n * WAD);
  });
});

