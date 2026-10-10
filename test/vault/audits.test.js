// External audits A1 and A2 (2026-10) and the two reviews after them (R4, R5):
//   A1-2   ACCEPTED owner-trust residual: a compromised owner Safe can, after the 8-day public notice, route
//          funded-but-unearned reward budgets to a new treasury. Never principal, never earned rewards.
//   A1-1 / R5-3  ACCEPTED: the registry is bounded (5 active + 10 retired). If both lists are ever full, a broken
//          active token stays in claimAll, but every per-token claim keeps working.
//   R4-2 / R5-2  RESOLVED by removing the claim deadline: a retired token stays claimable forever and can be
//          re-added safely.
//   A2-3 / A2-6  typo protection for reward tokens and beneficiaries.
const { expect } = require('chai');
const { ethers, DAY, WAD, PULP, mineAt, txAt, fixture, addReward } = require('./helpers');

const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp);
const stampOf = async (tx) => BigInt((await ethers.provider.getBlock((await (await tx).wait()).blockNumber)).timestamp);
const TWO_YEARS = 730n * DAY;

// Alice and Bob hold power 1:2, so every funded day leaves 1 unit of rounding dust after both claim.
async function lockers(f) {
  await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
  await txAt(f.launch, () => f.vault.connect(f.bob).lock(2n * PULP, 30));
}

describe('PulpVeVault: A1-2 (accepted owner-trust residual): only unearned budgets can reach a new treasury', function () {
  it('a compromised owner Safe, after the 8-day notice, gets the unearned budgets; lockers claim every earned reward and all principal', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress(), vault = await f.vault.getAddress(), attacker = f.stranger, L = f.launch / DAY;
    await lockers(f);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD }); // days L+1 .. L+7
    // Only the owner can start a treasury change, and only in public.
    await expect(f.vault.connect(attacker).proposeTreasury(attacker.address)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    const t0 = await stampOf(txAt((L + 1n) * DAY, () => f.vault.proposeTreasury(attacker.address)));
    // Funding keeps arriving during the notice: it is scheduled beyond the acceptance time.
    await txAt((L + 6n) * DAY, () => f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD })); // L+7 .. L+13
    const accept = () => f.vault.connect(attacker).acceptTreasury();
    await expect(txAt(t0 + 8n * DAY - 1n, accept)).to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver').withArgs(t0 + 8n * DAY);
    // Funded days still ahead do not hold the handover back: 8 days after the proposal it goes through.
    await expect(txAt(t0 + 8n * DAY, accept)).to.emit(f.vault, 'TreasuryChanged').withArgs(f.treasury.address, attacker.address);
    // Then the owner exits mid funded period and the unearned rest is released to the new treasury.
    await txAt((L + 9n) * DAY + 3600n, () => f.vault.enableEmergencyExit());
    await f.vault.releasePostExitRewards(weth);
    const unearned = await f.vault.totalReleased(weth);
    expect(unearned).to.be.greaterThan(0n);
    await expect(f.vault.connect(attacker).recoverExcess(weth)).to.changeTokenBalance(f.weth, attacker, unearned);
    // The bound: lockers claim everything they earned, withdraw all principal, and only dust stays.
    const before = (await f.weth.balanceOf(f.alice.address)) + (await f.weth.balanceOf(f.bob.address));
    await f.vault.connect(f.alice).claim(weth, 64);
    await f.vault.connect(f.bob).claim(weth, 64);
    const earned = (await f.weth.balanceOf(f.alice.address)) + (await f.weth.balanceOf(f.bob.address)) - before;
    expect(earned + unearned).to.be.greaterThan(140n * WAD - 10n);
    expect(earned + unearned).to.be.lessThanOrEqual(140n * WAD);
    await expect(f.vault.connect(f.alice).withdraw()).to.changeTokenBalance(f.pulp, f.alice, PULP);
    await expect(f.vault.connect(f.bob).withdraw()).to.changeTokenBalance(f.pulp, f.bob, 2n * PULP);
    expect(await f.weth.balanceOf(vault)).to.be.lessThan(10n);
    expect(await f.pulp.balanceOf(vault)).to.equal(0n);
    // Even then, the new treasury can't take what is still owed: nothing above the reserve is left.
    await expect(f.vault.connect(attacker).recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
  });

  it('acceptance needs only the 8 days since the proposal: releases and the exit do not restart the clock', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    await lockers(f);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    const t0 = await stampOf(f.vault.proposeTreasury(f.carol.address));
    await txAt(t0 + 5n * DAY, () => f.vault.enableEmergencyExit());
    await f.vault.releasePostExitRewards(weth);
    await f.vault.connect(f.treasury).recoverExcess(weth); // the current treasury sweeps meanwhile
    await expect(txAt(t0 + 8n * DAY, () => f.vault.connect(f.carol).acceptTreasury()))
      .to.emit(f.vault, 'TreasuryChanged').withArgs(f.treasury.address, f.carol.address);
  });
});

