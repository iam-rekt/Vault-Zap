// External audits A1 and A2 (2026-10): treasury handover waits until every funded reward is earned (A1-2),
// reward-token registries can't deadlock: 10 retired slots and a 120-day claim deadline (A1-1, A2-4), and typo
// protection for reward tokens and beneficiaries (A2-3, A2-6).
const { expect } = require('chai');
const { ethers, DAY, WAD, PULP, mineAt, txAt, fixture, addReward, passTreasuryDelay } = require('./helpers');

const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp);
const stampOf = async (tx) => BigInt((await ethers.provider.getBlock((await (await tx).wait()).blockNumber)).timestamp);
const DEADLINE = 120n * DAY;

describe('PulpVeVault: a new treasury never receives rewards funded before it took over (A1-2)', function () {
  it('the auditor\'s attack: launch far ahead, 70 WETH funded before launch; the new treasury gets 0', async function () {
    const f = await fixture({ launchInDays: 60 });
    const weth = await f.weth.getAddress(), attacker = f.stranger, L = f.launch / DAY;
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD }); // the 7 days from launch
    expect(await f.vault.epochRewards(weth, L)).to.equal(10n * WAD);
    expect(await f.vault.epochRewards(weth, L + 6n)).to.equal(10n * WAD);
    // The stolen owner key proposes its own address and waits the 8 days.
    const t0 = await stampOf(f.vault.proposeTreasury(attacker.address));
    await mineAt(t0 + 8n * DAY + 60n);
    const accept = () => f.vault.connect(attacker).acceptTreasury();
    await expect(accept()).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(weth, L);
    // Then everything else it can do, in a row: exit, release, accept, sweep.
    const exited = await stampOf(f.vault.enableEmergencyExit());
    // The switch itself starts the release clock: 8 more days for the current treasury.
    await expect(accept()).to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver').withArgs(exited + 8n * DAY);
    // Unreleased post-exit days still block acceptance, however long the attacker waits.
    await mineAt(exited + 30n * DAY);
    await expect(accept()).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(weth, L);
    const released = await stampOf(f.vault.connect(attacker).releasePostExitRewards(weth));
    expect(await f.vault.lastReleasedAt()).to.equal(released);
    await expect(accept()).to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver').withArgs(released + 8n * DAY);
    // The current treasury has those 8 days to sweep what was released; the attacker can't, nobody else can.
    await expect(f.vault.connect(attacker).recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.connect(f.treasury).recoverExcess(weth)).to.changeTokenBalances(f.weth, [f.treasury, attacker], [70n * WAD, 0n]);
    await expect(txAt(released + 8n * DAY - 1n, accept)).to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver');
    await expect(txAt(released + 8n * DAY, accept)).to.emit(f.vault, 'TreasuryChanged').withArgs(f.treasury.address, attacker.address);
    await expect(f.vault.connect(attacker).recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    expect(await f.weth.balanceOf(attacker.address)).to.equal(0n);
    expect(await f.weth.balanceOf(await f.vault.getAddress())).to.equal(0n);
  });

  it('without an exit, acceptance waits until launch + 7 days (every funded day earned), then succeeds', async function () {
    const f = await fixture({ launchInDays: 30 });
    const weth = await f.weth.getAddress(), L = f.launch / DAY, next = f.carol;
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD });
    const t0 = await stampOf(f.vault.proposeTreasury(next.address));
    const accept = () => f.vault.connect(next).acceptTreasury();
    await expect(txAt(t0 + 8n * DAY, accept)).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(weth, L);
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await expect(accept()).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(weth, L);
    await expect(txAt((L + 3n) * DAY, accept)).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(weth, L + 3n);
    await expect(txAt((L + 7n) * DAY - 1n, accept)).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(weth, L + 6n);
    await expect(txAt((L + 7n) * DAY, accept)).to.emit(f.vault, 'TreasuryChanged').withArgs(f.treasury.address, next.address);
    // Everything funded went to the locker; the new treasury finds nothing.
    await expect(f.vault.connect(f.alice).claim(weth, 64)).to.changeTokenBalance(f.weth, f.alice, 70n * WAD);
    await expect(f.vault.connect(next).recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
  });

  it('a budget recycled after the proposal blocks acceptance again until it is earned', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress(), L = f.launch / DAY, next = f.carol;
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD }); // L .. L+6
    await txAt((L + 1n) * DAY, () => f.vault.connect(f.alice).lock(PULP, 30)); // nobody had power on day L
    await mineAt((L + 8n) * DAY);
    const t0 = await stampOf(f.vault.proposeTreasury(next.address));
    await mineAt(t0 + 8n * DAY);
    // Anyone recycles the empty launch day onto the next seven days, which are not earned yet.
    const today = (await now()) / DAY;
    await f.vault.connect(f.bob).recycleEmptyRewards(weth, L);
    const accept = () => f.vault.connect(next).acceptTreasury();
    await expect(accept()).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(weth, today + 1n);
    await expect(txAt((today + 8n) * DAY - 1n, accept)).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(weth, today + 7n);
    await expect(txAt((today + 8n) * DAY, accept)).to.emit(f.vault, 'TreasuryChanged');
    await expect(f.vault.connect(f.alice).claim(weth, 64)).to.changeTokenBalance(f.weth, f.alice, 7n * WAD);
    await expect(f.vault.connect(next).recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
  });

  it('with nothing scheduled, acceptance needs only the 8 days; funding during the window delays it', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'R');
    const token = await reward.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    const t0 = await stampOf(f.vault.proposeTreasury(f.carol.address));
    await expect(txAt(t0 + 8n * DAY, () => f.vault.connect(f.carol).acceptTreasury()))
      .to.emit(f.vault, 'TreasuryChanged').withArgs(f.treasury.address, f.carol.address);
    // A distributor that keeps funding (any token) keeps the next change waiting until that funding is earned.
    const t1 = await stampOf(f.vault.proposeTreasury(f.bob.address));
    const funded = await stampOf(txAt(t1 + 7n * DAY, () => f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD)));
    const D = funded / DAY;
    const accept = () => f.vault.connect(f.bob).acceptTreasury();
    await expect(txAt(t1 + 8n * DAY, accept)).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(token, (t1 + 8n * DAY) / DAY);
    await expect(txAt((D + 8n) * DAY - 1n, accept)).to.be.revertedWithCustomError(f.vault, 'UnearnedRewardsScheduled').withArgs(token, D + 7n);
    await expect(txAt((D + 8n) * DAY, accept)).to.emit(f.vault, 'TreasuryChanged').withArgs(f.carol.address, f.bob.address);
  });
});

