const { expect } = require('chai');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const { ethers, DAY, WAD, PULP, mineAt, txAt, fixture, area, passTreasuryDelay } = require('./helpers');

// The vault always holds at least what it owes (balance >= reserved). These tests send no strays and release
// nothing (or sweep a stray before checking), so here the two are equal: principal plus unpaid PULP rewards.
async function expectPulpReserved(f) {
  const vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress();
  const balance = await f.pulp.balanceOf(vault);
  expect(await f.vault.reserved(pulp), 'reserved(pulp) == balance (no strays, nothing released)').to.equal(balance);
  expect(balance).to.equal(
    (await f.vault.totalLocked()) + (await f.vault.totalNotified(pulp)) - (await f.vault.totalPaid(pulp)));
}

// PULP registered as a reward token; Alice (and any extra `lockers`) locked at launch; 7 PULP funded
// for the seven days after launch day.
async function pulpRewardFixture(options = {}, lockers = []) {
  const f = await fixture(options);
  f.pulpAddr = await f.pulp.getAddress();
  await f.vault.addRewardToken(f.pulpAddr);
  for (const [name, amount, days] of [['alice', PULP, 30], ...lockers]) {
    await txAt(f.launch, () => f.vault.connect(f[name]).lock(amount, days));
  }
  await f.vault.connect(f.distributor).notifyRewardAmount(f.pulpAddr, 7n * PULP);
  return f;
}