describe('PulpVeVault: reward-token registry 5 active + 10 retired (A1-1, R5-3 accepted)', function () {
  async function claimBoth(f, token) {
    await f.vault.connect(f.alice).claim(token, 64);
    await f.vault.connect(f.bob).claim(token, 64);
  }

  it('both lists full: the lists cannot move, a broken active token stays in claimAll, every per-token claim works', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), L = f.launch / DAY;
    expect([await f.vault.MAX_REWARD_TOKENS(), await f.vault.MAX_RETIRED_REWARD_TOKENS()]).to.deep.equal([5n, 10n]);
    await lockers(f);
    const all = [];
    // Three rounds: four tokens funded, earned, claimed by both (leaving dust), then removed (retired).
    let active = [];
    for (let round = 0n; round < 3n; round++) {
      await mineAt((L + 8n * round) * DAY + 100n);
      for (let i = 0; i < 4; i++) {
        const t = await addReward(f, `T${round}${i}`);
        await f.vault.connect(f.distributor).notifyRewardAmount(await t.getAddress(), 7n * WAD + 1n);
        all.push(t);
        active.push(t);
      }
      await mineAt((L + 8n * round + 8n) * DAY + 100n);
      for (const t of active) await claimBoth(f, await t.getAddress());
      const leaving = round < 2n ? active : active.slice(0, 2);
      for (const t of leaving) {
        const a = await t.getAddress();
        expect(await f.vault.reserved(a), 'dust left after everyone claimed').to.be.greaterThan(0n);
        await expect(f.vault.removeRewardToken(a)).to.emit(f.vault, 'RewardTokenRemoved').withArgs(a, true);
      }
      active = active.filter((t) => !leaving.includes(t));
    }
    const broken = await addReward(f, 'BROKEN', 18, 'MockPausableERC20');
    const other = await addReward(f, 'X2');
    all.push(broken, other);
    // Both funded now (the lockers' power runs until launch + 30 days).
    for (const t of [broken, other]) await f.vault.connect(f.distributor).notifyRewardAmount(await t.getAddress(), 7n * WAD);
    const retiredList = await f.vault.getRetiredRewardTokens();
    expect([(await f.vault.getRewardTokens()).length, retiredList.length]).to.deep.equal([5, 10]);
    // Retiring needs a retired slot, reactivating needs an active slot: the lists are fixed from here.
    const stuck = await active[0].getAddress();
    await expect(f.vault.removeRewardToken(stuck)).to.be.revertedWithCustomError(f.vault, 'TooManyRewardTokens');
    await expect(f.vault.addRewardToken(retiredList[0])).to.be.revertedWithCustomError(f.vault, 'TooManyRewardTokens');

    // Gas with every list full (5 active + 10 retired): the recovery reserve check and the treasury handover.
    await f.pulp.connect(f.carol).transfer(vault, 5n);
    const sweep = await (await f.vault.recoverExcess(await f.pulp.getAddress())).wait();
    const t0 = await stampOf(f.vault.proposeTreasury(f.carol.address));
    await mineAt(t0 + 8n * DAY);
    const handover = await (await f.vault.connect(f.carol).acceptTreasury()).wait();
    expect(sweep.gasUsed).to.be.lessThan(450_000n);
    expect(handover.gasUsed).to.be.lessThan(100_000n);
    console.log(`      gas with 5 active + 10 retired tokens: recoverExcess=${sweep.gasUsed}, acceptTreasury=${handover.gasUsed}`);

    // The broken token stops transferring. It can't be removed (no free retired slot), so it stays in claimAll.
    await broken.setPaused(true);
    await expect(f.vault.connect(f.alice).claimAll(64)).to.be.revertedWith('MockPausableERC20: paused');
    // Per-token claims work for every other active token and every retired one.
    const alice0 = await other.balanceOf(f.alice.address);
    await f.vault.connect(f.alice).claim(await other.getAddress(), 64);
    expect((await other.balanceOf(f.alice.address)) - alice0).to.be.greaterThan(0n);
    for (const t of [...active, ...retiredList]) await f.vault.connect(f.alice).claim(t, 64);
    // Once the token works again, its rewards are all still there.
    await broken.setPaused(false);
    const owedBroken = (await f.vault.claimable(f.alice.address, await broken.getAddress(), 64)).amount;
    expect(owedBroken).to.be.greaterThan(0n);
    await expect(f.vault.connect(f.alice).claim(await broken.getAddress(), 64)).to.changeTokenBalance(broken, f.alice, owedBroken);
    await f.vault.connect(f.bob).claimAll(64);
    for (const t of all) {
      const a = await t.getAddress();
      expect(await t.balanceOf(vault), `balance >= reserved ${a}`).to.be.greaterThanOrEqual(await f.vault.reserved(a));
      // The last two funded days of broken/other had no power (the locks ended): they stay reserved.
      if (t !== broken && t !== other) expect(await f.vault.reserved(a), `only dust left ${a}`).to.be.lessThan(10n);
    }
  });
});

