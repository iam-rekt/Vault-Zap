// Re-review fixes: L-1 (a pending treasury does not survive an ownership change), L-2 (treasury changes
// wait TREASURY_DELAY = 8 days; the current treasury can sweep what it is due meanwhile), I-3 (capped,
// conservative balance reads in the recovery reserve check).
const { expect } = require('chai');
const { ethers, DAY, WAD, PULP, mineAt, txAt, fixture, addReward } = require('./helpers');

const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp);

describe('PulpVeVault: a pending treasury does not survive an ownership change (L-1)', function () {
  it('a treasury proposed by the deployer is cancelled when the multisig accepts ownership', async function () {
    const f = await fixture();
    const deployer = f.owner, multisig = f.carol, attacker = f.stranger;
    // The deployer's hot key (compromised, or just careless) proposes an address before the handover.
    await f.vault.connect(deployer).proposeTreasury(attacker.address);
    await f.vault.connect(deployer).transferOwnership(multisig.address);
    expect(await f.vault.pendingTreasury()).to.equal(attacker.address); // the offer alone changes nothing
    const tx = f.vault.connect(multisig).acceptOwnership();
    await expect(tx).to.emit(f.vault, 'TreasuryProposed').withArgs(ethers.ZeroAddress);
    await expect(tx).to.emit(f.vault, 'OwnershipTransferred').withArgs(deployer.address, multisig.address);
    expect([await f.vault.owner(), await f.vault.pendingTreasury(), await f.vault.treasuryProposedAt()])
      .to.deep.equal([multisig.address, ethers.ZeroAddress, 0n]);
    // Long after the delay, the old proposal can't be accepted, and recoveries still reach the treasury.
    await mineAt((await now()) + 30n * DAY);
    await expect(f.vault.connect(attacker).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'NotPendingTreasury');
    await f.pulp.connect(f.bob).transfer(await f.vault.getAddress(), 5n);
    await expect(f.vault.connect(multisig).recoverExcess(await f.pulp.getAddress()))
      .to.changeTokenBalances(f.pulp, [f.treasury, attacker], [5n, 0n]);
    // The new owner can propose afresh; that proposal waits its own 8 days.
    await f.vault.connect(multisig).proposeTreasury(f.bob.address);
    await expect(f.vault.connect(f.bob).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver');
  });

  it('an ownership change with nothing pending logs no treasury event; any pending proposal is cleared on every change', async function () {
    const f = await fixture();
    await f.vault.transferOwnership(f.carol.address);
    await expect(f.vault.connect(f.carol).acceptOwnership()).to.not.emit(f.vault, 'TreasuryProposed');
    // Even a proposal made by the incoming owner's own predecessor seconds before is dropped on the change.
    await f.vault.connect(f.carol).proposeTreasury(f.bob.address);
    await f.vault.connect(f.carol).transferOwnership(f.alice.address);
    await expect(f.vault.connect(f.alice).acceptOwnership()).to.emit(f.vault, 'TreasuryProposed').withArgs(ethers.ZeroAddress);
    expect(await f.vault.pendingTreasury()).to.equal(ethers.ZeroAddress);
    await mineAt((await now()) + 9n * DAY);
    await expect(f.vault.connect(f.bob).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'NotPendingTreasury');
    expect(await f.vault.treasury()).to.equal(f.treasury.address);
  });
});

describe('PulpVeVault: treasury changes wait TREASURY_DELAY (L-2)', function () {
  it('accepts only 8 days after the proposal, to the second; the time is exposed and cleared', async function () {
    const f = await fixture();
    expect(await f.vault.TREASURY_DELAY()).to.equal(8n * DAY);
    expect(await f.vault.treasuryProposedAt()).to.equal(0n);
    const t = (await now()) + 100n;
    await expect(txAt(t, () => f.vault.proposeTreasury(f.carol.address))).to.emit(f.vault, 'TreasuryProposed').withArgs(f.carol.address);
    expect(await f.vault.treasuryProposedAt()).to.equal(t);
    // Only the proposed address, and only from t + 8 days.
    await expect(f.vault.connect(f.bob).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'NotPendingTreasury');
    await expect(f.vault.connect(f.carol).acceptTreasury())
      .to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver').withArgs(t + 8n * DAY);
    await expect(txAt(t + 8n * DAY - 1n, () => f.vault.connect(f.carol).acceptTreasury()))
      .to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver').withArgs(t + 8n * DAY);
    await expect(txAt(t + 8n * DAY, () => f.vault.connect(f.carol).acceptTreasury()))
      .to.emit(f.vault, 'TreasuryChanged').withArgs(f.treasury.address, f.carol.address);
    expect([await f.vault.treasury(), await f.vault.pendingTreasury(), await f.vault.treasuryProposedAt()])
      .to.deep.equal([f.carol.address, ethers.ZeroAddress, 0n]);
  });

  it('a new proposal restarts the clock, even for the same address; zero cancels', async function () {
    const f = await fixture();
    const t = (await now()) + 100n;
    await txAt(t, () => f.vault.proposeTreasury(f.carol.address));
    // Re-proposing the same address five days later: the clock restarts from then.
    await expect(txAt(t + 5n * DAY, () => f.vault.proposeTreasury(f.carol.address)))
      .to.emit(f.vault, 'TreasuryProposed').withArgs(f.carol.address);
    expect(await f.vault.treasuryProposedAt()).to.equal(t + 5n * DAY);
    await expect(txAt(t + 8n * DAY, () => f.vault.connect(f.carol).acceptTreasury()))
      .to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver').withArgs(t + 13n * DAY);
    // Proposing someone else replaces the proposal and restarts the clock again.
    await txAt(t + 9n * DAY, () => f.vault.proposeTreasury(f.bob.address));
    await expect(txAt(t + 13n * DAY, () => f.vault.connect(f.carol).acceptTreasury())).to.be.revertedWithCustomError(f.vault, 'NotPendingTreasury');
    await expect(f.vault.connect(f.bob).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver').withArgs(t + 17n * DAY);
    // Zero cancels: nothing pending, no time, and nobody can accept, ever.
    await expect(f.vault.proposeTreasury(ethers.ZeroAddress)).to.emit(f.vault, 'TreasuryProposed').withArgs(ethers.ZeroAddress);
    expect([await f.vault.pendingTreasury(), await f.vault.treasuryProposedAt()]).to.deep.equal([ethers.ZeroAddress, 0n]);
    await mineAt(t + 40n * DAY);
    for (const s of [f.bob, f.carol]) {
      await expect(f.vault.connect(s).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'NotPendingTreasury');
    }
    expect(await f.vault.treasury()).to.equal(f.treasury.address);
  });

  it('a compromised owner cannot route the unearned post-exit rewards to itself: the treasury sweeps them during the delay', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress(), attacker = f.stranger;
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD }); // days L+1 .. L+7
    // The owner key is stolen one hour into the first funded day. Every step it can take, in a row:
    const x = f.launch + DAY + 3600n;
    await txAt(x, () => f.vault.proposeTreasury(attacker.address));
    await f.vault.enableEmergencyExit();
    await f.vault.releasePostExitRewards(weth);
    await expect(f.vault.connect(attacker).acceptTreasury()).to.be.revertedWithCustomError(f.vault, 'TreasuryDelayNotOver');
    // The owner holds the sweep back for its own treasury, but the current treasury pulls what it is due now.
    // Nobody else can trigger a recovery.
    await expect(f.vault.connect(f.bob).recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    const released = await f.vault.recoverExcess.staticCall(weth);
    expect(released).to.be.greaterThan(60n * WAD);
    await expect(f.vault.connect(f.treasury).recoverExcess(weth)).to.changeTokenBalances(f.weth, [f.treasury, attacker], [released, 0n]);
    // Eight days later the attacker's treasury takes over and finds nothing left to sweep.
    await passDelay(f);
    await f.vault.connect(attacker).acceptTreasury();
    await expect(f.vault.connect(attacker).recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    // Alice's earned hour is untouched.
    await expect(f.vault.connect(f.alice).claim(weth, 64)).to.changeTokenBalance(f.weth, f.alice, 70n * WAD - released);
    expect(await f.vault.reserved(weth)).to.equal(0n);
  });

  it('while a change is pending, recoveries keep paying the current treasury, by the owner or by the treasury itself', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress();
    const stray = await (await ethers.getContractFactory('MockERC20')).deploy('S', 'S', 18);
    await stray.mint(vault, 10n);
    await f.pulp.connect(f.bob).transfer(vault, 6n);
    await f.vault.proposeTreasury(f.carol.address);
    await expect(f.vault.recoverERC20(await stray.getAddress(), 4n)).to.changeTokenBalances(stray, [f.treasury, f.carol], [4n, 0n]);
    await expect(f.vault.connect(f.treasury).recoverERC20(await stray.getAddress(), 6n)).to.changeTokenBalance(stray, f.treasury, 6n);
    await expect(f.vault.connect(f.treasury).recoverExcess(pulp)).to.changeTokenBalance(f.pulp, f.treasury, 6n);
    // The pending treasury is not the treasury yet: it can't trigger recoveries.
    await stray.mint(vault, 1n);
    await expect(f.vault.connect(f.carol).recoverERC20(await stray.getAddress(), 1n)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.connect(f.carol).recoverExcess(pulp)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    // The treasury gets nothing it isn't due: protected tokens are still refused, reserves still enforced.
    await expect(f.vault.connect(f.treasury).recoverERC20(pulp, 1n)).to.be.revertedWithCustomError(f.vault, 'ProtectedToken');
    await expect(f.vault.connect(f.treasury).recoverExcess(pulp)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    // And it has no other owner power.
    await expect(f.vault.connect(f.treasury).proposeTreasury(f.treasury.address)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.connect(f.treasury).enableEmergencyExit()).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
  });
});

async function passDelay(f) {
  await mineAt((await f.vault.treasuryProposedAt()) + 8n * DAY);
}

describe('PulpVeVault: balance reads in the recovery check are capped and conservative (I-3)', function () {
  async function flaky(f) {
    const token = await addReward(f, 'FLAKY', 18, 'MockFlakyDualToken');
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardAmount(await token.getAddress(), 7n * WAD);
    return { token, address: await token.getAddress(), alias: await token.alias_() };
  }

  it('a token unreadable before the transfer is held to all of reserved: a drain that repairs balanceOf is caught', async function () {
    const f = await fixture();
    const { token, address, alias } = await flaky(f);
    await token.setBroken(true);
    await token.setOnAliasTransfer(1); // the drain through the alias makes balanceOf work again
    // Before this fix the unreadable balance counted as 0, so the floor was 0 and this drained every owed unit.
    await expect(f.vault.recoverERC20(alias, 7n * WAD)).to.be.revertedWithCustomError(f.vault, 'ReserveBreached').withArgs(address);
    await token.setBroken(false);
    expect(await token.balanceOf(await f.vault.getAddress())).to.equal(7n * WAD);
  });

  it('a token readable before but not after the transfer counts as breached', async function () {
    const f = await fixture();
    const { token, address, alias } = await flaky(f);
    await token.setOnAliasTransfer(2); // the drain breaks balanceOf
    await expect(f.vault.recoverERC20(alias, 7n * WAD)).to.be.revertedWithCustomError(f.vault, 'ReserveBreached').withArgs(address);
    await expect(f.vault.recoverERC20(alias, 1n)).to.be.revertedWithCustomError(f.vault, 'ReserveBreached').withArgs(address);
    // A genuine excess through the alias still leaves when balanceOf keeps working.
    await token.setOnAliasTransfer(0);
    await token.mint(await f.vault.getAddress(), 3n);
    await expect(f.vault.recoverERC20(alias, 3n)).to.changeTokenBalance(token, f.treasury, 3n);
  });

  it('a token whose balanceOf eats all the gas it is given costs at most the cap and blocks nothing else', async function () {
    const f = await fixture();
    const { token } = await flaky(f);
    await token.setGuzzle(true);
    const pulp = await f.pulp.getAddress();
    await f.pulp.connect(f.bob).transfer(await f.vault.getAddress(), 9n);
    const tx = await f.vault.recoverExcess(pulp, { gasLimit: 10_000_000 });
    const r = await tx.wait();
    await expect(tx).to.changeTokenBalance(f.pulp, f.treasury, 9n);
    // Two capped reads of 100k for the guzzler; uncapped, each would take 63/64 of all the gas left.
    expect(r.gasUsed).to.be.lessThan(400_000n);
    console.log(`      gas: recoverExcess(pulp) with a gas-eating reward token=${r.gasUsed}`);
    // The guzzler's own entitlement is untouched.
    await token.setGuzzle(false);
    await mineAt(f.launch + 9n * DAY);
    await expect(f.vault.connect(f.alice).claim(await token.getAddress(), 64)).to.changeTokenBalance(token, f.alice, 7n * WAD);
  });
});