describe('PulpVeVault: lockFor / increaseAmountFor', function () {
  it('locks for a beneficiary with the payer\'s PULP; only the beneficiary owns and withdraws it', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress();
    const t = f.launch + 77n;
    const carolBefore = await f.pulp.balanceOf(f.carol.address);
    const aliceBefore = await f.pulp.balanceOf(f.alice.address);
    const tx = await txAt(t, () => f.vault.connect(f.carol).lockFor(f.alice.address, 3n * PULP, 20));
    const boosted = 3n * PULP * await f.vault.entryMultiplier(t);
    const power = boosted * 20n / 30n / WAD;
    await expect(tx).to.emit(f.vault, 'Locked').withArgs(f.alice.address, 3n * PULP, 20, t + 20n * DAY, power);
    await expect(tx).to.emit(f.vault, 'DepositedFor').withArgs(f.carol.address, f.alice.address, 3n * PULP);

    expect(await f.pulp.balanceOf(f.carol.address)).to.equal(carolBefore - 3n * PULP);
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(aliceBefore);
    expect(await f.pulp.balanceOf(vault)).to.equal(3n * PULP);
    const l = await f.vault.locks(f.alice.address);
    expect([l.amount, l.boosted, l.end]).to.deep.equal([3n * PULP, boosted, t + 20n * DAY]);
    expect((await f.vault.locks(f.carol.address)).amount).to.equal(0);
    expect(await f.vault.totalLocked()).to.equal(3n * PULP);
    expect(await f.vault.userEpochCount(f.alice.address)).to.equal(21);
    expect(await f.vault.userEpochCount(f.carol.address)).to.equal(0);
    expect(await f.vault.userEpochArea(f.alice.address, t / DAY)).to.equal(area(boosted, t + 20n * DAY, t, (t / DAY + 1n) * DAY));

    // The payer can still open its own lock, and has no claim on the beneficiary's.
    await f.vault.connect(f.carol).lock(PULP, 10);
    await mineAt(t + 20n * DAY);
    await f.vault.connect(f.carol).withdraw();
    expect(await f.pulp.balanceOf(f.carol.address)).to.equal(carolBefore - 3n * PULP);
    await f.vault.connect(f.alice).withdraw();
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(aliceBefore + 3n * PULP);
    expect(await f.vault.totalLocked()).to.equal(0);
  });

  it('lockFor(self) and lock leave identical positions and areas', async function () {
    const f = await fixture();
    const t = f.launch + DAY / 3n;
    await txAt(t, () => f.vault.connect(f.alice).lock(5n * PULP, 30));
    await txAt(t, () => f.vault.connect(f.bob).lockFor(f.bob.address, 5n * PULP, 30));
    const a = await f.vault.locks(f.alice.address), b = await f.vault.locks(f.bob.address);
    expect([b.amount, b.boosted, b.end]).to.deep.equal([a.amount, a.boosted, a.end]);
    for (let e = t / DAY; e <= t / DAY + 30n; e++) {
      expect(await f.vault.userEpochArea(f.bob.address, e)).to.equal(await f.vault.userEpochArea(f.alice.address, e));
    }
  });

  it('rejects every invalid lockFor and changes nothing', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress();
    const lockFor = (...args) => f.vault.connect(f.carol).lockFor(...args);
    await expect(lockFor(f.alice.address, PULP, 30)).to.be.revertedWithCustomError(f.vault, 'NotLaunched');
    await mineAt(f.launch);
    await expect(lockFor(ethers.ZeroAddress, PULP, 30)).to.be.revertedWithCustomError(f.vault, 'ZeroAddress');
    await expect(lockFor(vault, PULP, 30)).to.be.revertedWithCustomError(f.vault, 'InvalidBeneficiary');
    for (const days of [0, 7, 11, 31]) {
      await expect(lockFor(f.alice.address, PULP, days)).to.be.revertedWithCustomError(f.vault, 'BadDuration');
    }
    for (const amount of [0n, PULP - 1n]) {
      await expect(lockFor(f.alice.address, amount, 10)).to.be.revertedWithCustomError(f.vault, 'AmountTooSmall');
    }
    await f.vault.setLocksPaused(true);
    await expect(lockFor(f.alice.address, PULP, 10)).to.be.revertedWithCustomError(f.vault, 'LocksArePaused');
    await f.vault.setLocksPaused(false);
    // PULP comes from the payer only: the beneficiary's own allowance is never used.
    await f.pulp.connect(f.stranger).approve(vault, 0);
    await expect(f.vault.connect(f.stranger).lockFor(f.alice.address, PULP, 10))
      .to.be.revertedWithCustomError(f.pulp, 'ERC20InsufficientAllowance');
    expect(await f.vault.totalLocked()).to.equal(0);
    expect(await f.vault.userEpochCount(f.alice.address)).to.equal(0);

    await f.vault.connect(f.alice).lock(PULP, 10);
    await expect(lockFor(f.alice.address, PULP, 30)).to.be.revertedWithCustomError(f.vault, 'LockExists');
    await mineAt(f.launch + 11n * DAY);                  // expired but not withdrawn: still exists
    await expect(lockFor(f.alice.address, PULP, 30)).to.be.revertedWithCustomError(f.vault, 'LockExists');

    const cap = await f.vault.MAX_TOTAL_LOCKED();
    await f.pulp.mint(f.carol.address, cap);
    await expect(lockFor(f.bob.address, cap, 30)).to.be.revertedWithCustomError(f.vault, 'LockCapExceeded');
    await lockFor(f.bob.address, cap - PULP, 30);        // exactly fills the cap
    expect(await f.vault.totalLocked()).to.equal(cap);
  });

  it('rejects a fee-on-transfer or false-returning payer transfer for lockFor/increaseAmountFor', async function () {
    const fee = await fixture({ tokenKind: 'MockFeeToken' });
    await txAt(fee.launch, () => fee.vault.connect(fee.alice).lock(PULP, 30));
    await fee.pulp.setFeeBps(100);
    await expect(fee.vault.connect(fee.carol).lockFor(fee.bob.address, PULP, 30)).to.be.revertedWithCustomError(fee.vault, 'UnsupportedTransfer');
    await expect(fee.vault.connect(fee.carol).increaseAmountFor(fee.alice.address, PULP)).to.be.revertedWithCustomError(fee.vault, 'UnsupportedTransfer');
    expect(await fee.vault.totalLocked()).to.equal(PULP);
    expect((await fee.vault.locks(fee.bob.address)).amount).to.equal(0);

    const fr = await fixture({ tokenKind: 'MockFalseReturnToken' });
    await txAt(fr.launch, () => fr.vault.connect(fr.alice).lock(PULP, 30));
    await fr.pulp.setReturnFalse(true);
    await expect(fr.vault.connect(fr.carol).lockFor(fr.bob.address, PULP, 30)).to.be.revertedWithCustomError(fr.vault, 'SafeERC20FailedOperation');
    await expect(fr.vault.connect(fr.carol).increaseAmountFor(fr.alice.address, PULP)).to.be.revertedWithCustomError(fr.vault, 'SafeERC20FailedOperation');
    expect(await fr.vault.totalLocked()).to.equal(PULP);
  });

  it('increaseAmountFor adds the payer\'s PULP at today\'s multiplier and keeps the beneficiary\'s expiry', async function () {
    const f = await fixture({ earlyWindow: 10n * DAY });
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    const t = f.launch + 2n * DAY + 5n;
    const m = await f.vault.entryMultiplier(t);
    expect(m).to.be.greaterThan(WAD);
    const bobBefore = await f.pulp.balanceOf(f.bob.address), aliceBefore = await f.pulp.balanceOf(f.alice.address);
    const areaBefore = await f.vault.userEpochArea(f.alice.address, t / DAY);
    const tx = await txAt(t, () => f.vault.connect(f.bob).increaseAmountFor(f.alice.address, 4n * PULP));
    const end = f.launch + 30n * DAY;
    const boosted = PULP * 2n * WAD + 4n * PULP * m;
    await expect(tx).to.emit(f.vault, 'Increased').withArgs(f.alice.address, 4n * PULP, m, boosted * (end - t) / (30n * DAY * WAD));
    await expect(tx).to.emit(f.vault, 'DepositedFor').withArgs(f.bob.address, f.alice.address, 4n * PULP);
    const l = await f.vault.locks(f.alice.address);
    expect([l.amount, l.boosted, l.end]).to.deep.equal([5n * PULP, boosted, end]);
    expect(await f.pulp.balanceOf(f.bob.address)).to.equal(bobBefore - 4n * PULP);
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(aliceBefore);
    expect(await f.vault.userEpochArea(f.alice.address, t / DAY))
      .to.equal(areaBefore + area(4n * PULP * m, end, t, (t / DAY + 1n) * DAY));
    expect((await f.vault.locks(f.bob.address)).amount).to.equal(0);
    expect(await f.vault.totalLocked()).to.equal(5n * PULP);
  });

  it('increaseAmountFor and increaseAmount share one accounting path', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 20));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 20));
    const t = f.launch + DAY / 2n;
    await txAt(t, () => f.vault.connect(f.alice).increaseAmount(2n * PULP));
    await txAt(t, () => f.vault.connect(f.carol).increaseAmountFor(f.bob.address, 2n * PULP));
    const a = await f.vault.locks(f.alice.address), b = await f.vault.locks(f.bob.address);
    expect([b.amount, b.boosted, b.end]).to.deep.equal([a.amount, a.boosted, a.end]);
    for (let e = f.launch / DAY; e <= f.launch / DAY + 20n; e++) {
      expect(await f.vault.userEpochArea(f.bob.address, e)).to.equal(await f.vault.userEpochArea(f.alice.address, e));
    }
  });

  it('rejects every invalid increaseAmountFor and changes nothing', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress();
    const inc = (...args) => f.vault.connect(f.carol).increaseAmountFor(...args);
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 20));
    await expect(inc(ethers.ZeroAddress, PULP)).to.be.revertedWithCustomError(f.vault, 'ZeroAddress');
    await expect(inc(vault, PULP)).to.be.revertedWithCustomError(f.vault, 'InvalidBeneficiary');
    await expect(inc(f.bob.address, PULP)).to.be.revertedWithCustomError(f.vault, 'NoLock');
    await expect(inc(f.alice.address, 0)).to.be.revertedWithCustomError(f.vault, 'AmountTooSmall');
    await f.vault.setLocksPaused(true);
    await expect(inc(f.alice.address, PULP)).to.be.revertedWithCustomError(f.vault, 'LocksArePaused');
    await f.vault.setLocksPaused(false);
    const cap = await f.vault.MAX_TOTAL_LOCKED();
    await f.pulp.mint(f.carol.address, cap);
    await expect(inc(f.alice.address, cap)).to.be.revertedWithCustomError(f.vault, 'LockCapExceeded');
    await txAt(f.launch + 10n * DAY, () => inc(f.alice.address, 1n));     // exactly 10 days left: allowed
    await mineAt(f.launch + 10n * DAY + 1n);
    await expect(inc(f.alice.address, PULP)).to.be.revertedWithCustomError(f.vault, 'ExtendFirst');
    await mineAt(f.launch + 20n * DAY);
    await expect(inc(f.alice.address, PULP)).to.be.revertedWithCustomError(f.vault, 'LockExpired');
    expect((await f.vault.locks(f.alice.address)).amount).to.equal(PULP + 1n);
    expect(await f.vault.totalLocked()).to.equal(PULP + 1n);
    // Only the owner can move the unlock time; a third party can top up again after that.
    await f.vault.connect(f.alice).extend(30);
    await inc(f.alice.address, PULP);
  });

  it('griefing: an unsolicited lockFor blocks plain lock, but the victim keeps the gift and can still deposit', async function () {
    const f = await fixture();
    // The griefer must give away at least minLockAmount, for the longest duration, to the victim.
    await txAt(f.launch, () => f.vault.connect(f.stranger).lockFor(f.alice.address, PULP, 30));
    await expect(f.vault.connect(f.alice).lock(10n * PULP, 10)).to.be.revertedWithCustomError(f.vault, 'LockExists');
    // The UI path: top up the existing lock (30 days left), at today's multiplier.
    await f.vault.connect(f.alice).increaseAmount(10n * PULP);
    expect((await f.vault.locks(f.alice.address)).amount).to.equal(11n * PULP);
    const before = await f.pulp.balanceOf(f.alice.address);
    await mineAt(f.launch + 30n * DAY);
    await f.vault.connect(f.alice).withdraw();
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(before + 11n * PULP);
  });
});