describe('PulpVeVault: earned rewards are claimable forever (R4-2, R5-2: claim deadline removed)', function () {
  it('a retired token stays claimable after 2 years, stays protected, and can be re-added safely', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress();
    const reward = await addReward(f, 'R');
    const token = await reward.getAddress();
    await lockers(f);
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD + 1n);
    await mineAt(f.launch + 9n * DAY);
    await f.vault.connect(f.alice).claim(token, 64); // Bob does not claim
    await expect(f.vault.removeRewardToken(token)).to.emit(f.vault, 'RewardTokenRemoved').withArgs(token, true);
    const bobOwed = (await f.vault.claimable(f.bob.address, token, 64)).amount;
    expect(bobOwed).to.be.greaterThan(4n * WAD);
    const owed = await f.vault.reserved(token);
    await mineAt((await now()) + TWO_YEARS);
    // Two years later: still retired, still reserved, still protected from every recovery.
    expect([await f.vault.isRewardToken(token), await f.vault.isRetiredRewardToken(token)]).to.deep.equal([false, true]);
    expect(await f.vault.reserved(token)).to.equal(owed);
    expect((await f.vault.claimable(f.bob.address, token, 64)).amount).to.equal(bobOwed);
    await expect(f.vault.recoverExcess(token)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    await expect(f.vault.connect(f.treasury).recoverERC20(token, 1n)).to.be.revertedWithCustomError(f.vault, 'ProtectedToken');
    await expect(f.vault.connect(f.bob).claim(token, 64)).to.changeTokenBalance(reward, f.bob, bobOwed);
    expect(await f.vault.reserved(token)).to.equal(owed - bobOwed); // rounding dust
    // Re-added: the books carry on. Old days are not paid twice, new funding is paid exactly.
    await expect(f.vault.addRewardToken(token)).to.emit(f.vault, 'RewardTokenAdded').withArgs(token);
    expect([await f.vault.isRewardToken(token), await f.vault.isRetiredRewardToken(token)]).to.deep.equal([true, false]);
    expect(await f.vault.getRetiredRewardTokens()).to.deep.equal([]);
    expect(await f.vault.reserved(token)).to.equal(owed - bobOwed);
    await f.vault.connect(f.bob).withdraw();
    await f.vault.connect(f.alice).withdraw();
    await f.vault.connect(f.alice).lock(PULP, 30);
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD);
    await mineAt((await now()) + 9n * DAY);
    await expect(f.vault.connect(f.bob).claim(token, 64)).to.changeTokenBalance(reward, f.bob, 0n);
    await expect(f.vault.connect(f.alice).claim(token, 64)).to.changeTokenBalance(reward, f.alice, 7n * WAD);
    expect(await reward.balanceOf(vault)).to.equal(await f.vault.reserved(token));
    expect(await f.vault.totalNotified(token)).to.equal((await f.vault.totalPaid(token)) + (await f.vault.reserved(token)));
  });

  it('retired PULP: unclaimed rewards stay claimable after 2 years; principal stays reserved and withdrawable', async function () {
    const f = await fixture();
    const pulp = await f.pulp.getAddress(), vault = await f.vault.getAddress();
    await f.vault.addRewardToken(pulp);
    await lockers(f);
    await f.vault.connect(f.distributor).notifyRewardAmount(pulp, 7n * PULP);
    await mineAt(f.launch + 9n * DAY);
    await f.vault.connect(f.alice).claim(pulp, 64);
    await f.vault.removeRewardToken(pulp);
    await expect(f.vault.connect(f.bob).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    const bobOwed = (await f.vault.claimable(f.bob.address, pulp, 64)).amount;
    await mineAt((await now()) + TWO_YEARS);
    await expect(f.vault.recoverExcess(pulp)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    await expect(f.vault.recoverERC20(pulp, 1n)).to.be.revertedWithCustomError(f.vault, 'ProtectedToken');
    await expect(f.vault.connect(f.bob).claim(pulp, 64)).to.changeTokenBalance(f.pulp, f.bob, bobOwed);
    await expect(f.vault.connect(f.bob).withdraw()).to.changeTokenBalance(f.pulp, f.bob, 2n * PULP);
    await expect(f.vault.connect(f.alice).withdraw()).to.changeTokenBalance(f.pulp, f.alice, PULP);
    expect(await f.pulp.balanceOf(vault)).to.equal(await f.vault.reserved(pulp));
    expect(await f.vault.reserved(pulp)).to.be.lessThan(10n);
  });

  it('after the exit: a token retires once post-exit days are released and stays claimable', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress(), L = f.launch / DAY;
    await lockers(f);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD }); // L+1 .. L+7
    await txAt((L + 3n) * DAY + DAY / 2n, () => f.vault.enableEmergencyExit());
    await expect(f.vault.removeRewardToken(weth)).to.be.revertedWithCustomError(f.vault, 'RewardsStillScheduled');
    await f.vault.releasePostExitRewards(weth);
    await f.vault.recoverExcess(weth);
    await f.vault.removeRewardToken(weth);
    expect(await f.vault.getRetiredRewardTokens()).to.deep.equal([weth]);
    await f.vault.connect(f.alice).claim(weth, 64);
    await f.vault.connect(f.alice).withdraw();
    const bobOwed = (await f.vault.claimable(f.bob.address, weth, 64)).amount;
    expect(bobOwed).to.be.greaterThan(WAD + WAD / 2n); // two-thirds of 2.5 days
    await mineAt((await now()) + TWO_YEARS);
    await expect(f.vault.recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    await expect(f.vault.connect(f.bob).claim(weth, 64)).to.changeTokenBalance(f.weth, f.bob, bobOwed);
    await expect(f.vault.connect(f.bob).withdraw()).to.changeTokenBalance(f.pulp, f.bob, 2n * PULP);
    expect(await f.vault.reserved(weth)).to.be.lessThan(10n);
  });
});