describe('PulpVeVault: reward-token registries cannot deadlock (A1-1); claim deadline (A2-4)', function () {
  // Alice and Bob hold power 1:2, so every funded day leaves 1 unit of rounding dust after both claim.
  async function lockers(f) {
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(2n * PULP, 30));
  }
  async function claimBoth(f, token) {
    await f.vault.connect(f.alice).claim(token, 64);
    await f.vault.connect(f.bob).claim(token, 64);
  }
  async function checkBooks(f, tokens) {
    const vault = await f.vault.getAddress();
    for (const t of tokens) {
      const a = await t.getAddress();
      expect(await t.balanceOf(vault), `balance >= reserved ${a}`).to.be.greaterThanOrEqual(await f.vault.reserved(a));
      const [n, p, r] = [await f.vault.totalNotified(a), await f.vault.totalPaid(a), await f.vault.totalReleased(a)];
      expect(p + r <= n, `paid + released <= notified ${a}`).to.equal(true);
    }
  }

  it('both lists full of dust-bearing tokens: nothing can move until the deadline; expiry frees the slots', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress(), L = f.launch / DAY;
    expect([await f.vault.MAX_REWARD_TOKENS(), await f.vault.MAX_RETIRED_REWARD_TOKENS(), await f.vault.CLAIM_DEADLINE()])
      .to.deep.equal([5n, 10n, DEADLINE]);
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
        expect(await f.vault.retiredAt(a)).to.equal(await now());
      }
      active = active.filter((t) => !leaving.includes(t));
    }
    const extra = [await addReward(f, 'X1'), await addReward(f, 'X2')];
    all.push(...extra);
    const activeList = await f.vault.getRewardTokens();
    const retiredList = await f.vault.getRetiredRewardTokens();
    expect([activeList.length, retiredList.length]).to.deep.equal([5, 10]);
    await checkBooks(f, all);
    // The deadlock: retiring needs a retired slot, reactivating needs an active slot.
    const stuck = await active[0].getAddress();
    await expect(f.vault.removeRewardToken(stuck)).to.be.revertedWithCustomError(f.vault, 'TooManyRewardTokens');
    await expect(f.vault.addRewardToken(retiredList[0])).to.be.revertedWithCustomError(f.vault, 'TooManyRewardTokens');

    // Gas with every list full (5 active + 10 retired): the recovery reserve check and the treasury handover.
    await f.pulp.connect(f.carol).transfer(await f.vault.getAddress(), 5n);
    const sweep = await (await f.vault.recoverExcess(await f.pulp.getAddress())).wait();
    const t0 = await stampOf(f.vault.proposeTreasury(f.carol.address));
    await mineAt(t0 + 8n * DAY);
    const handover = await (await f.vault.connect(f.carol).acceptTreasury()).wait();
    expect(sweep.gasUsed).to.be.lessThan(450_000n);
    expect(handover.gasUsed).to.be.lessThan(450_000n);
    console.log(`      gas with 5 active + 10 retired tokens: recoverExcess=${sweep.gasUsed}, acceptTreasury=${handover.gasUsed}`);

    // The deadline: not a second early, then anyone.
    const first = retiredList[0];
    const expiresAt = (await f.vault.retiredAt(first)) + DEADLINE;
    await expect(txAt(expiresAt - 1n, () => f.vault.connect(f.stranger).expireRewardToken(first)))
      .to.be.revertedWithCustomError(f.vault, 'ClaimDeadlineNotReached').withArgs(expiresAt);
    const dust = await f.vault.reserved(first);
    await expect(txAt(expiresAt, () => f.vault.connect(f.stranger).expireRewardToken(first)))
      .to.emit(f.vault, 'RewardTokenExpired').withArgs(first, dust);
    expect(await f.vault.getRetiredRewardTokens()).to.deep.equal(retiredList.slice(1));
    // A retired slot is free: the stuck token can be removed. Then an active slot is free: reactivate one.
    await expect(f.vault.removeRewardToken(stuck)).to.emit(f.vault, 'RewardTokenRemoved').withArgs(stuck, true);
    const back = retiredList[1];
    const owedBack = await f.vault.reserved(back);
    await expect(f.vault.addRewardToken(back)).to.emit(f.vault, 'RewardTokenAdded').withArgs(back);
    expect([await f.vault.isRewardToken(back), await f.vault.isRetiredRewardToken(back), await f.vault.retiredAt(back)])
      .to.deep.equal([true, false, 0n]);
    expect(await f.vault.reserved(back)).to.equal(owedBack); // books intact
    // Every other token past its deadline can be expired; the list empties to what is still in time.
    for (const a of retiredList.slice(2)) {
      await mineAt((await f.vault.retiredAt(a)) + DEADLINE > (await now()) ? (await f.vault.retiredAt(a)) + DEADLINE : (await now()) + 1n);
      await f.vault.expireRewardToken(a);
    }
    expect(await f.vault.getRetiredRewardTokens()).to.deep.equal([stuck]);
    // Each expired token's dust is now excess, swept to the (new) treasury; balances and books stay consistent.
    for (const t of all) {
      const a = await t.getAddress();
      if (!(await f.vault.isExpiredRewardToken(a))) continue;
      expect(await f.vault.reserved(a)).to.equal(0n);
      const left = await t.balanceOf(await f.vault.getAddress());
      await expect(f.vault.connect(f.carol).recoverExcess(a)).to.changeTokenBalance(t, f.carol, left);
      expect(await f.vault.totalNotified(a)).to.equal((await f.vault.totalPaid(a)) + (await f.vault.totalReleased(a)));
    }
    await checkBooks(f, all);
    expect(await f.vault.getRewardTokens()).to.include(weth);
  });

  it('expiry: only for retired tokens, only after 120 days; unclaimed rewards go to the treasury and claims revert', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), weth = await f.weth.getAddress();
    const reward = await addReward(f, 'R');
    const token = await reward.getAddress();
    await lockers(f);
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD + 1n);
    await mineAt(f.launch + 8n * DAY);
    await f.vault.connect(f.alice).claim(token, 64); // Bob never claims
    await expect(f.vault.expireRewardToken(token)).to.be.revertedWithCustomError(f.vault, 'NotRetiredRewardToken');
    await expect(f.vault.expireRewardToken(weth)).to.be.revertedWithCustomError(f.vault, 'NotRetiredRewardToken');
    await expect(f.vault.expireRewardToken(f.stranger.address)).to.be.revertedWithCustomError(f.vault, 'NotRetiredRewardToken');
    const retired = await stampOf(f.vault.removeRewardToken(token));
    expect(await f.vault.retiredAt(token)).to.equal(retired);
    const bobOwed = (await f.vault.claimable(f.bob.address, token, 64)).amount;
    const owed = await f.vault.reserved(token);
    expect(owed).to.be.greaterThan(bobOwed); // plus dust
    // Bob could still claim until the deadline; he doesn't. A treasury change is pending meanwhile.
    await f.vault.proposeTreasury(f.carol.address);
    await expect(txAt(retired + DEADLINE - 1n, () => f.vault.expireRewardToken(token)))
      .to.be.revertedWithCustomError(f.vault, 'ClaimDeadlineNotReached').withArgs(retired + DEADLINE);
    expect((await f.vault.claimable(f.bob.address, token, 64)).amount).to.equal(bobOwed);
    const expired = await stampOf(txAt(retired + DEADLINE, () => f.vault.connect(f.stranger).expireRewardToken(token)));
    expect(expired).to.equal(retired + DEADLINE);
    expect([await f.vault.isRetiredRewardToken(token), await f.vault.isExpiredRewardToken(token), await f.vault.retiredAt(token)])
      .to.deep.equal([false, true, 0n]);
    expect(await f.vault.totalReleased(token)).to.equal(owed);
    expect(await f.vault.reserved(token)).to.equal(0n);
    expect(await f.vault.lastReleasedAt()).to.equal(expired);
    // No books: every claim path reverts, and the token can never be a reward token again.
    await expect(f.vault.connect(f.bob).claim(token, 64)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await expect(f.vault.connect(f.bob).claimTo(token, 64, f.carol.address)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await expect(f.vault.claimable(f.bob.address, token, 64)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await expect(f.vault.releaseEmptyRewards(token, f.launch / DAY)).to.be.revertedWithCustomError(f.vault, 'EmergencyExitOff');
    await expect(f.vault.expireRewardToken(token)).to.be.revertedWithCustomError(f.vault, 'NotRetiredRewardToken');
    await expect(f.vault.addRewardToken(token)).to.be.revertedWithCustomError(f.vault, 'ExpiredRewardToken');
    // The pending treasury must leave the current one 8 days to sweep what was just released.
    await expect(f.vault.connect(f.carol).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver').withArgs(expired + 8n * DAY);
    await expect(f.vault.connect(f.treasury).recoverExcess(token)).to.changeTokenBalance(reward, f.treasury, owed);
    expect(await reward.balanceOf(vault)).to.equal(0n);
    // No longer protected: a later stray of it is an ordinary recovery.
    await reward.mint(vault, 3n);
    await expect(f.vault.recoverERC20(token, 3n)).to.changeTokenBalance(reward, f.treasury, 3n);
    await passTreasuryDelay(f.vault);
    await f.vault.connect(f.carol).acceptTreasury();
  });

  it('retired PULP: expiry releases only unclaimed rewards; principal stays reserved and withdrawable', async function () {
    const f = await fixture();
    const pulp = await f.pulp.getAddress(), vault = await f.vault.getAddress();
    await f.vault.addRewardToken(pulp);
    await lockers(f);
    await f.vault.connect(f.distributor).notifyRewardAmount(pulp, 7n * PULP);
    await mineAt(f.launch + 8n * DAY);
    await f.vault.connect(f.alice).claim(pulp, 64);
    const retired = await stampOf(f.vault.removeRewardToken(pulp));
    await expect(f.vault.connect(f.bob).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    const forfeited = (await f.vault.reserved(pulp)) - (await f.vault.totalLocked());
    await mineAt(retired + DEADLINE);
    await expect(f.vault.expireRewardToken(pulp)).to.emit(f.vault, 'RewardTokenExpired').withArgs(pulp, forfeited);
    expect(await f.vault.reserved(pulp)).to.equal(3n * PULP);
    await expect(f.vault.recoverExcess(pulp)).to.changeTokenBalance(f.pulp, f.treasury, forfeited);
    await expect(f.vault.recoverExcess(pulp)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    await expect(f.vault.recoverERC20(pulp, 1n)).to.be.revertedWithCustomError(f.vault, 'ProtectedToken');
    await expect(f.vault.addRewardToken(pulp)).to.be.revertedWithCustomError(f.vault, 'ExpiredRewardToken');
    await expect(f.vault.connect(f.bob).withdraw()).to.changeTokenBalance(f.pulp, f.bob, 2n * PULP);
    await expect(f.vault.connect(f.alice).withdraw()).to.changeTokenBalance(f.pulp, f.alice, PULP);
    expect(await f.pulp.balanceOf(vault)).to.equal(0n);
  });

  it('a retired token\'s closed zero-area budgets are released by the expiry (A2-4)', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'R');
    const token = await reward.getAddress(), L = f.launch / DAY;
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD); // L .. L+6, before anyone locks
    await txAt((L + 2n) * DAY, () => f.vault.connect(f.alice).lock(PULP, 30)); // days L and L+1 have no power
    await mineAt((L + 8n) * DAY);
    const retired = await stampOf(f.vault.removeRewardToken(token));
    await f.vault.connect(f.alice).claim(token, 64);
    expect(await f.vault.reserved(token)).to.equal(2n * WAD); // the two empty days, stuck while retired
    await expect(f.vault.recycleEmptyRewards(token, L)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await expect(f.vault.releaseEmptyRewards(token, L)).to.be.revertedWithCustomError(f.vault, 'EmergencyExitOff');
    await mineAt(retired + DEADLINE);
    await expect(f.vault.expireRewardToken(token)).to.emit(f.vault, 'RewardTokenExpired').withArgs(token, 2n * WAD);
    await expect(f.vault.recoverExcess(token)).to.changeTokenBalance(reward, f.treasury, 2n * WAD);
    expect(await reward.balanceOf(await f.vault.getAddress())).to.equal(0n);
  });

  it('after the exit: tokens retire once post-exit days are released and expire 120 days later', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress(), L = f.launch / DAY;
    await lockers(f);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD }); // L+1 .. L+7
    await txAt((L + 3n) * DAY + DAY / 2n, () => f.vault.enableEmergencyExit());
    await expect(f.vault.removeRewardToken(weth)).to.be.revertedWithCustomError(f.vault, 'RewardsStillScheduled');
    await f.vault.releasePostExitRewards(weth);
    await f.vault.recoverExcess(weth);
    const retired = await stampOf(f.vault.removeRewardToken(weth));
    expect(await f.vault.getRetiredRewardTokens()).to.deep.equal([weth]);
    await f.vault.connect(f.alice).claim(weth, 64); // Bob forgets
    await f.vault.connect(f.alice).withdraw();
    const left = await f.vault.reserved(weth);
    expect(left).to.be.greaterThan(WAD + WAD / 2n); // Bob's two-thirds of 2.5 days, plus dust
    await mineAt(retired + DEADLINE);
    await expect(f.vault.expireRewardToken(weth)).to.emit(f.vault, 'RewardTokenExpired').withArgs(weth, left);
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, left);
    await expect(f.vault.connect(f.bob).claim(weth, 64)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await expect(f.vault.connect(f.bob).withdraw()).to.changeTokenBalance(f.pulp, f.bob, 2n * PULP);
    // WETH can never be re-added; native funding stays off (and the exit blocks it anyway).
    await expect(f.vault.addRewardToken(weth)).to.be.revertedWithCustomError(f.vault, 'ExpiredRewardToken');
  });
});

