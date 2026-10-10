const { expect } = require('chai');
const { ethers, DAY, WAD, PULP, mineAt, txAt, fixture, area } = require('./helpers');

describe('PulpVeVault: exact durations and decaying power', function () {
  for (const days of [10, 20, 30]) {
    it(`locks for exactly ${days} days, including a non-midnight start`, async function () {
      const f = await fixture();
      const t = f.launch + 137n;
      await txAt(t, () => f.vault.connect(f.alice).lock(PULP, days));
      const l = await f.vault.locks(f.alice.address);
      expect(l.end).to.equal(t + BigInt(days) * DAY);
      expect(l.boosted).to.equal(PULP * await f.vault.entryMultiplier(t));
      expect(await f.vault.powerOf(f.alice.address)).to.equal(l.boosted * BigInt(days) / (30n * WAD));
      expect(await f.vault.userEpochCount(f.alice.address)).to.equal(BigInt(days + 1));
    });
  }
  it('rejects unsupported durations, head starts, zero and sub-minimum deposits', async function () {
    const f = await fixture();
    await expect(f.vault.connect(f.alice).lock(PULP, 30)).to.be.revertedWithCustomError(f.vault, 'NotLaunched');
    await mineAt(f.launch);
    for (const days of [0, 1, 7, 11, 21, 29, 31, 52]) {
      await expect(f.vault.connect(f.alice).lock(PULP, days)).to.be.revertedWithCustomError(f.vault, 'BadDuration');
    }
    for (const amount of [0n, PULP - 1n]) {
      await expect(f.vault.connect(f.alice).lock(amount, 10)).to.be.revertedWithCustomError(f.vault, 'AmountTooSmall');
    }
  });
  it('prices minute 1 above minute 5; bonus ends at 1x, never zero', async function () {
    const f = await fixture();
    expect(await f.vault.entryMultiplier(f.launch)).to.equal(2n * WAD);
    expect(await f.vault.entryMultiplier(f.launch + 60n)).to.be.greaterThan(await f.vault.entryMultiplier(f.launch + 300n));
    expect(await f.vault.entryMultiplier(f.launch + DAY / 2n)).to.equal(15n * WAD / 10n);
    expect(await f.vault.entryMultiplier(f.launch + DAY)).to.equal(WAD);
    expect(await f.vault.entryMultiplier(f.launch + 100n * DAY)).to.equal(WAD);
  });
  it('has 1:2:3 duration power and a separate 2x launch multiplier', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 20));
    await txAt(f.launch, () => f.vault.connect(f.carol).lock(PULP, 30));
    expect(await f.vault.powerOf(f.alice.address)).to.equal(PULP * 2n / 3n);
    expect(await f.vault.powerOf(f.bob.address)).to.equal(PULP * 4n / 3n);
    expect(await f.vault.powerOf(f.carol.address)).to.equal(PULP * 2n);
  });
  it('decays continuously; extending from 20 remaining days back to 30 restores power', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await mineAt(f.launch + 10n * DAY);
    expect(await f.vault.powerOf(f.alice.address)).to.equal(PULP * 4n / 3n);
    const before = await f.vault.locks(f.alice.address);
    await txAt(f.launch + 10n * DAY, () => f.vault.connect(f.alice).extend(30));
    const after = await f.vault.locks(f.alice.address);
    expect(after.end).to.equal(f.launch + 40n * DAY);
    expect(after.boosted).to.equal(before.boosted);
    expect(await f.vault.powerOf(f.alice.address)).to.equal(PULP * 2n);
    await expect(f.vault.connect(f.alice).extend(10)).to.be.revertedWithCustomError(f.vault, 'BadDuration');
    await expect(f.vault.connect(f.alice).extend(20)).to.be.revertedWithCustomError(f.vault, 'BadDuration');
  });
  it('cannot stack extensions beyond 30 days from the current timestamp', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await expect(f.vault.connect(f.alice).extend(30)).to.be.revertedWithCustomError(f.vault, 'BadDuration');
    await txAt(f.launch + 1n, () => f.vault.connect(f.alice).extend(30));
    expect((await f.vault.locks(f.alice.address)).end).to.equal(f.launch + 30n * DAY + 1n);
  });
  it('top-ups receive only today\'s multiplier and keep the same expiry', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await txAt(f.launch + 2n * DAY, () => f.vault.connect(f.alice).increaseAmount(PULP * 10n));
    const l = await f.vault.locks(f.alice.address);
    expect(l.amount).to.equal(PULP * 11n);
    expect(l.boosted).to.equal(PULP * WAD * 12n);
    expect(l.end).to.equal(f.launch + 30n * DAY);
    expect(await f.vault.powerOf(f.alice.address)).to.equal(PULP * 12n * 28n / 30n);
    await txAt(f.launch + 2n * DAY, () => f.vault.connect(f.alice).extend(30));
    expect(await f.vault.powerOf(f.alice.address)).to.equal(PULP * 12n);
  });
  it('requires at least 10 days remaining for fresh capital', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 20));
    await txAt(f.launch + 10n * DAY, () => f.vault.connect(f.alice).increaseAmount(1n));
    await mineAt(f.launch + 10n * DAY + 1n);
    await expect(f.vault.connect(f.alice).increaseAmount(PULP)).to.be.revertedWithCustomError(f.vault, 'ExtendFirst');
    await f.vault.connect(f.alice).extend(10);
    await f.vault.connect(f.alice).increaseAmount(PULP);
  });
  it('preserves active bonuses but reprices a restart exactly at expiry', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    await txAt(f.launch + 10n * DAY, () => f.vault.connect(f.alice).extend(30));
    expect((await f.vault.locks(f.alice.address)).boosted).to.equal(PULP * WAD);
    expect(await f.vault.powerOf(f.alice.address)).to.equal(PULP);
  });
  it('withdraws exactly at expiry, preserves historical areas, and allows same-day relock', async function () {
    const f = await fixture();
    const start = f.launch + 123n;
    await txAt(start, () => f.vault.connect(f.alice).lock(PULP, 10));
    const e = start / DAY;
    const oldArea = await f.vault.userEpochArea(f.alice.address, e);
    await mineAt(start + 10n * DAY - 1n);
    await expect(f.vault.connect(f.alice).withdraw()).to.be.revertedWithCustomError(f.vault, 'LockActive');
    const balance = await f.pulp.balanceOf(f.alice.address);
    await txAt(start + 10n * DAY, () => f.vault.connect(f.alice).withdraw());
    expect(await f.vault.powerOf(f.alice.address)).to.equal(0);
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(balance + PULP);
    expect(await f.vault.totalLocked()).to.equal(0);
    expect(await f.vault.userEpochArea(f.alice.address, e)).to.equal(oldArea);
    await f.vault.connect(f.alice).lock(PULP, 10);
    const count = await f.vault.userEpochCount(f.alice.address);
    expect(count).to.equal(21);
    for (let i = 1n; i < count; i++) {
      expect(await f.vault.userEpochAt(f.alice.address, i)).to.be.greaterThan(await f.vault.userEpochAt(f.alice.address, i - 1n));
    }
  });
  it('changes only FUTURE power area on a mid-day extension', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    const closed = await f.vault.totalEpochArea(f.launch / DAY);
    const t = f.launch + 2n * DAY + DAY / 2n;
    await txAt(t, () => f.vault.connect(f.alice).extend(30));
    expect(await f.vault.totalEpochArea(f.launch / DAY)).to.equal(closed);
    const dayStart = f.launch + 2n * DAY;
    const expected = area(PULP * 2n * WAD, f.launch + 10n * DAY, dayStart, t)
      + area(PULP * 2n * WAD, t + 30n * DAY, t, dayStart + DAY);
    expect(await f.vault.userEpochArea(f.alice.address, dayStart / DAY)).to.equal(expected);
    expect(await f.vault.totalEpochArea(dayStart / DAY)).to.equal(expected);
  });
  it('pause blocks only new principal, not extensions or matured withdrawals', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
    await f.vault.setLocksPaused(true);
    await expect(f.vault.connect(f.bob).lock(PULP, 30)).to.be.revertedWithCustomError(f.vault, 'LocksArePaused');
    await expect(f.vault.connect(f.alice).increaseAmount(PULP)).to.be.revertedWithCustomError(f.vault, 'LocksArePaused');
    await txAt(f.launch + DAY, () => f.vault.connect(f.alice).extend(20));
    await txAt(f.launch + 21n * DAY, () => f.vault.connect(f.alice).withdraw());
  });
  it('bounds extreme amounts and validates immutable configuration', async function () {
    const f = await fixture();
    const cap = await f.vault.MAX_TOTAL_LOCKED();
    await f.pulp.mint(f.alice.address, cap);
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(cap, 30));
    expect(await f.vault.powerOf(f.alice.address)).to.equal(cap * 2n);
    await expect(f.vault.connect(f.bob).lock(PULP, 10)).to.be.revertedWithCustomError(f.vault, 'LockCapExceeded');
    const factory = await ethers.getContractFactory('PulpVeVault');
    await expect(factory.deploy({ ...f.config, launchStart: f.launch + DAY, earlyWindow: 0 })).to.be.revertedWithCustomError(f.vault, 'BadConfig');
    await expect(factory.deploy({ ...f.config, launchStart: f.launch - 1n })).to.be.revertedWithCustomError(f.vault, 'BadConfig');
    await expect(factory.deploy({ ...f.config, pulp: f.alice.address })).to.be.revertedWithCustomError(f.vault, 'NotAContract');
  });
  it('uses token base units without assuming 18 decimals', async function () {
    const f = await fixture({ decimals: 6, minLockAmount: 1000n * 10n ** 6n });
    const amount = 1000n * 10n ** 6n;
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(amount, 30));
    expect(await f.vault.powerOf(f.alice.address)).to.equal(amount * 2n);
    await mineAt(f.launch + 15n * DAY);
    expect(await f.vault.powerOf(f.alice.address)).to.equal(amount);
  });
});
