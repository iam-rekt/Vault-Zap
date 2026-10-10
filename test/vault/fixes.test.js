// Audit 2026-10-10 fixes: treasury (M-A, AC-5, AC-6), recovery checks (EF-1), claimTo (EF-4),
// removeRewardToken (AC-2/DOS-2), native ETH recovery (DOS-3/EF-5), events (GA-3).
const { expect } = require('chai');
const { ethers, DAY, WAD, PULP, mineAt, txAt, fixture, addReward, passTreasuryDelay } = require('./helpers');

describe('PulpVeVault: treasury (two-step) and recovery only to it', function () {
  it('changes only by proposeTreasury (owner) + acceptTreasury (the new address), with every check', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress(), weth = await f.weth.getAddress();
    expect([await f.vault.treasury(), await f.vault.pendingTreasury()]).to.deep.equal([f.treasury.address, ethers.ZeroAddress]);
    await expect(f.vault.connect(f.stranger).proposeTreasury(f.stranger.address))
      .to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.connect(f.treasury).proposeTreasury(f.stranger.address))
      .to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount'); // the treasury is not the owner
    for (const bad of [vault, pulp, weth]) {
      await expect(f.vault.proposeTreasury(bad)).to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
    }
    // Nobody can accept while nothing is pending; only the proposed address can.
    await expect(f.vault.connect(f.carol).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'NotPendingTreasury');
    await expect(f.vault.proposeTreasury(f.carol.address)).to.emit(f.vault, 'TreasuryProposed').withArgs(f.carol.address);
    expect(await f.vault.treasury()).to.equal(f.treasury.address); // nothing changes until accepted
    for (const s of [f.owner, f.treasury, f.bob]) {
      await expect(f.vault.connect(s).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'NotPendingTreasury');
    }
    // Zero cancels a proposal.
    await expect(f.vault.proposeTreasury(ethers.ZeroAddress)).to.emit(f.vault, 'TreasuryProposed').withArgs(ethers.ZeroAddress);
    await expect(f.vault.connect(f.carol).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'NotPendingTreasury');
    // A pending treasury cannot be registered as a reward token, nor the current one.
    const token = await (await ethers.getContractFactory('MockERC20')).deploy('T', 'T', 18);
    await f.vault.proposeTreasury(await token.getAddress());
    await expect(f.vault.addRewardToken(await token.getAddress())).to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
    // A registered reward token cannot be proposed (acceptTreasury re-checks too).
    const later = await (await ethers.getContractFactory('MockERC20')).deploy('L', 'L', 18);
    await f.vault.proposeTreasury(f.carol.address);
    await f.vault.addRewardToken(await later.getAddress());
    await expect(f.vault.proposeTreasury(await later.getAddress())).to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
    expect(await f.vault.pendingTreasury()).to.equal(f.carol.address);
    await passTreasuryDelay(f.vault);
    await expect(f.vault.connect(f.carol).acceptTreasury())
      .to.emit(f.vault, 'TreasuryChanged').withArgs(f.treasury.address, f.carol.address);
    expect([await f.vault.treasury(), await f.vault.pendingTreasury()]).to.deep.equal([f.carol.address, ethers.ZeroAddress]);
    await expect(f.vault.connect(f.carol).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'NotPendingTreasury');

    // From now on recoveries go to Carol, never to the old treasury or the owner.
    await f.pulp.connect(f.bob).transfer(vault, 5n);
    await expect(f.vault.recoverExcess(pulp)).to.emit(f.vault, 'Recovered').withArgs(pulp, f.carol.address, 5n);
    await expect(f.vault.addRewardToken(f.carol.address)).to.be.revertedWithCustomError(f.vault, 'NotAContract');
  });

  it('recoverExcess and recoverERC20 take no destination: the only recipient is the treasury', async function () {
    const f = await fixture();
    expect(f.vault.interface.getFunction('recoverExcess').inputs.map((i) => i.name)).to.deep.equal(['token']);
    expect(f.vault.interface.getFunction('recoverERC20').inputs.map((i) => i.name)).to.deep.equal(['token', 'amount']);
    // A compromised owner releases every unearned budget and sweeps: it all lands at the treasury.
    const weth = await f.weth.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD });
    await txAt(f.launch + DAY + 3600n, () => f.vault.enableEmergencyExit());
    await f.vault.connect(f.owner).releasePostExitRewards(weth);
    const owner = await f.weth.balanceOf(f.owner.address);
    const amount = await f.vault.recoverExcess.staticCall(weth);
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalances(f.weth, [f.treasury, f.owner], [amount, 0n]);
    expect(await f.weth.balanceOf(f.owner.address)).to.equal(owner);
    expect(amount).to.equal(70n * WAD - 10n * WAD * 3600n / DAY); // all but the hour Alice earned
  });

  it('EF-1 PoC: a reward token reachable at a second address can no longer be drained through recoverERC20', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress();
    const dual = await addReward(f, 'DUAL', 18, 'MockDualToken');
    const alias = await dual.alias_();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(await dual.getAddress(), 7n * WAD);
    // The alias is not registered, so the address check alone would let it through and move owed rewards.
    expect(await f.vault.isRewardToken(alias)).to.equal(false);
    await expect(f.vault.recoverERC20(alias, 7n * WAD))
      .to.be.revertedWithCustomError(f.vault, 'ReserveBreached').withArgs(await dual.getAddress());
    expect(await dual.balanceOf(vault)).to.equal(7n * WAD);
    // Only a genuine excess can leave through the alias (it is the same tokens either way).
    await dual.mint(vault, 3n);
    await expect(f.vault.recoverERC20(alias, 4n)).to.be.revertedWithCustomError(f.vault, 'ReserveBreached');
    await f.vault.recoverERC20(alias, 3n);
    expect(await dual.balanceOf(f.treasury.address)).to.equal(3n);
    await mineAt(f.launch + 9n * DAY);
    await expect(f.vault.connect(f.alice).claim(await dual.getAddress(), 64)).to.changeTokenBalance(dual, f.alice, 7n * WAD);
  });

  it('EF-1 PoC: PULP reachable at a second address: principal cannot be swept', async function () {
    const f = await fixture({ tokenKind: 'MockDualToken' });
    const vault = await f.vault.getAddress();
    const alias = await f.pulp.alias_();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(5n * PULP, 10));
    await expect(f.vault.recoverERC20(alias, PULP))
      .to.be.revertedWithCustomError(f.vault, 'ReserveBreached').withArgs(await f.pulp.getAddress());
    // recoverExcess on the alias sees the same balance as excess-free PULP: also refused.
    await expect(f.vault.recoverExcess(alias)).to.be.revertedWithCustomError(f.vault, 'ReserveBreached');
    expect(await f.pulp.balanceOf(vault)).to.equal(5n * PULP);
    await mineAt(f.launch + 10n * DAY);
    await expect(f.vault.connect(f.alice).withdraw()).to.changeTokenBalance(f.pulp, f.alice, 5n * PULP);
  });

  it('a reward token whose balanceOf breaks does not block recovering anything else', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'BRK', 18, 'MockBreakableERC20');
    const token = await reward.getAddress(), pulp = await f.pulp.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD);
    await mineAt(f.launch + 9n * DAY);
    await reward.setBroken(true);
    await f.vault.removeRewardToken(token); // retired: still owed, still protected
    await f.pulp.connect(f.bob).transfer(await f.vault.getAddress(), 9n);
    await expect(f.vault.recoverExcess(pulp)).to.changeTokenBalance(f.pulp, f.treasury, 9n);
    await expect(f.vault.recoverERC20(token, 1n)).to.be.revertedWithCustomError(f.vault, 'ProtectedToken');
    await f.vault.connect(f.alice).claim(token, 64); // transfers still work while balanceOf is broken
    await reward.setBroken(false);
    expect(await reward.balanceOf(f.alice.address)).to.equal(7n * WAD);
  });

  it('recovers native ETH forced into the vault, to the treasury only', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress();
    await expect(f.vault.recoverExcess(ethers.ZeroAddress)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    // receive() refuses anyone but a distributor; selfdestruct goes around it.
    await expect(f.stranger.sendTransaction({ to: vault, value: WAD })).to.be.revertedWithCustomError(f.vault, 'NotDistributor');
    await (await ethers.getContractFactory('MockForceSend')).deploy(vault, { value: 3n * WAD });
    expect(await ethers.provider.getBalance(vault)).to.equal(3n * WAD);
    await expect(f.vault.connect(f.stranger).recoverExcess(ethers.ZeroAddress)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.recoverExcess(ethers.ZeroAddress)).to.changeEtherBalances([f.treasury, f.owner], [3n * WAD, 0n]);
    expect(await ethers.provider.getBalance(vault)).to.equal(0n);
    // A treasury that refuses ETH: the recovery reverts and the ETH stays put.
    const refuser = await (await ethers.getContractFactory('MockERC20')).deploy('R', 'R', 18);
    await f.vault.proposeTreasury(await refuser.getAddress());
    await ethers.provider.send('hardhat_impersonateAccount', [await refuser.getAddress()]);
    await ethers.provider.send('hardhat_setBalance', [await refuser.getAddress(), '0xDE0B6B3A7640000']);
    await passTreasuryDelay(f.vault);
    await f.vault.connect(await ethers.getSigner(await refuser.getAddress())).acceptTreasury();
    await (await ethers.getContractFactory('MockForceSend')).deploy(vault, { value: WAD });
    await expect(f.vault.recoverExcess(ethers.ZeroAddress)).to.be.revertedWithCustomError(f.vault, 'NativeTransferFailed');
    expect(await ethers.provider.getBalance(vault)).to.equal(WAD);
  });
});