describe('PulpVeVault: compound', function () {
  it('re-locks claimable PULP rewards without moving tokens; reserved(pulp) and the balance stay unchanged', async function () {
    const f = await pulpRewardFixture({}, [['bob', PULP, 30]]);
    const vault = await f.vault.getAddress();
    await mineAt(f.launch + 8n * DAY);
    await expectPulpReserved(f);
    const quote = await f.vault.claimable(f.alice.address, f.pulpAddr, 64);
    expect(quote.amount).to.be.greaterThan(0);
    expect(await f.vault.connect(f.alice).compound.staticCall(64, 200)).to.equal(quote.amount);

    const balanceBefore = await f.pulp.balanceOf(vault), walletBefore = await f.pulp.balanceOf(f.alice.address);
    const lockedBefore = await f.vault.totalLocked(), paidBefore = await f.vault.totalPaid(f.pulpAddr);
    const reservedBefore = await f.vault.reserved(f.pulpAddr);
    const t = f.launch + 8n * DAY + 100n, end = f.launch + 30n * DAY;
    const areaBefore = await f.vault.userEpochArea(f.alice.address, t / DAY);
    const totalAreaBefore = await f.vault.totalEpochArea(t / DAY);
    const tx = await txAt(t, () => f.vault.connect(f.alice).compound(64, 200));
    await expect(tx).to.emit(f.vault, 'Compounded').withArgs(f.alice.address, quote.amount, 0, quote.nextCursor);
    await expect(tx).to.emit(f.vault, 'RewardPaid').withArgs(f.alice.address, f.pulpAddr, quote.amount, quote.nextCursor);
    await expect(tx).to.emit(f.vault, 'Increased').withArgs(f.alice.address, quote.amount, WAD, anyValue);
    await expect(tx).to.not.emit(f.pulp, 'Transfer');

    const l = await f.vault.locks(f.alice.address);
    expect([l.amount, l.boosted, l.end]).to.deep.equal([PULP + quote.amount, PULP * 2n * WAD + quote.amount * WAD, end]);
    expect(await f.vault.totalLocked()).to.equal(lockedBefore + quote.amount);
    expect(await f.vault.totalPaid(f.pulpAddr)).to.equal(paidBefore + quote.amount);
    expect(await f.pulp.balanceOf(vault)).to.equal(balanceBefore);
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(walletBefore);
    expect(await f.vault.reserved(f.pulpAddr)).to.equal(reservedBefore);
    expect(await f.vault.claimCursor(f.alice.address, f.pulpAddr)).to.equal(quote.nextCursor);
    expect((await f.vault.claimable(f.alice.address, f.pulpAddr, 64)).amount).to.equal(0);
    const added = area(quote.amount * WAD, end, t, (t / DAY + 1n) * DAY);
    expect(await f.vault.userEpochArea(f.alice.address, t / DAY)).to.equal(areaBefore + added);
    expect(await f.vault.totalEpochArea(t / DAY)).to.equal(totalAreaBefore + added);
    expect(await f.vault.userEpochCount(f.alice.address)).to.equal(30);   // same expiry: no new days
    await expectPulpReserved(f);

    // Bob claims the same entitlement as tokens; the compounded PULP comes back as principal.
    await f.vault.connect(f.bob).claim(f.pulpAddr, 64);
    await expectPulpReserved(f);
    await mineAt(end);
    await f.vault.connect(f.alice).withdraw();
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(walletBefore + PULP + quote.amount);
    await expectPulpReserved(f);
  });

  it('uses today\'s entry multiplier for the compounded PULP, not the lock\'s saved bonus', async function () {
    const f = await pulpRewardFixture({ earlyWindow: 30n * DAY });
    const t = f.launch + 3n * DAY + 100n;
    const m = await f.vault.entryMultiplier(t);
    expect(m).to.be.greaterThan(WAD).and.lessThan(2n * WAD);
    await mineAt(t - 1n);
    const quote = await f.vault.claimable(f.alice.address, f.pulpAddr, 64);
    const tx = await txAt(t, () => f.vault.connect(f.alice).compound(64, 200));
    await expect(tx).to.emit(f.vault, 'Increased').withArgs(f.alice.address, quote.amount, m, anyValue);
    expect((await f.vault.locks(f.alice.address)).boosted).to.equal(PULP * 2n * WAD + quote.amount * m);
    await expectPulpReserved(f);
  });

  it('pages: an empty page reverts, claim() pages past it, and the pages sum to the plain claim', async function () {
    const f = await pulpRewardFixture({}, [['bob', PULP, 30]]);          // Bob: same position, claims as tokens
    await mineAt(f.launch + 8n * DAY);
    // Launch day (Alice's first recorded day) has no budget: the first one-day page is empty.
    await expect(f.vault.connect(f.alice).compound(1, 200)).to.be.revertedWithCustomError(f.vault, 'NothingToCompound');
    expect(await f.vault.claimCursor(f.alice.address, f.pulpAddr)).to.equal(0);
    await f.vault.connect(f.alice).claim(f.pulpAddr, 1);                    // pays zero, moves the cursor
    expect(await f.vault.claimCursor(f.alice.address, f.pulpAddr)).to.equal(1);

    let compounded = 0n;
    for (let i = 2n; i <= 8n; i++) {
      const quote = await f.vault.claimable(f.alice.address, f.pulpAddr, 1);
      await expect(f.vault.connect(f.alice).compound(1, 200))
        .to.emit(f.vault, 'Compounded').withArgs(f.alice.address, quote.amount, 0, i);
      compounded += quote.amount;
      await expectPulpReserved(f);
    }
    // Today (day 8) is still open: nothing more to compound.
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'NothingToCompound');
    await f.vault.connect(f.bob).claim(f.pulpAddr, 64);
    expect(compounded).to.equal(await f.pulp.balanceOf(f.bob.address) - (10n ** 30n - PULP));
    expect((await f.vault.locks(f.alice.address)).amount).to.equal(PULP + compounded);
    await expectPulpReserved(f);
  });

  it('rejects compound without PULP rewards, with a bad page size, without a lock, or while paused', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await f.vault.addRewardToken(await f.pulp.getAddress());
    for (const n of [0, 65]) {
      await expect(f.vault.connect(f.alice).compound(n, 200)).to.be.revertedWithCustomError(f.vault, 'BadClaimLimit');
    }
    await expect(f.vault.connect(f.bob).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'NoLock');
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'NothingToCompound');
    await f.vault.connect(f.distributor).notifyRewardAmount(await f.pulp.getAddress(), 7n * PULP);
    await mineAt(f.launch + 3n * DAY);
    await f.vault.setLocksPaused(true);
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'LocksArePaused');
    // Pause only blocks principal: the same rewards can still be claimed as tokens.
    await f.vault.connect(f.alice).claim(await f.pulp.getAddress(), 64);
    expect(await f.vault.totalPaid(await f.pulp.getAddress())).to.be.greaterThan(0);
    await expectPulpReserved(f);
  });

  it('requires 10+ days left like a top-up: ExtendFirst, LockExpired, then works after extend', async function () {
    const f = await pulpRewardFixture();
    await mineAt(f.launch + 20n * DAY + 1n);                                // 10 days minus 1s left
    const cursor = await f.vault.claimCursor(f.alice.address, f.pulpAddr);
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'ExtendFirst');
    expect(await f.vault.claimCursor(f.alice.address, f.pulpAddr)).to.equal(cursor);
    expect(await f.vault.totalPaid(f.pulpAddr)).to.equal(0);
    await mineAt(f.launch + 30n * DAY);
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'LockExpired');
    // A restart at expiry reprices and reopens the window; nothing earned was lost.
    const quote = await f.vault.claimable(f.alice.address, f.pulpAddr, 64);
    await f.vault.connect(f.alice).extend(20);
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.emit(f.vault, 'Compounded');
    expect((await f.vault.locks(f.alice.address)).amount).to.be.greaterThanOrEqual(PULP + quote.amount);
    await expectPulpReserved(f);
    // After withdrawal there is no lock to compound into, but rewards stay claimable.
    await mineAt(f.launch + 51n * DAY);
    await f.vault.connect(f.alice).withdraw();
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'NoLock');
    await f.vault.connect(f.alice).claim(f.pulpAddr, 64);
    await expectPulpReserved(f);
  });

  it('respects the principal cap', async function () {
    const f = await pulpRewardFixture();
    const cap = await f.vault.MAX_TOTAL_LOCKED();
    await f.pulp.mint(f.bob.address, cap);
    // Filled after the rewarded days closed, so Alice's closed-day share is untouched.
    await txAt(f.launch + 8n * DAY, () => f.vault.connect(f.bob).lock(cap - PULP, 30));
    expect((await f.vault.claimable(f.alice.address, f.pulpAddr, 64)).amount).to.be.greaterThan(0);
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'LockCapExceeded');
    expect(await f.vault.claimCursor(f.alice.address, f.pulpAddr)).to.equal(0);
    await f.vault.connect(f.alice).claim(f.pulpAddr, 64);                   // the tokens are still claimable
    await expectPulpReserved(f);
  });

  it('keeps rounding dust reserved and recoverExcess limited to genuine strays', async function () {
    const f = await pulpRewardFixture({}, [['bob', 2n * PULP, 30], ['carol', PULP, 20]]);
    const vault = await f.vault.getAddress();
    await f.vault.connect(f.distributor).notifyRewardAmount(f.pulpAddr, 7000001n);
    await mineAt(f.launch + 9n * DAY);
    for (const u of [f.alice, f.bob, f.carol]) {
      await f.vault.connect(u).compound(3, 200);
      await expectPulpReserved(f);
    }
    await f.pulp.connect(f.stranger).transfer(vault, 5n);                   // the mistake
    await f.vault.recoverExcess(f.pulpAddr);
    await expectPulpReserved(f);
    await expect(f.vault.recoverExcess(f.pulpAddr)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    for (const u of [f.alice, f.bob, f.carol]) {
      while (!(await f.vault.claimable(u.address, f.pulpAddr, 64)).caughtUp) await f.vault.connect(u).claim(f.pulpAddr, 64);
      await f.vault.connect(u).claim(f.pulpAddr, 64);
    }
    await mineAt(f.launch + 30n * DAY);
    for (const u of [f.alice, f.bob, f.carol]) await f.vault.connect(u).withdraw();
    expect(await f.vault.totalLocked()).to.equal(0);
    const dust = await f.pulp.balanceOf(vault);
    expect(dust).to.equal(await f.vault.reserved(f.pulpAddr));
    expect(dust).to.be.lessThan(30n);
  });
});