describe('PulpVeVault: typo protection for reward tokens and beneficiaries (A2-3, A2-6)', function () {
  it('the vault itself can never be a reward token; the treasury and a pending treasury neither', async function () {
    const f = await fixture();
    await expect(f.vault.addRewardToken(await f.vault.getAddress())).to.be.revertedWithCustomError(f.vault, 'InvalidRewardToken');
    await expect(f.vault.addRewardToken(f.treasury.address)).to.be.revertedWithCustomError(f.vault, 'NotAContract');
    const t = await (await ethers.getContractFactory('MockERC20')).deploy('T', 'T', 18);
    await f.vault.proposeTreasury(await t.getAddress());
    await expect(f.vault.addRewardToken(await t.getAddress())).to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
  });

  it('lockFor, increaseAmountFor, claimTo and claimAllTo refuse PULP, WETH and every token with books', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress(), weth = await f.weth.getAddress();
    const active = await addReward(f, 'ACTIVE');
    const retired = await addReward(f, 'RETIRED');
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(await retired.getAddress(), 7n * WAD + 1n);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await mineAt(f.launch + 8n * DAY);
    await f.vault.removeRewardToken(await retired.getAddress());
    await f.vault.connect(f.bob).lock(PULP, 30);
    const bad = [vault, pulp, weth, await active.getAddress(), await retired.getAddress()];
    for (const b of bad) {
      await expect(f.vault.connect(f.carol).lockFor(b, PULP, 30), `lockFor ${b}`).to.be.revertedWithCustomError(f.vault, 'InvalidBeneficiary');
      await expect(f.vault.connect(f.carol).increaseAmountFor(b, PULP), `increaseAmountFor ${b}`).to.be.revertedWithCustomError(f.vault, 'InvalidBeneficiary');
      await expect(f.vault.connect(f.alice).claimTo(weth, 64, b), `claimTo ${b}`).to.be.revertedWithCustomError(f.vault, 'InvalidBeneficiary');
      await expect(f.vault.connect(f.alice).claimAllTo(64, b), `claimAllTo ${b}`).to.be.revertedWithCustomError(f.vault, 'InvalidBeneficiary');
    }
    for (const call of [
      () => f.vault.connect(f.carol).lockFor(ethers.ZeroAddress, PULP, 30),
      () => f.vault.connect(f.carol).increaseAmountFor(ethers.ZeroAddress, PULP),
      () => f.vault.connect(f.alice).claimTo(weth, 64, ethers.ZeroAddress),
      () => f.vault.connect(f.alice).claimAllTo(64, ethers.ZeroAddress),
    ]) await expect(call()).to.be.revertedWithCustomError(f.vault, 'ZeroAddress');
    // Wallets still work.
    await expect(f.vault.connect(f.carol).lockFor(f.stranger.address, PULP, 30)).to.emit(f.vault, 'DepositedFor');
    await expect(f.vault.connect(f.carol).increaseAmountFor(f.bob.address, PULP)).to.emit(f.vault, 'DepositedFor');
    await expect(f.vault.connect(f.alice).claimTo(weth, 64, f.carol.address)).to.changeTokenBalance(f.weth, f.carol, 7n * WAD);
    await f.vault.connect(f.alice).claimAllTo(64, f.carol.address);
    // A vault without WETH: the zero address is never mistaken for a refusal of WETH.
    const g = await fixture({ nativeDisabled: true });
    await expect(txAt(g.launch, () => g.vault.connect(g.carol).lockFor(g.alice.address, PULP, 10))).to.emit(g.vault, 'DepositedFor');
    await expect(g.vault.connect(g.carol).lockFor(await g.pulp.getAddress(), PULP, 10)).to.be.revertedWithCustomError(g.vault, 'InvalidBeneficiary');
  });
});