describe('PulpVeVault: claimTo / claimAllTo', function () {
  it('pays the caller\'s own page to another address; the caller\'s cursor moves, nobody else\'s', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress(), vault = await f.vault.getAddress();
    const reward = await addReward(f, 'BLOCK', 18, 'MockBlockingERC20');
    const token = await reward.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD);
    await mineAt(f.launch + 8n * DAY);
    await expect(f.vault.connect(f.alice).claimTo(weth, 64, ethers.ZeroAddress)).to.be.revertedWithCustomError(f.vault, 'ZeroAddress');
    await expect(f.vault.connect(f.alice).claimTo(weth, 64, vault)).to.be.revertedWithCustomError(f.vault, 'InvalidBeneficiary');
    await expect(f.vault.connect(f.alice).claimTo(weth, 0, f.carol.address)).to.be.revertedWithCustomError(f.vault, 'BadClaimLimit');
    await expect(f.vault.connect(f.alice).claimTo(f.stranger.address, 64, f.carol.address)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    // A token that blocks Alice: claim and claimAll fail for her, claimTo a fresh wallet works.
    await reward.setBlockedRecipient(f.alice.address, true);
    await expect(f.vault.connect(f.alice).claim(token, 64)).to.be.reverted;
    await expect(f.vault.connect(f.alice).claimAll(64)).to.be.reverted;
    const q = await f.vault.claimable(f.alice.address, token, 64);
    const tx = f.vault.connect(f.alice).claimTo(token, 64, f.carol.address);
    await expect(tx).to.emit(f.vault, 'RewardPaid').withArgs(f.alice.address, token, q.amount, q.nextCursor);
    await expect(tx).to.emit(f.vault, 'RewardSentTo').withArgs(f.alice.address, token, f.carol.address, q.amount);
    await expect(tx).to.changeTokenBalances(reward, [f.carol, f.alice], [q.amount, 0n]);
    expect(await f.vault.claimCursor(f.alice.address, token)).to.equal(q.nextCursor);
    expect(await f.vault.claimCursor(f.carol.address, token)).to.equal(0n);
    expect((await f.vault.claimable(f.bob.address, token, 64)).amount).to.equal(q.amount); // Bob's share untouched
    // claimAllTo: every active token, one page each, to `to`.
    const qw = await f.vault.claimable(f.alice.address, weth, 64);
    await expect(f.vault.connect(f.alice).claimAllTo(64, ethers.ZeroAddress)).to.be.revertedWithCustomError(f.vault, 'ZeroAddress');
    const all = f.vault.connect(f.alice).claimAllTo(64, f.carol.address);
    await expect(all).to.emit(f.vault, 'RewardSentTo').withArgs(f.alice.address, weth, f.carol.address, qw.amount);
    await expect(all).to.emit(f.vault, 'RewardSentTo').withArgs(f.alice.address, token, f.carol.address, 0n);
    await expect(all).to.changeTokenBalance(f.weth, f.carol, qw.amount);
    expect(await f.vault.reserved(weth)).to.equal(await f.weth.balanceOf(vault));
  });

  it('cannot be re-entered from a token callback', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'CALLBACK', 18, 'MockReentrantToken');
    const token = await reward.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD);
    await mineAt(f.launch + 8n * DAY);
    await reward.configureCallback(await f.vault.getAddress(), f.vault.interface.encodeFunctionData('claimTo', [token, 64, f.bob.address]), true);
    await f.vault.connect(f.alice).claimTo(token, 64, f.carol.address);
    expect([await reward.attemptedCallbacks(), await reward.succeededCallbacks()]).to.deep.equal([1n, 0n]);
    expect(await reward.balanceOf(f.carol.address)).to.equal(7n * WAD);
  });
});

