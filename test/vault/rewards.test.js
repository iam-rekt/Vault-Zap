const { expect } = require('chai');
const { ethers, DAY, WAD, PULP, mineAt, txAt, fixture, addReward } = require('./helpers');

describe('PulpVeVault: daily fee rewards', function () {
  it('wraps native fees, funds seven full future days, and delays claims until close', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    const token = await f.weth.getAddress(), epoch = f.launch / DAY;
    expect(await f.weth.balanceOf(await f.vault.getAddress())).to.equal(7n * WAD);
    expect(await f.vault.epochRewards(token, epoch)).to.equal(0);
    for (let i = 1n; i <= 7n; i++) expect(await f.vault.epochRewards(token, epoch + i)).to.equal(WAD);
    await mineAt(f.launch + DAY + DAY / 2n);
    expect((await f.vault.claimable(f.alice.address, token, 64)).amount).to.equal(0);
    await mineAt(f.launch + 2n * DAY);
    expect((await f.vault.claimable(f.alice.address, token, 64)).amount).to.equal(WAD);
    await f.vault.connect(f.alice).claim(token, 64);
    expect(await f.weth.balanceOf(f.alice.address)).to.equal(WAD);
    await mineAt(f.launch + 8n * DAY);
    await f.vault.connect(f.alice).claim(token, 64);
    expect(await f.weth.balanceOf(f.alice.address)).to.equal(7n * WAD);
  });
  it('accepts an ordinary native transfer ONLY from an authorized distributor', async function () {
    const f = await fixture();
    await expect(f.alice.sendTransaction({ to: await f.vault.getAddress(), value: WAD }))
      .to.be.revertedWithCustomError(f.vault, 'NotDistributor');
    await f.distributor.sendTransaction({ to: await f.vault.getAddress(), value: 7n * WAD });
    expect(await f.vault.totalNotified(await f.weth.getAddress())).to.equal(7n * WAD);
    const noNative = await fixture({ nativeDisabled: true });
    await expect(noNative.vault.connect(noNative.distributor).notifyRewardETH({ value: 1n }))
      .to.be.revertedWithCustomError(noNative.vault, 'NativeDisabled');
  });
  it('uses exact integral-of-power ratios, not initial power or a snapshot', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await mineAt(f.launch + 2n * DAY);
    const token = await f.weth.getAddress();
    // Day [1,2): equal boosted amounts, mean remaining times 8.5 and 28.5 days.
    expect((await f.vault.claimable(f.alice.address, token, 64)).amount).to.equal(WAD * 17n / 74n);
    expect((await f.vault.claimable(f.bob.address, token, 64)).amount).to.equal(WAD * 57n / 74n);
    await f.vault.connect(f.alice).claim(token, 64);
    await f.vault.connect(f.bob).claim(token, 64);
    expect(await f.vault.totalPaid(token)).to.be.at.most(WAD);
  });
  it('does not let a late arrival earn a whole day from a snapshot', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await txAt(f.launch + 2n * DAY - 1n, () => f.vault.connect(f.bob).lock(PULP, 30));
    await mineAt(f.launch + 2n * DAY);
    const token = await f.weth.getAddress();
    const bob = (await f.vault.claimable(f.bob.address, token, 64)).amount;
    expect(bob).to.be.greaterThan(0);
    expect(bob).to.be.lessThan(WAD / 10000n);
  });
  it('never lets extensions, new deposits, or funding change closed-day entitlement', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 20));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await mineAt(f.launch + 2n * DAY);
    const token = await f.weth.getAddress();
    const before = (await f.vault.claimable(f.alice.address, token, 64)).amount;
    await f.vault.connect(f.bob).extend(30);
    await f.vault.connect(f.bob).increaseAmount(PULP * 100n);
    await f.vault.connect(f.carol).lock(PULP * 100n, 30);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    expect((await f.vault.claimable(f.alice.address, token, 64)).amount).to.equal(before);
    expect(await f.vault.epochRewards(token, f.launch / DAY + 1n)).to.equal(WAD);
  });
  it('funding is additive; dust top-ups cannot postpone an existing budget', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    const token = await f.weth.getAddress(), e = f.launch / DAY;
    await txAt(f.launch + DAY, () => f.vault.connect(f.distributor).notifyRewardETH({ value: 1n }));
    expect(await f.vault.epochRewards(token, e + 1n)).to.equal(WAD);
    for (let i = 2n; i <= 7n; i++) expect(await f.vault.epochRewards(token, e + i)).to.equal(WAD);
    expect(await f.vault.epochRewards(token, e + 8n)).to.equal(1);
    await expect(f.vault.connect(f.distributor).notifyRewardETH()).to.be.revertedWithCustomError(f.vault, 'NothingToFund');
  });
  it('never schedules pre-launch rewards even when prefunded', async function () {
    const f = await fixture();
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    const token = await f.weth.getAddress();
    expect(await f.vault.epochRewards(token, f.launch / DAY - 1n)).to.equal(0);
    expect(await f.vault.epochRewards(token, f.launch / DAY)).to.equal(WAD);
  });
  it('withdrawal and a much later re-entry preserve every earned reward', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await txAt(f.launch + 10n * DAY, () => f.vault.connect(f.alice).withdraw());
    await txAt(f.launch + 2000n * DAY, () => f.vault.connect(f.alice).lock(PULP, 20));
    const token = await f.weth.getAddress();
    expect((await f.vault.claimable(f.alice.address, token, 64)).amount).to.equal(7n * WAD);
    await f.vault.connect(f.alice).claim(token, 64);
    expect(await f.weth.balanceOf(f.alice.address)).to.equal(7n * WAD);
    expect(await f.vault.userEpochCount(f.alice.address)).to.equal(30);
  });
  it('claiming twice pays once; closing another page does not double count', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await mineAt(f.launch + 8n * DAY);
    const token = await f.weth.getAddress();
    for (let i = 0; i < 8; i++) await f.vault.connect(f.alice).claim(token, 1);
    expect(await f.weth.balanceOf(f.alice.address)).to.equal(7n * WAD);
    await f.vault.connect(f.alice).claim(token, 64);
    await f.vault.connect(f.alice).claimAll(64);
    expect(await f.weth.balanceOf(f.alice.address)).to.equal(7n * WAD);
    expect((await f.vault.claimable(f.alice.address, token, 64)).caughtUp).to.equal(true);
    await expect(f.vault.connect(f.alice).claim(token, 0)).to.be.revertedWithCustomError(f.vault, 'BadClaimLimit');
    await expect(f.vault.connect(f.alice).claim(token, 65)).to.be.revertedWithCustomError(f.vault, 'BadClaimLimit');
  });
  it('recycles genuinely empty days once, without touching earned or unclaimed rewards', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD }));
    const token = await f.weth.getAddress(), e = f.launch / DAY + 1n;
    await expect(f.vault.recycleEmptyRewards(token, e)).to.be.revertedWithCustomError(f.vault, 'EpochNotClosed');
    await mineAt(f.launch + 2n * DAY);
    await f.vault.connect(f.stranger).recycleEmptyRewards(token, e);
    expect(await f.vault.epochRewards(token, e)).to.equal(0);
    expect(await f.vault.totalNotified(token)).to.equal(7n * WAD);
    await expect(f.vault.recycleEmptyRewards(token, e)).to.be.revertedWithCustomError(f.vault, 'NothingToFund');
    await f.vault.connect(f.alice).lock(PULP, 30);
    await mineAt(f.launch + 3n * DAY);
    await expect(f.vault.recycleEmptyRewards(token, e + 1n)).to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
  });
  it('keeps PULP principal separate when PULP is also a reward token', async function () {
    const f = await fixture();
    const token = await f.pulp.getAddress();
    await f.vault.addRewardToken(token);
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7n * PULP);
    await mineAt(f.launch + 8n * DAY);
    await f.vault.connect(f.alice).claim(token, 64);
    expect(await f.pulp.balanceOf(await f.vault.getAddress())).to.equal(PULP);
    expect(await f.vault.totalLocked()).to.equal(PULP);
    await txAt(f.launch + 10n * DAY, () => f.vault.connect(f.alice).withdraw());
    expect(await f.pulp.balanceOf(await f.vault.getAddress())).to.equal(0);
  });
  it('handles six-decimal rewards and rounds payouts down without insolvency', async function () {
    const f = await fixture();
    const reward = await addReward(f, 'USDC', 6);
    const token = await reward.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP * 2n, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(token, 7000001n);
    await mineAt(f.launch + 8n * DAY);
    await f.vault.connect(f.alice).claim(token, 64);
    await f.vault.connect(f.bob).claim(token, 64);
    const paid = await f.vault.totalPaid(token);
    expect(paid).to.be.at.most(7000001n);
    expect(7000001n - paid).to.be.at.most(7n);
    expect(await reward.balanceOf(await f.vault.getAddress())).to.equal(7000001n - paid);
  });
  it('does not count direct ERC20 donations as notified rewards or allow admin recovery', async function () {
    const f = await fixture();
    const reward = await addReward(f);
    const token = await reward.getAddress();
    await reward.connect(f.distributor).transfer(await f.vault.getAddress(), WAD);
    expect(await f.vault.totalNotified(token)).to.equal(0);
    await expect(f.vault.recoverERC20(token, WAD)).to.be.revertedWithCustomError(f.vault, 'ProtectedToken');
  });
  it('makes the tiny-budget rounding limitation explicit', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n });
    await mineAt(f.launch + 8n * DAY);
    const token = await f.weth.getAddress();
    await f.vault.connect(f.alice).claim(token, 64);
    await f.vault.connect(f.bob).claim(token, 64);
    expect(await f.vault.totalPaid(token)).to.equal(0);
    expect(await f.weth.balanceOf(await f.vault.getAddress())).to.equal(7n);
    await expect(f.vault.recycleEmptyRewards(token, f.launch / DAY + 1n))
      .to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
  });
});