describe('PulpVeVault: compound fee', function () {
  const BPS = 10_000n;
  const fresh = () => ethers.Wallet.createRandom().address;   // a recipient holding no PULP

  it('takes floor(page * bps / 10000) to the recipient, locks the rest; reserved(pulp) and the balance both drop by the fee', async function () {
    const treasury = fresh();
    const f = await pulpRewardFixture({ compoundFeeBps: 200, treasury: treasury }, [['bob', PULP, 30]]);
    const vault = await f.vault.getAddress();
    await f.vault.connect(f.distributor).notifyRewardAmount(f.pulpAddr, 7_000_003n);  // odd units, so the fee rounds
    expect(await f.vault.MAX_COMPOUND_FEE_BPS()).to.equal(200);
    expect([await f.vault.compoundFeeBps(), await f.vault.treasury()]).to.deep.equal([200n, treasury]);
    await mineAt(f.launch + 8n * DAY);
    const quote = await f.vault.claimable(f.alice.address, f.pulpAddr, 64);
    const fee = quote.amount * 200n / BPS, net = quote.amount - fee;
    expect(quote.amount * 200n % BPS, 'this page actually rounds').to.not.equal(0n);
    expect(await f.vault.connect(f.alice).compound.staticCall(64, 200)).to.equal(net);

    const balanceBefore = await f.pulp.balanceOf(vault), walletBefore = await f.pulp.balanceOf(f.alice.address);
    const lockedBefore = await f.vault.totalLocked(), paidBefore = await f.vault.totalPaid(f.pulpAddr);
    const t = f.launch + 8n * DAY + 100n, end = f.launch + 30n * DAY;
    const areaBefore = await f.vault.userEpochArea(f.alice.address, t / DAY);
    const tx = await txAt(t, () => f.vault.connect(f.alice).compound(64, 200));
    await expect(tx).to.emit(f.vault, 'Compounded').withArgs(f.alice.address, net, fee, quote.nextCursor);
    await expect(tx).to.emit(f.vault, 'RewardPaid').withArgs(f.alice.address, f.pulpAddr, quote.amount, quote.nextCursor);
    await expect(tx).to.emit(f.vault, 'Increased').withArgs(f.alice.address, net, WAD, anyValue);
    await expect(tx).to.emit(f.pulp, 'Transfer').withArgs(vault, treasury, fee);

    expect(await f.pulp.balanceOf(treasury)).to.equal(fee);
    expect(await f.pulp.balanceOf(vault)).to.equal(balanceBefore - fee);
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(walletBefore);
    expect(await f.vault.totalPaid(f.pulpAddr)).to.equal(paidBefore + quote.amount);   // the whole page
    expect(await f.vault.totalLocked()).to.equal(lockedBefore + net);                   // minus the fee
    const l = await f.vault.locks(f.alice.address);
    expect([l.amount, l.boosted, l.end]).to.deep.equal([PULP + net, PULP * 2n * WAD + net * WAD, end]);
    expect(await f.vault.userEpochArea(f.alice.address, t / DAY))
      .to.equal(areaBefore + area(net * WAD, end, t, (t / DAY + 1n) * DAY));
    await expectPulpReserved(f);

    // Plain claim stays fee-free: Bob (same position) gets the whole page as tokens.
    const bobBefore = await f.pulp.balanceOf(f.bob.address);
    const bobQuote = await f.vault.claimable(f.bob.address, f.pulpAddr, 64);
    const claimTx = await f.vault.connect(f.bob).claim(f.pulpAddr, 64);
    await expect(claimTx).to.emit(f.pulp, 'Transfer').withArgs(vault, f.bob.address, bobQuote.amount);
    expect(await f.pulp.balanceOf(f.bob.address)).to.equal(bobBefore + bobQuote.amount);
    expect(bobQuote.amount).to.equal(quote.amount);
    expect(await f.pulp.balanceOf(treasury)).to.equal(fee);
    await expectPulpReserved(f);

    // Withdrawal returns the net principal; the fee never comes back to Alice.
    await mineAt(end);
    await f.vault.connect(f.alice).withdraw();
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(walletBefore + PULP + net);
    await expectPulpReserved(f);
  });

  it('rounds the fee down page by page, to zero on small pages, and a zero rate makes no transfer', async function () {
    const treasury = fresh();
    const f = await pulpRewardFixture({ compoundFeeBps: 1, treasury: treasury });
    await f.vault.connect(f.distributor).notifyRewardAmount(f.pulpAddr, 7000n);   // Alice alone: +1000 units a day
    await mineAt(f.launch + 8n * DAY);
    // Days: launch (empty), then 1,000 PULP + 1000 units each. 1 bps of two days ends in .2 of a unit: rounded down.
    const page = 2n * PULP + 2000n;
    expect((await f.vault.claimable(f.alice.address, f.pulpAddr, 3)).amount).to.equal(page);
    await expect(f.vault.connect(f.alice).compound(3, 200))
      .to.emit(f.vault, 'Compounded').withArgs(f.alice.address, page - page / BPS, page / BPS, 3);
    expect(page * 1n % BPS).to.not.equal(0n);
    expect(await f.pulp.balanceOf(treasury)).to.equal(page / BPS);
    await expectPulpReserved(f);

    // Rate set to zero: the whole page is locked and nothing is transferred, even with a recipient set.
    await f.vault.setCompoundFee(0);
    await mineAt(f.launch + 9n * DAY);
    const q2 = await f.vault.claimable(f.alice.address, f.pulpAddr, 64);
    const tx2 = await f.vault.connect(f.alice).compound(64, 200);
    await expect(tx2).to.emit(f.vault, 'Compounded').withArgs(f.alice.address, q2.amount, 0, q2.nextCursor);
    await expect(tx2).to.not.emit(f.pulp, 'Transfer');
    await expectPulpReserved(f);
    // A page worth zero still reverts with a fee set.
    await f.vault.setCompoundFee(200);
    await expect(f.vault.connect(f.alice).compound(64, 200)).to.be.revertedWithCustomError(f.vault, 'NothingToCompound');

    // A page under 10000 units at 1 bps: fee 0, everything locked, no transfer at all.
    const tiny = await pulpRewardFixture({ compoundFeeBps: 1, treasury: treasury });
    await mineAt(tiny.launch + 8n * DAY);
    await tiny.vault.connect(tiny.alice).claim(tiny.pulpAddr, 64);               // days 0-7, the 7,000 PULP
    await tiny.vault.connect(tiny.distributor).notifyRewardAmount(tiny.pulpAddr, 7000n);  // days 9-15
    await mineAt(tiny.launch + 16n * DAY);
    const q = await tiny.vault.claimable(tiny.alice.address, tiny.pulpAddr, 64);
    expect(q.amount).to.be.greaterThan(0n).and.lessThan(BPS);
    const tx = await tiny.vault.connect(tiny.alice).compound(64, 200);
    await expect(tx).to.emit(tiny.vault, 'Compounded').withArgs(tiny.alice.address, q.amount, 0, q.nextCursor);
    await expect(tx).to.not.emit(tiny.pulp, 'Transfer');
    expect(await tiny.pulp.balanceOf(treasury)).to.equal(0);
    await expectPulpReserved(tiny);

  });

  it('takes a maximum fee from the caller: FeeAboveMax below the current rate, works at or above it', async function () {
    const treasury = fresh();
    const f = await pulpRewardFixture({ compoundFeeBps: 100, treasury: treasury });
    await mineAt(f.launch + 8n * DAY);
    await f.vault.connect(f.alice).claim(f.pulpAddr, 1);                          // the empty launch day
    const cursor = await f.vault.claimCursor(f.alice.address, f.pulpAddr);
    for (const max of [0, 1, 99]) {
      await expect(f.vault.connect(f.alice).compound(1, max)).to.be.revertedWithCustomError(f.vault, 'FeeAboveMax');
    }
    expect(await f.vault.claimCursor(f.alice.address, f.pulpAddr)).to.equal(cursor);   // nothing settled
    let q = await f.vault.claimable(f.alice.address, f.pulpAddr, 1);
    await expect(f.vault.connect(f.alice).compound(1, 100))                        // exactly the current rate
      .to.emit(f.vault, 'Compounded').withArgs(f.alice.address, q.amount - q.amount / 100n, q.amount / 100n, 2);
    // The owner raises the fee between a user's quote and their transaction: the user's bound holds.
    await f.vault.setCompoundFee(200);
    await expect(f.vault.connect(f.alice).compound(1, 100)).to.be.revertedWithCustomError(f.vault, 'FeeAboveMax');
    await expect(f.vault.connect(f.alice).compound(64, 199)).to.be.revertedWithCustomError(f.vault, 'FeeAboveMax');
    q = await f.vault.claimable(f.alice.address, f.pulpAddr, 1);
    await expect(f.vault.connect(f.alice).compound(1, 65535))                      // any bound at or above works
      .to.emit(f.vault, 'Compounded').withArgs(f.alice.address, q.amount - q.amount / 50n, q.amount / 50n, 3);
    // Lowering the fee never trips the bound; zero with a zero bound works.
    await f.vault.setCompoundFee(0);
    q = await f.vault.claimable(f.alice.address, f.pulpAddr, 1);
    await expect(f.vault.connect(f.alice).compound(1, 0)).to.emit(f.vault, 'Compounded').withArgs(f.alice.address, q.amount, 0, 4);
    expect(await f.vault.MAX_COMPOUND_FEE_BPS()).to.equal(200);
    await expect(f.vault.setCompoundFee(201)).to.be.revertedWithCustomError(f.vault, 'FeeTooHigh');
    // The bound check comes after the pause and the page size, before any settlement.
    await expect(f.vault.connect(f.alice).compound(0, 0)).to.be.revertedWithCustomError(f.vault, 'BadClaimLimit');
    await f.vault.setCompoundFee(100);
    await f.vault.setLocksPaused(true);
    await expect(f.vault.connect(f.alice).compound(1, 0)).to.be.revertedWithCustomError(f.vault, 'LocksArePaused');
    await expectPulpReserved(f);
    // The selector frontends call.
    expect(f.vault.interface.getFunction('compound').selector).to.equal(ethers.id('compound(uint256,uint16)').slice(0, 10));
  });

  it('caps the fee at 2% and lets only the owner set it; the fee always goes to the treasury', async function () {
    const f = await fixture();
    expect([await f.vault.compoundFeeBps(), await f.vault.treasury()]).to.deep.equal([0n, f.treasury.address]);
    await expect(f.vault.connect(f.stranger).setCompoundFee(100))
      .to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount').withArgs(f.stranger.address);
    await expect(f.vault.connect(f.distributor).setCompoundFee(100)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.setCompoundFee(201)).to.be.revertedWithCustomError(f.vault, 'FeeTooHigh');
    await expect(f.vault.setCompoundFee(65535)).to.be.revertedWithCustomError(f.vault, 'FeeTooHigh');
    await expect(f.vault.setCompoundFee(200)).to.emit(f.vault, 'CompoundFeeSet').withArgs(200);
    expect(await f.vault.compoundFeeBps()).to.equal(200);
    await expect(f.vault.setCompoundFee(0)).to.emit(f.vault, 'CompoundFeeSet').withArgs(0);
    // There is no separate fee recipient any more.
    expect(f.vault.interface.getFunction('feeRecipient', [])).to.equal(null);
    expect(f.vault.interface.getFunction('setFeeRecipient', [])).to.equal(null);
    // After an ownership handover the old owner loses the setter.
    await f.vault.transferOwnership(f.alice.address);
    await f.vault.connect(f.alice).acceptOwnership();
    await expect(f.vault.setCompoundFee(1)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await f.vault.connect(f.alice).setCompoundFee(50);
  });

  it('validates the fee, the treasury and a 00:00 UTC launch in the constructor', async function () {
    const f = await fixture();
    const factory = await ethers.getContractFactory('PulpVeVault');
    const config = { ...f.config, launchStart: f.launch + DAY };
    await expect(factory.deploy({ ...config, compoundFeeBps: 201 })).to.be.revertedWithCustomError(f.vault, 'FeeTooHigh');
    await expect(factory.deploy({ ...config, treasury: ethers.ZeroAddress })).to.be.revertedWithCustomError(f.vault, 'ZeroAddress');
    const next = ethers.getCreateAddress({ from: f.owner.address, nonce: await f.owner.getNonce() });
    for (const bad of [next, config.pulp, config.weth]) {
      await expect(factory.deploy({ ...config, treasury: bad })).to.be.revertedWithCustomError(f.vault, 'InvalidTreasury');
    }
    for (const offset of [1n, DAY / 2n, DAY - 1n]) {
      await expect(factory.deploy({ ...config, launchStart: config.launchStart + offset })).to.be.revertedWithCustomError(f.vault, 'BadConfig');
    }
    const capped = await factory.deploy({ ...config, compoundFeeBps: 200, treasury: f.carol.address });
    await expect(capped.deploymentTransaction()).to.emit(capped, 'CompoundFeeSet').withArgs(200);
    await expect(capped.deploymentTransaction()).to.emit(capped, 'TreasuryChanged').withArgs(ethers.ZeroAddress, f.carol.address);
    expect([await capped.compoundFeeBps(), await capped.treasury(), await capped.pendingTreasury()])
      .to.deep.equal([200n, f.carol.address, ethers.ZeroAddress]);
    expect(await capped.launchStart() % DAY).to.equal(0n);
  });

  it('treats the recipient as untrusted: transfer last, no reentry, and a refusing recipient loses nothing', async function () {
    const f = await pulpRewardFixture({ tokenKind: 'MockReentrantToken', compoundFeeBps: 100, treasury: fresh() });
    const vault = await f.vault.getAddress();
    await mineAt(f.launch + 8n * DAY);
    await f.vault.connect(f.alice).claim(f.pulpAddr, 1);                          // the empty launch day
    // The fee transfer is the only PULP move in compound: its callback tries to re-enter, one page each.
    const calls = [['compound', [1, 200]], ['claim', [f.pulpAddr, 64]], ['withdraw', []], ['increaseAmount', [PULP]]];
    for (const [name, args] of calls) {
      await f.pulp.configureCallback(vault, f.vault.interface.encodeFunctionData(name, args), true);
      await expect(f.vault.connect(f.alice).compound(1, 200)).to.emit(f.vault, 'Compounded');
      await expectPulpReserved(f);
    }
    expect(await f.pulp.attemptedCallbacks()).to.equal(calls.length);
    expect(await f.pulp.succeededCallbacks()).to.equal(0);

    // A recipient the token refuses: the whole compound reverts, cursor and books untouched,
    // and the same rewards are still claimable fee-free.
    const g = await pulpRewardFixture({ tokenKind: 'MockBlockingERC20', compoundFeeBps: 100, treasury: f.carol.address });
    await mineAt(g.launch + 8n * DAY);
    await g.pulp.setBlockedRecipient(g.carol.address, true);
    const quote = await g.vault.claimable(g.alice.address, g.pulpAddr, 64);
    await expect(g.vault.connect(g.alice).compound(64, 200)).to.be.revertedWith('MockBlockingERC20: blocked recipient');
    expect(await g.vault.claimCursor(g.alice.address, g.pulpAddr)).to.equal(0);
    expect(await g.vault.totalPaid(g.pulpAddr)).to.equal(0);
    expect((await g.vault.locks(g.alice.address)).amount).to.equal(PULP);
    const before = await g.pulp.balanceOf(g.alice.address);
    await g.vault.connect(g.alice).claim(g.pulpAddr, 64);
    expect(await g.pulp.balanceOf(g.alice.address)).to.equal(before + quote.amount);
    await expectPulpReserved(g);
    // The owner can move the treasury (two-step) and compounding works again.
    await g.vault.proposeTreasury(g.bob.address);
    await passTreasuryDelay(g.vault);
    await g.vault.connect(g.bob).acceptTreasury();
    await expect(g.vault.connect(g.bob).compound(64, 200)).to.be.revertedWithCustomError(g.vault, 'NoLock');
    const now = BigInt((await ethers.provider.getBlock('latest')).timestamp);
    await txAt(now + 1n, () => g.vault.connect(g.bob).lock(PULP, 30));
    await g.vault.connect(g.distributor).notifyRewardAmount(g.pulpAddr, 7n * PULP);
    await mineAt(now + 4n * DAY);
    await expect(g.vault.connect(g.bob).compound(64, 200)).to.emit(g.vault, 'Compounded');
  });
});
