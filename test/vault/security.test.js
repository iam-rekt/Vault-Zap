const { expect } = require('chai');
const { ethers, DAY, WAD, PULP, MAX, mineAt, txAt, fixture, addReward } = require('./helpers');

describe('PulpVeVault: adversarial and operational checks', function () {
  it('rejects fee-on-transfer principal and rolls back all state', async function () {
    const f = await fixture({ tokenKind: 'MockFeeToken' });
    await f.pulp.setFeeBps(100);
    await mineAt(f.launch);
    await expect(f.vault.connect(f.alice).lock(PULP, 30)).to.be.revertedWithCustomError(f.vault, 'UnsupportedTransfer');
    expect(await f.vault.totalLocked()).to.equal(0);
    expect(await f.vault.userEpochCount(f.alice.address)).to.equal(0);
    expect(await f.pulp.balanceOf(await f.vault.getAddress())).to.equal(0);
  });
  it('rejects taxed reward funding without scheduling an unfunded liability', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'TAX', 18, 'MockFeeToken');
    await reward.setFeeBps(100);
    await mineAt(f.launch);
    await expect(f.vault.connect(f.distributor).notifyRewardAmount(await reward.getAddress(), WAD))
      .to.be.revertedWithCustomError(f.vault, 'UnsupportedTransfer');
    expect(await f.vault.totalNotified(await reward.getAddress())).to.equal(0);
  });
  it('reverts a false-return incoming transfer instead of creating an unbacked lock', async function () {
    const f = await fixture({ tokenKind: 'MockFalseReturnToken' });
    await f.pulp.setReturnFalse(true);
    await mineAt(f.launch);
    await expect(f.vault.connect(f.alice).lock(PULP, 30)).to.be.reverted;
    expect(await f.vault.totalLocked()).to.equal(0);
    expect((await f.vault.locks(f.alice.address)).amount).to.equal(0);
  });
  it('retains the claim cursor and entitlement after a false-return payout', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'FALSE', 18, 'MockFalseReturnToken');
    const token = await reward.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD);
    await mineAt(f.launch + 8n * DAY);
    await reward.setReturnFalse(true);
    await expect(f.vault.connect(f.alice).claim(token, 64)).to.be.reverted;
    expect(await f.vault.claimCursor(f.alice.address, token)).to.equal(0);
    expect((await f.vault.claimable(f.alice.address, token, 64)).amount).to.equal(7n * WAD);
    expect(await f.vault.totalPaid(token)).to.equal(0);
    await reward.setReturnFalse(false);
    await f.vault.connect(f.alice).claim(token, 64);
    expect(await reward.balanceOf(f.alice.address)).to.equal(7n * WAD);
  });
  it('a blocked reward token cannot prevent claiming another reward or withdrawing principal', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'BLOCK', 18, 'MockBlockingERC20');
    const token = await reward.getAddress(), native = await f.weth.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await mineAt(f.launch + 10n * DAY);
    await reward.setBlockedRecipient(f.alice.address, true);
    await expect(f.vault.connect(f.alice).claimAll(64)).to.be.reverted;
    expect(await f.weth.balanceOf(f.alice.address)).to.equal(0);
    await f.vault.connect(f.alice).claim(native, 64);
    await f.vault.connect(f.alice).withdraw();
    expect(await f.weth.balanceOf(f.alice.address)).to.equal(7n * WAD);
    await reward.setBlockedRecipient(f.alice.address, false);
    await f.vault.connect(f.alice).claim(token, 64);
    expect(await reward.balanceOf(f.alice.address)).to.equal(7n * WAD);
  });
  it('documents the underlying-token freeze boundary without losing principal bookkeeping', async function () {
    const f = await fixture({ tokenKind: 'MockBlockingERC20' });
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    await mineAt(f.launch + 10n * DAY);
    await f.pulp.setBlockedRecipient(f.alice.address, true);
    await expect(f.vault.connect(f.alice).withdraw()).to.be.reverted;
    expect(await f.vault.totalLocked()).to.equal(PULP);
    expect((await f.vault.locks(f.alice.address)).amount).to.equal(PULP);
    await f.pulp.setBlockedRecipient(f.alice.address, false);
    await f.vault.connect(f.alice).withdraw();
    expect(await f.vault.totalLocked()).to.equal(0);
  });
  it('rejects reentrant lock/top-up/delegated/compound/extend/withdraw/funding/claim calls during a token pull', async function () {
    const f = await fixture({ tokenKind: 'MockReentrantToken' });
    await mineAt(f.launch);
    const token = await f.weth.getAddress();
    const calls = [
      ['lock', [PULP, 10]], ['increaseAmount', [PULP]], ['extend', [30]], ['withdraw', []],
      ['notifyRewardAmount', [token, 1n]], ['claim', [token, 64]], ['claimAll', [64]],
      ['lockFor', [f.bob.address, PULP, 10]], ['increaseAmountFor', [f.alice.address, PULP]], ['compound', [64, 200]],
    ];
    for (let i = 0; i < calls.length; ++i) {
      const [name, args] = calls[i];
      await f.pulp.configureCallback(await f.vault.getAddress(), f.vault.interface.encodeFunctionData(name, args), true);
      if (i === 0) await f.vault.connect(f.alice).lock(PULP, 30);
      else await f.vault.connect(f.alice).increaseAmount(PULP);
    }
    expect(await f.pulp.attemptedCallbacks()).to.equal(calls.length);
    expect(await f.pulp.succeededCallbacks()).to.equal(0);
    expect(await f.vault.totalLocked()).to.equal(PULP * BigInt(calls.length));
  });
  it('rejects callback claims during outgoing reward transfer', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'CALLBACK', 18, 'MockReentrantToken');
    const token = await reward.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * WAD);
    await mineAt(f.launch + 8n * DAY);
    await reward.configureCallback(await f.vault.getAddress(), f.vault.interface.encodeFunctionData('claim', [token, 64]), true);
    await f.vault.connect(f.alice).claim(token, 64);
    expect(await reward.attemptedCallbacks()).to.equal(1);
    expect(await reward.succeededCallbacks()).to.equal(0);
    expect(await reward.balanceOf(f.alice.address)).to.equal(7n * WAD);
  });
  it('enforces distributor/owner boundaries and two-step ownership transfer', async function () {
    const f = await fixture();
    await expect(f.vault.connect(f.stranger).notifyRewardETH({ value: 1n })).to.be.revertedWithCustomError(f.vault, 'NotDistributor');
    await expect(f.vault.connect(f.stranger).setDistributor(f.stranger.address, true)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.connect(f.stranger).setLocksPaused(true)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await f.vault.transferOwnership(f.alice.address);
    expect(await f.vault.owner()).to.equal(f.owner.address);
    await expect(f.vault.connect(f.bob).acceptOwnership()).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await f.vault.connect(f.alice).acceptOwnership();
    expect(await f.vault.owner()).to.equal(f.alice.address);
    await f.vault.connect(f.alice).setDistributor(f.distributor.address, false);
    await expect(f.vault.connect(f.distributor).notifyRewardETH({ value: 1n })).to.be.revertedWithCustomError(f.vault, 'NotDistributor');
  });
  it('protects principal and all registered reward assets from recovery; strays go only to the treasury', async function () {
    const f = await fixture();
    await expect(f.vault.recoverERC20(await f.pulp.getAddress(), 1n)).to.be.revertedWithCustomError(f.vault, 'ProtectedToken');
    await expect(f.vault.recoverERC20(await f.weth.getAddress(), 1n)).to.be.revertedWithCustomError(f.vault, 'ProtectedToken');
    const stray = await (await ethers.getContractFactory('MockERC20')).deploy('STRAY', 'STRAY', 18);
    await stray.mint(await f.vault.getAddress(), WAD);
    await expect(f.vault.connect(f.stranger).recoverERC20(await stray.getAddress(), WAD)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.recoverERC20(await stray.getAddress(), WAD))
      .to.emit(f.vault, 'Recovered').withArgs(await stray.getAddress(), f.treasury.address, WAD);
    expect(await stray.balanceOf(f.treasury.address)).to.equal(WAD);
    expect(await stray.balanceOf(f.owner.address)).to.equal(0n);
  });
  it('returns PULP sent by mistake to the treasury without touching locked principal', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(5n * PULP, 10));
    await expect(f.vault.recoverExcess(pulp)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    await f.pulp.connect(f.bob).transfer(vault, 3n * WAD);                       // the mistake
    expect(await f.vault.reserved(pulp)).to.equal(5n * PULP);
    await expect(f.vault.connect(f.stranger).recoverExcess(pulp)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    const before = await f.pulp.balanceOf(f.treasury.address);
    await f.vault.recoverExcess(pulp);
    expect(await f.pulp.balanceOf(f.treasury.address)).to.equal(before + 3n * WAD);
    expect(await f.pulp.balanceOf(vault)).to.equal(5n * PULP);
    await expect(f.vault.recoverExcess(pulp)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    await txAt(f.launch + 10n * DAY, () => f.vault.connect(f.alice).withdraw());
    expect(await f.pulp.balanceOf(vault)).to.equal(0);
  });
  it('returns stray WETH while every notified reward stays claimable', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), weth = await f.weth.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP * 3n, 20));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await f.weth.connect(f.carol).deposit({ value: 2n * WAD });
    await f.weth.connect(f.carol).transfer(vault, 2n * WAD);                      // the mistake
    expect(await f.vault.reserved(weth)).to.equal(7n * WAD);
    await f.vault.recoverExcess(weth);
    expect(await f.weth.balanceOf(f.treasury.address)).to.equal(2n * WAD);
    await mineAt(f.launch + 9n * DAY);
    await f.vault.connect(f.alice).claim(weth, 64);
    await f.vault.connect(f.bob).claim(weth, 64);
    const paid = (await f.weth.balanceOf(f.alice.address)) + (await f.weth.balanceOf(f.bob.address));
    expect(7n * WAD - paid).to.be.lessThan(10n);                                  // all of it, bar rounding dust
    expect(await f.weth.balanceOf(vault)).to.equal(await f.vault.reserved(weth)); // dust stays reserved
    await expect(f.vault.recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
  });
  it('keeps both principal and PULP rewards when PULP is also a reward token', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress();
    await f.vault.addRewardToken(pulp);
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(2n * PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(pulp, 7n * PULP);
    await f.pulp.connect(f.bob).transfer(vault, WAD);                            // the mistake
    expect(await f.vault.reserved(pulp)).to.equal(2n * PULP + 7n * PULP);
    await f.vault.recoverExcess(pulp);
    expect(await f.pulp.balanceOf(vault)).to.equal(9n * PULP);
    await mineAt(f.launch + 9n * DAY);
    await f.vault.connect(f.alice).claim(pulp, 64);
    expect(await f.vault.reserved(pulp)).to.equal(2n * PULP + 7n * PULP - (await f.vault.totalPaid(pulp)));
    await txAt(f.launch + 30n * DAY, () => f.vault.connect(f.alice).withdraw());
    expect(await f.pulp.balanceOf(vault)).to.equal(await f.vault.reserved(pulp));
  });
  it('disables renunciation so pause and distributor settings can be repaired', async function () {
    const f = await fixture();
    await f.vault.setLocksPaused(true);
    await f.vault.setDistributor(f.distributor.address, false);
    await expect(f.vault.renounceOwnership()).to.be.revertedWithCustomError(f.vault, 'RenounceDisabled');
    expect(await f.vault.owner()).to.equal(f.owner.address);
    await f.vault.setLocksPaused(false);
    await f.vault.setDistributor(f.distributor.address, true);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 1n });
  });
  it('bounds reward registration and rejects duplicate/non-contract assets', async function () {
    const f = await fixture();
    await expect(f.vault.addRewardToken(await f.weth.getAddress())).to.be.revertedWithCustomError(f.vault, 'RewardTokenExists');
    await expect(f.vault.addRewardToken(f.alice.address)).to.be.revertedWithCustomError(f.vault, 'NotAContract');
    for (let i = 0; i < 4; i++) await addReward(f, 'R' + i);
    const extra = await (await ethers.getContractFactory('MockERC20')).deploy('EXTRA', 'EXTRA', 18);
    await expect(f.vault.addRewardToken(await extra.getAddress())).to.be.revertedWithCustomError(f.vault, 'TooManyRewardTokens');
  });
  it('keeps inactive years out of withdrawal gas and bounds long claim histories', async function () {
    const f = await fixture();
    const token = await f.weth.getAddress();
    const initial = await (await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30))).wait();
    expect(initial.gasUsed).to.be.lessThan(3000000n);
    for (let i = 1n; i <= 5n; i++) {
      await txAt(f.launch + i * 20n * DAY, () => f.vault.connect(f.alice).extend(30));
      await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    }
    await mineAt(f.launch + 3650n * DAY);
    const receipt = await (await f.vault.connect(f.alice).withdraw()).wait();
    expect(receipt.gasUsed).to.be.lessThan(100000n);
    expect((await f.vault.claimable(f.alice.address, token, 64)).caughtUp).to.equal(false);
    const page1 = await (await f.vault.connect(f.alice).claim(token, 64)).wait();
    expect(page1.gasUsed).to.be.lessThan(1200000n);
    await f.vault.connect(f.alice).claim(token, 64);
    await f.vault.connect(f.alice).claim(token, 64);
    expect((await f.vault.claimable(f.alice.address, token, 64)).caughtUp).to.equal(true);
    expect(await f.weth.balanceOf(f.alice.address)).to.equal(35n * WAD);
    console.log(`      gas: 30-day lock=${initial.gasUsed}, idle-10y withdraw=${receipt.gasUsed}, 64-day claim=${page1.gasUsed}`);
  });
  it('pays very large reward budgets at the principal cap without intermediate overflow', async function () {
    const f = await fixture();
    const reward = await (await ethers.getContractFactory('MockERC20')).deploy('BIG', 'BIG', 18);
    const token = await reward.getAddress();
    await f.vault.addRewardToken(token);
    await reward.mint(f.distributor.address, MAX);
    await reward.connect(f.distributor).approve(await f.vault.getAddress(), MAX);
    const cap = await f.vault.MAX_TOTAL_LOCKED();
    await f.pulp.mint(f.alice.address, cap);
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(cap, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, MAX);
    await mineAt(f.launch + 8n * DAY);
    await f.vault.connect(f.alice).claim(token, 64);
    expect(await reward.balanceOf(f.alice.address)).to.equal(MAX);
    expect(await f.vault.totalPaid(token)).to.equal(MAX);
  });
});