describe('PulpVeVault: typo protection for reward tokens and beneficiaries (A2-3, A2-6)', function () {
  it('the vault itself can never be a reward token; the treasury and a pending treasury neither', async function () {
    const f = await fixture();
    await expect(f.vault.addRewardToken(await f.vault.getAddress())).to.be.revertedWithCustomError(f.vault, 'InvalidRewardToken');
    const t = await (await ethers.getContractFactory('MockERC20')).deploy('T', 'T', 18);
    await f.vault.proposeTreasury(await t.getAddress());
    await expect(f.vault.addRewardToken(await t.getAddress())).to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
  });

  it('lockFor, increaseAmountFor, claimTo and claimAllTo refuse PULP, WETH and every token with books or expired', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress(), weth = await f.weth.getAddress();
    const active = await addReward(f, 'ACTIVE');
    const retired = await addReward(f, 'RETIRED');
    const expired = await addReward(f, 'EXPIRED');
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    for (const t of [retired, expired]) await f.vault.connect(f.distributor).notifyRewardAmount(await t.getAddress(), 7n * WAD + 1n);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await mineAt(f.launch + 8n * DAY);
    await f.vault.removeRewardToken(await retired.getAddress());
    const r = await stampOf(f.vault.removeRewardToken(await expired.getAddress()));
    await mineAt(r + DEADLINE);
    await f.vault.expireRewardToken(await expired.getAddress());
    await txAt(r + DEADLINE + 10n, () => f.vault.connect(f.bob).lock(PULP, 30));
    const bad = [vault, pulp, weth, await active.getAddress(), await retired.getAddress(), await expired.getAddress()];
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