describe('PulpVeVault: removeRewardToken', function () {
  it('only once no budget is left on an open day; then claimAll skips it and it can never be funded', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'PAUSE', 18, 'MockPausableERC20');
    const token = await reward.getAddress(), weth = await f.weth.getAddress();
    const L = f.launch / DAY;
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD + 1n); // L+1..L+7
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await expect(f.vault.connect(f.stranger).removeRewardToken(token)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.removeRewardToken(f.stranger.address)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    for (const t of [f.launch + DAY, (L + 7n) * DAY + 100n]) {      // a funded day still open or ahead
      await mineAt(t);
      await expect(f.vault.removeRewardToken(token)).to.be.revertedWithCustomError(f.vault, 'RewardsStillScheduled');
    }
    // The token breaks for good: claimAll reverts for everyone.
    await reward.setPaused(true);
    await mineAt((L + 8n) * DAY);
    await expect(f.vault.connect(f.alice).claimAll(64)).to.be.reverted;
    const owedBefore = await f.vault.reserved(token);
    await expect(f.vault.removeRewardToken(token)).to.emit(f.vault, 'RewardTokenRemoved').withArgs(token, true);
    expect(await f.vault.getRewardTokens()).to.deep.equal([weth]);
    expect(await f.vault.getRetiredRewardTokens()).to.deep.equal([token]);
    expect([await f.vault.isRewardToken(token), await f.vault.isRetiredRewardToken(token)]).to.deep.equal([false, true]);
    // claimAll works again (it skips retired tokens) and pays the rest in full.
    await expect(f.vault.connect(f.alice).claimAll(64)).to.changeTokenBalance(f.weth, f.alice, 7n * WAD);
    // The retired token is still owed, reserved and protected; it can't be funded or recycled.
    expect(await f.vault.reserved(token)).to.equal(owedBefore);
    await expect(f.vault.recoverERC20(token, 1n)).to.be.revertedWithCustomError(f.vault, 'ProtectedToken');
    await expect(f.vault.connect(f.distributor).notifyRewardAmount(token, WAD)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await expect(f.vault.recycleEmptyRewards(token, L)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await expect(f.vault.removeRewardToken(token)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    // When the token works again, claim (or claimTo) still pays every entitlement.
    await reward.setPaused(false);
    const q = await f.vault.claimable(f.alice.address, token, 64);
    expect(q.amount).to.equal(7n * WAD + 1n);
    await expect(f.vault.connect(f.alice).claim(token, 64)).to.changeTokenBalance(reward, f.alice, q.amount);
    expect(await f.vault.reserved(token)).to.equal(0n);
    // Re-adding reactivates it with its books intact.
    await expect(f.vault.addRewardToken(token)).to.emit(f.vault, 'RewardTokenAdded').withArgs(token);
    expect(await f.vault.getRewardTokens()).to.deep.equal([weth, token]);
    expect(await f.vault.getRetiredRewardTokens()).to.deep.equal([]);
    expect(await f.vault.totalPaid(token)).to.equal(7n * WAD + 1n);
  });

  it('a fully paid-out token is dropped entirely; a retired one keeps its slot out of the five', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    // Never funded: nothing owed, so it leaves the books and becomes an ordinary (recoverable) token.
    const plain = await addReward(f, 'PLAIN');
    await expect(f.vault.removeRewardToken(await plain.getAddress())).to.emit(f.vault, 'RewardTokenRemoved').withArgs(await plain.getAddress(), false);
    expect(await f.vault.getRetiredRewardTokens()).to.deep.equal([]);
    await plain.mint(await f.vault.getAddress(), 5n);
    await expect(f.vault.recoverERC20(await plain.getAddress(), 5n)).to.changeTokenBalance(plain, f.treasury, 5n);
    // WETH removed: native funding stops too.
    await expect(f.vault.removeRewardToken(weth)).to.emit(f.vault, 'RewardTokenRemoved').withArgs(weth, false);
    await expect(f.vault.connect(f.distributor).notifyRewardETH({ value: 1n })).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await expect(f.distributor.sendTransaction({ to: await f.vault.getAddress(), value: 1n })).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    // Removing frees a slot: five active again.
    for (let i = 0; i < 5; i++) await addReward(f, `R${i}`);
    await expect(f.vault.addRewardToken(await plain.getAddress())).to.be.revertedWithCustomError(f.vault, 'TooManyRewardTokens');
    // PULP as a reward token follows the same rule; retired, compound stops but claim still pays.
    const g = await fixture();
    const pulp = await g.pulp.getAddress();
    await g.vault.addRewardToken(pulp);
    await txAt(g.launch, () => g.vault.connect(g.alice).lock(PULP, 30));
    await txAt(g.launch, () => g.vault.connect(g.bob).lock(PULP, 30));
    await g.vault.connect(g.distributor).notifyRewardAmount(pulp, 7n * PULP + 1n);
    await expect(g.vault.removeRewardToken(pulp)).to.be.revertedWithCustomError(g.vault, 'RewardsStillScheduled');
    await mineAt(g.launch + 8n * DAY);
    await expect(g.vault.removeRewardToken(pulp)).to.emit(g.vault, 'RewardTokenRemoved').withArgs(pulp, true);
    await expect(g.vault.connect(g.alice).compound(64, 200)).to.be.revertedWithCustomError(g.vault, 'NotRewardToken');
    const q = await g.vault.claimable(g.alice.address, pulp, 64);
    await expect(g.vault.connect(g.alice).claimTo(pulp, 64, g.carol.address)).to.changeTokenBalance(g.pulp, g.carol, q.amount);
    expect(await g.vault.reserved(pulp)).to.equal(2n * PULP + 7n * PULP + 1n - q.amount);
    await expect(g.vault.recoverExcess(pulp)).to.be.revertedWithCustomError(g.vault, 'NothingToRecover');
  });

  it('after the exit: removable once every budget after the exit day is released; the exit day stays claimable', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'R');
    const token = await reward.getAddress();
    const L = f.launch / DAY;
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD);
    const x = (L + 2n) * DAY + DAY / 2n;
    await txAt(x, () => f.vault.enableEmergencyExit());
    await expect(f.vault.removeRewardToken(token)).to.be.revertedWithCustomError(f.vault, 'RewardsStillScheduled');
    await f.vault.releasePostExitRewards(token);
    await expect(f.vault.removeRewardToken(token)).to.emit(f.vault, 'RewardTokenRemoved').withArgs(token, true);
    await expect(f.vault.connect(f.alice).claim(token, 64)).to.changeTokenBalance(reward, f.alice, WAD + WAD / 2n);
    await expect(f.vault.recoverExcess(token)).to.changeTokenBalance(reward, f.treasury, 5n * WAD + WAD / 2n);
    expect(await f.vault.reserved(token)).to.equal(0n);
  });
});

describe('PulpVeVault: funding events (GA-3)', function () {
  it('logs RewardNotified with the funder on every funding path', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress(), pulp = await f.pulp.getAddress();
    await f.vault.addRewardToken(pulp);
    await expect(f.vault.connect(f.distributor).notifyRewardETH({ value: 7n }))
      .to.emit(f.vault, 'RewardNotified').withArgs(weth, f.distributor.address, 7n);
    await expect(f.distributor.sendTransaction({ to: await f.vault.getAddress(), value: 14n }))
      .to.emit(f.vault, 'RewardNotified').withArgs(weth, f.distributor.address, 14n);
    await expect(f.vault.connect(f.distributor).notifyRewardAmount(pulp, 21n))
      .to.emit(f.vault, 'RewardNotified').withArgs(pulp, f.distributor.address, 21n);
    const gas = (await (await f.vault.connect(f.distributor).notifyRewardETH({ value: WAD })).wait()).gasUsed;
    console.log(`      gas: notifyRewardETH (7 days, warm slots)=${gas}`);
  });
});
