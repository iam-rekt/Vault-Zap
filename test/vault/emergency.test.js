const { expect } = require('chai');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const { ethers, DAY, WAD, PULP, mineAt, txAt, fixture, area } = require('./helpers');

const blockTime = async (tx) => BigInt((await ethers.provider.getBlock((await tx).blockNumber)).timestamp);

// The exit day's payable part: the budget scaled to the elapsed part of the day (nothing if nobody accrued
// area before the switch), then each locker's floor share by area accrued before the switch.
const exitBudget = (budget, x, total) => (total === 0n ? 0n : budget * (x % DAY) / DAY);
const exitShare = (budget, x, mine, total) => (total === 0n ? 0n : exitBudget(budget, x, total) * mine / total);

// The invariant is balance >= reserved: the vault always holds at least what it owes. The excess is only
// tokens sent in by mistake or released budgets not yet swept. `excess` gives the expected excess per token
// (default 0: no strays here, and every release already swept, so the two are equal).
async function expectHeld(f, tokens, excess = {}) {
  const vault = await f.vault.getAddress();
  for (const token of tokens) {
    const addr = await token.getAddress();
    const balance = await token.balanceOf(vault), owed = await f.vault.reserved(addr);
    expect(balance >= owed, `balance >= reserved (${addr})`).to.equal(true);
    expect(balance - owed, `balance - reserved (${addr})`).to.equal(excess[addr] ?? 0n);
    expect((await f.vault.totalPaid(addr)) + (await f.vault.totalReleased(addr)) <= (await f.vault.totalNotified(addr)),
      `paid + released <= notified (${addr})`).to.equal(true);
  }
}

// The user's whole principal comes back, the lock is gone, and `Withdrawn` is logged.
async function expectWithdraw(f, signer, label = 'withdraw') {
  const { amount } = await f.vault.locks(signer.address);
  expect(amount, `${label}: has a lock`).to.be.greaterThan(0n);
  const before = await f.pulp.balanceOf(signer.address);
  await expect(f.vault.connect(signer).withdraw(), label).to.emit(f.vault, 'Withdrawn').withArgs(signer.address, amount);
  expect(await f.pulp.balanceOf(signer.address), `${label}: principal returned`).to.equal(before + amount);
  expect((await f.vault.locks(signer.address)).amount).to.equal(0n);
}

// Alice: 10 days from launch (matures at launch + 10 days). Bob: 30 days (20 left at that point).
async function lockBoth(f) {
  await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 10));
  await txAt(f.launch, () => f.vault.connect(f.bob).lock(3n * PULP, 30));
}

// The two guarantees under whatever condition the caller set up: a matured lock withdraws; an active
// one does not until the emergency exit is on, and then it does too.
async function bothPaths(f, othersLocked = 0n) {
  await mineAt(f.launch + 10n * DAY);
  await expect(f.vault.connect(f.bob).withdraw()).to.be.revertedWithCustomError(f.vault, 'LockActive');
  await expectWithdraw(f, f.alice, 'matured withdraw');
  await f.vault.enableEmergencyExit();
  await expectWithdraw(f, f.bob, 'emergency withdraw');
  expect(await f.vault.totalLocked()).to.equal(othersLocked);
}

describe('PulpVeVault: emergency exit', function () {
  it('is off at deploy, owner-only, one-way, moves nothing, and logs the exit day, second and area', async function () {
    const f = await fixture();
    const vault = await f.vault.getAddress(), pulp = await f.pulp.getAddress();
    expect(await f.vault.emergencyExit()).to.equal(false);
    expect([await f.vault.exitEpoch(), await f.vault.exitTimestamp(), await f.vault.exitDayTotalArea()]).to.deep.equal([0n, 0n, 0n]);
    await lockBoth(f);
    await expect(f.vault.connect(f.stranger).enableEmergencyExit())
      .to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.connect(f.alice).enableEmergencyExit())
      .to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    const before = [await f.pulp.balanceOf(vault), await f.vault.totalLocked(), await f.vault.reserved(pulp),
      await f.vault.totalEpochArea(f.launch / DAY + 3n)];
    const x = f.launch + 777n;
    const tx = txAt(x, () => f.vault.enableEmergencyExit());
    const total = area(PULP * 2n * WAD, f.launch + 10n * DAY, f.launch, x) + area(3n * PULP * 2n * WAD, f.launch + 30n * DAY, f.launch, x);
    await expect(tx).to.emit(f.vault, 'EmergencyExitEnabled').withArgs(x / DAY, x, total);
    await expect(tx).to.not.emit(f.pulp, 'Transfer');
    expect(await f.vault.emergencyExit()).to.equal(true);
    expect([await f.vault.exitEpoch(), await f.vault.exitTimestamp(), await f.vault.exitDayTotalArea()]).to.deep.equal([x / DAY, x, total]);
    expect([await f.pulp.balanceOf(vault), await f.vault.totalLocked(), await f.vault.reserved(pulp),
      await f.vault.totalEpochArea(f.launch / DAY + 3n)]).to.deep.equal(before);
    // No way back: enabling again reverts, and nothing else in the ABI writes the flag.
    await expect(f.vault.enableEmergencyExit()).to.be.revertedWithCustomError(f.vault, 'EmergencyExitActive');
    const names = f.vault.interface.fragments.filter((x) => x.type === 'function' && /mergency/i.test(x.name)).map((x) => x.name);
    expect(names.sort()).to.deep.equal(['emergencyExit', 'enableEmergencyExit']);
    await f.vault.transferOwnership(f.carol.address);
    await f.vault.connect(f.carol).acceptOwnership();
    await mineAt(f.launch + 5n * DAY);
    await expect(f.vault.connect(f.carol).enableEmergencyExit()).to.be.revertedWithCustomError(f.vault, 'EmergencyExitActive');
    expect([await f.vault.exitEpoch(), await f.vault.exitTimestamp(), await f.vault.exitDayTotalArea()]).to.deep.equal([x / DAY, x, total]);
  });

  it('withdraws an active lock in full at once, logs EarlyWithdrawn, and touches no area', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(3n * PULP, 30));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 30));
    const boostA = 3n * PULP * 2n * WAD, boostB = PULP * 2n * WAD, end = f.launch + 30n * DAY;
    const t0 = f.launch + 5n * DAY + 1234n, x = t0 + 1n;
    await expect(txAt(t0, () => f.vault.connect(f.alice).withdraw())).to.be.revertedWithCustomError(f.vault, 'LockActive');
    await txAt(x, () => f.vault.enableEmergencyExit());
    const before = await f.pulp.balanceOf(f.alice.address);
    const tx = await txAt(x + 100n, () => f.vault.connect(f.alice).withdraw());
    await expect(tx).to.emit(f.vault, 'Withdrawn').withArgs(f.alice.address, 3n * PULP);
    await expect(tx).to.emit(f.vault, 'EarlyWithdrawn').withArgs(f.alice.address, 3n * PULP, end);
    const gas = (await tx.wait()).gasUsed;
    expect(gas).to.be.lessThan(100_000n);
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(before + 3n * PULP);
    expect(await f.vault.totalLocked()).to.equal(PULP);
    expect(await f.vault.powerOf(f.alice.address)).to.equal(0n);

    // Areas are frozen at the switch: both whole schedules are still there; only the part before the switch pays.
    for (let epoch = f.launch / DAY; epoch <= (end - 1n) / DAY; epoch++) {
      const from = epoch * DAY, to = from + DAY;
      const a = area(boostA, end, from, to), b = area(boostB, end, from, to);
      expect(await f.vault.userEpochArea(f.alice.address, epoch), `alice day ${epoch}`).to.equal(a);
      expect(await f.vault.totalEpochArea(epoch), `total day ${epoch}`).to.equal(a + b);
    }
    const dayStart = (x / DAY) * DAY;
    const pa = area(boostA, end, dayStart, x), pb = area(boostB, end, dayStart, x);
    expect(await f.vault.exitDayArea(f.alice.address)).to.equal(pa);  // from what her lock left behind
    expect(await f.vault.exitDayArea(f.bob.address)).to.equal(pb);
    expect(await f.vault.exitDayTotalArea()).to.equal(pa + pb);
    expect(await f.vault.userEpochCount(f.alice.address)).to.equal(30n);
    await expect(f.vault.connect(f.alice).withdraw()).to.be.revertedWithCustomError(f.vault, 'NoLock');
    await expect(f.vault.connect(f.alice).lock(PULP, 30)).to.be.revertedWithCustomError(f.vault, 'EmergencyExitActive');

    // A lock that reaches its end after the exit withdraws on the matured path (no EarlyWithdrawn); its
    // exit-day area is unchanged.
    await mineAt(end);
    await expect(f.vault.connect(f.bob).withdraw()).to.not.emit(f.vault, 'EarlyWithdrawn');
    expect(await f.vault.exitDayArea(f.bob.address)).to.equal(pb);
    console.log(`      gas: early withdraw after the exit=${gas}`);
  });

  it('blocks every call that adds principal, area or budget; claims, pause and fee settings still work', async function () {
    const f = await fixture();
    const pulp = await f.pulp.getAddress(), weth = await f.weth.getAddress(), vault = await f.vault.getAddress();
    await f.vault.addRewardToken(pulp);
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await f.vault.connect(f.distributor).notifyRewardAmount(pulp, 7n * PULP);
    // Exactly at 00:00 of day L+3: nothing of that day has elapsed, so its whole budget goes back.
    const tx = txAt(f.launch + 3n * DAY, () => f.vault.enableEmergencyExit());
    await expect(tx).to.emit(f.vault, 'EmptyRewardsReleased').withArgs(weth, f.launch / DAY + 3n, WAD);
    await expect(tx).to.emit(f.vault, 'EmptyRewardsReleased').withArgs(pulp, f.launch / DAY + 3n, PULP);
    expect(await f.vault.exitDayTotalArea()).to.equal(0n);
    const exited = (tx, label) => expect(tx, label).to.be.revertedWithCustomError(f.vault, 'EmergencyExitActive');
    for (const pause of [false, true]) {
      await f.vault.setLocksPaused(pause); // the exit is reported first, paused or not
      await exited(f.vault.connect(f.bob).lock(PULP, 30), 'lock');
      await exited(f.vault.connect(f.bob).lockFor(f.carol.address, PULP, 30), 'lockFor');
      await exited(f.vault.connect(f.alice).increaseAmount(PULP), 'increaseAmount');
      await exited(f.vault.connect(f.bob).increaseAmountFor(f.alice.address, PULP), 'increaseAmountFor');
      await exited(f.vault.connect(f.alice).compound(64, 200), 'compound');
      await exited(f.vault.connect(f.alice).extend(30), 'extend');
      await exited(f.vault.connect(f.distributor).notifyRewardAmount(pulp, PULP), 'notifyRewardAmount');
      await exited(f.vault.connect(f.distributor).notifyRewardETH({ value: WAD }), 'notifyRewardETH');
      await exited(f.distributor.sendTransaction({ to: vault, value: WAD }), 'plain ETH from the distributor');
      await exited(f.vault.recycleEmptyRewards(weth, f.launch / DAY), 'recycleEmptyRewards');
    }
    // Not the distributor: still NotDistributor first, as before.
    await expect(f.vault.connect(f.stranger).notifyRewardETH({ value: 1n })).to.be.revertedWithCustomError(f.vault, 'NotDistributor');
    await f.vault.setCompoundFee(0);
    await f.vault.setLocksPaused(false);
    // Closed days stay claimable, in both tokens.
    const q = await f.vault.claimable(f.alice.address, weth, 64);
    expect(q.amount).to.equal(2n * WAD); // days launch+1 and launch+2, Alice alone
    await expect(f.vault.connect(f.alice).claim(weth, 64)).to.changeTokenBalance(f.weth, f.alice, 2n * WAD);
    await expect(f.vault.connect(f.alice).claim(pulp, 64)).to.changeTokenBalance(f.pulp, f.alice, 2n * PULP);
    await expectWithdraw(f, f.alice);
    await expectHeld(f, [f.pulp, f.weth], { [weth]: WAD, [pulp]: PULP }); // the exit day, released, not swept
  });

  it('pays the exit day up to the switch second; leaving or staying changes nothing', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    const L = f.launch / DAY, end = f.launch + 30n * DAY, B = PULP * 2n * WAD;
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD }); // 1 WETH a day, days L+1..L+7
    const x = (L + 3n) * DAY - 1000n;                                          // late on day L+2
    await txAt(x, () => f.vault.enableEmergencyExit());
    expect(await f.vault.exitEpoch()).to.equal(L + 2n);
    const P = WAD * (DAY - 1000n) / DAY;
    expect(await f.vault.epochRewards(weth, L + 2n)).to.equal(P);                 // the earned part stays
    expect(await f.vault.totalReleased(weth)).to.equal(WAD - P);                  // the last 1,000 s go back
    const partial = area(B, end, (L + 2n) * DAY, x);
    expect(await f.vault.exitDayArea(f.alice.address)).to.equal(partial);
    expect(await f.vault.exitDayTotalArea()).to.equal(2n * partial);
    const bobAtSwitch = (await f.vault.claimable(f.bob.address, weth, 64)).amount;
    await txAt((L + 3n) * DAY, () => f.vault.connect(f.alice).withdraw());       // Alice leaves; Bob stays
    expect((await f.vault.claimable(f.bob.address, weth, 64)).amount).to.equal(bobAtSwitch);
    await mineAt((L + 9n) * DAY);
    for (const s of [f.alice, f.bob]) {
      const q = await f.vault.claimable(s.address, weth, 64);
      expect(q.amount).to.equal(WAD / 2n + P / 2n);      // day L+1 by area, the exit day up to the switch
      expect([q.nextCursor, q.caughtUp]).to.deep.equal([3n, true]); // days L, L+1, L+2 (the exit day)
      await f.vault.connect(s).claim(weth, 64);
      expect(await f.weth.balanceOf(s.address)).to.equal(WAD / 2n + P / 2n);
    }
    // Claiming again pays nothing and does not move the cursor, however long Bob stays.
    await mineAt((L + 40n) * DAY);
    await expect(f.vault.connect(f.bob).claim(weth, 64)).to.emit(f.vault, 'RewardPaid').withArgs(f.bob.address, weth, 0n, 3n);
    // Days L+3..L+7 are on the books until released, then go back to the treasury.
    expect(await f.vault.reserved(weth)).to.equal(5n * WAD + P % 2n);
    const tx = f.vault.releasePostExitRewards(weth);
    await expect(tx).to.emit(f.vault, 'EmptyRewardsReleased').withArgs(weth, L + 3n, WAD);
    await expect(tx).to.emit(f.vault, 'EmptyRewardsReleased').withArgs(weth, L + 7n, WAD);
    expect(await f.vault.reserved(weth)).to.equal(P % 2n);                         // rounding dust only
    await expectHeld(f, [f.pulp, f.weth], { [weth]: 6n * WAD - P });
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, 6n * WAD - P);
    await expectHeld(f, [f.pulp, f.weth]);
    await expectWithdraw(f, f.bob, 'stayer leaves later');
  });

  it('releases only unpayable budgets; reserved drops by exactly that and only that can be swept', async function () {
    const f = await fixture();
    const pulp = await f.pulp.getAddress(), weth = await f.weth.getAddress(), vault = await f.vault.getAddress();
    const L = f.launch / DAY;
    await f.vault.addRewardToken(pulp);
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await f.vault.connect(f.distributor).notifyRewardAmount(pulp, 7n * PULP);
    await expect(f.vault.releaseEmptyRewards(weth, L + 5n)).to.be.revertedWithCustomError(f.vault, 'EmergencyExitOff');
    const x = (L + 2n) * DAY + 500n;
    await txAt(x, () => f.vault.enableEmergencyExit());
    await txAt(x + 100n, () => f.vault.connect(f.alice).withdraw());
    const Pw = WAD * 500n / DAY, Pp = PULP * 500n / DAY;
    await expectHeld(f, [f.pulp, f.weth], { [weth]: WAD - Pw, [pulp]: PULP - Pp });
    expect(await f.vault.exitEpoch()).to.equal(L + 2n);

    // Day L+1 closed before the switch with Alice's power in it: owed in full, never releasable. The launch
    // day had power too (no budget). The exit day's earned part is owed; its unearned part went back at the
    // switch. Every later day can never be paid.
    await expect(f.vault.releaseEmptyRewards(weth, L + 1n)).to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
    await expect(f.vault.releaseEmptyRewards(weth, L)).to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
    await expect(f.vault.releaseEmptyRewards(weth, L + 2n)).to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
    await expect(f.vault.releaseEmptyRewards(f.stranger.address, L + 3n)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    await expect(f.vault.connect(f.stranger).releaseEmptyRewards(weth, L + 3n)) // permissionless, even before that day
      .to.emit(f.vault, 'EmptyRewardsReleased').withArgs(weth, L + 3n, WAD);
    await expect(f.vault.releaseEmptyRewards(weth, L + 3n)).to.be.revertedWithCustomError(f.vault, 'NothingToFund');
    await expect(f.vault.releaseEmptyRewards(weth, L + 30n)).to.be.revertedWithCustomError(f.vault, 'NothingToFund');
    expect(await f.vault.totalReleased(weth)).to.equal(2n * WAD - Pw);
    expect(await f.vault.reserved(weth)).to.equal(5n * WAD + Pw);
    expect(await f.weth.balanceOf(vault)).to.equal(7n * WAD);
    await expect(f.vault.connect(f.stranger).recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, 2n * WAD - Pw);
    await expect(f.vault.recoverExcess(weth)).to.be.revertedWithCustomError(f.vault, 'NothingToRecover');
    for (let d = L + 4n; d <= L + 7n; d++) await f.vault.releaseEmptyRewards(weth, d);
    for (let d = L + 3n; d <= L + 7n; d++) await f.vault.releaseEmptyRewards(pulp, d);
    expect(await f.vault.reserved(weth)).to.equal(WAD + Pw);
    expect(await f.vault.reserved(pulp)).to.equal(PULP + Pp); // no principal left: one closed day and the exit day
    await expect(f.vault.recoverExcess(pulp)).to.changeTokenBalance(f.pulp, f.treasury, 6n * PULP - Pp);
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, 4n * WAD);
    await expectHeld(f, [f.pulp, f.weth]);

    // Everything Alice earned is still hers: day L+1, and the exit day up to the switch (alone: all of it).
    await expect(f.vault.connect(f.alice).claim(weth, 64)).to.changeTokenBalance(f.weth, f.alice, WAD + Pw);
    await expect(f.vault.connect(f.alice).claim(pulp, 64)).to.changeTokenBalance(f.pulp, f.alice, PULP + Pp);
    expect(await f.weth.balanceOf(vault)).to.equal(0n);
    expect(await f.pulp.balanceOf(vault)).to.equal(0n);
    await expectHeld(f, [f.pulp, f.weth]);
  });
});

// Review M-A scenario: the owner keeps a 1,000-PULP lock, Alice 1,000,000 PULP, both 30 days from launch; 70 WETH
// funds days L+1..L+7 (10 a day). The switch is `offset` seconds from 00:00 of day L+3 (negative: late on day
// L+2); Alice leaves `leaveAfter` seconds after it (null: she stays). Returns what each can claim and what an
// independent computation says each earned: closed days by full-day area, the exit day by area before the switch.
async function scenario(offset, leaveAfter) {
  const f = await fixture();
  const weth = await f.weth.getAddress();
  const L = f.launch / DAY, end = f.launch + 30n * DAY;
  const big = 1_000_000n * WAD, small = PULP;
  const bA = big * 2n * WAD, bO = small * 2n * WAD;
  await txAt(f.launch, () => f.vault.connect(f.alice).lock(big, 30));
  await txAt(f.launch, () => f.vault.connect(f.owner).lock(small, 30));
  await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD });
  const x = (L + 3n) * DAY + offset, E = x / DAY;
  await txAt(x, () => f.vault.enableEmergencyExit());
  expect(await f.vault.exitEpoch()).to.equal(E);
  let fairOwner = 0n, fairAlice = 0n;
  for (let d = L + 1n; d < E; d++) {
    const a = area(bA, end, d * DAY, d * DAY + DAY), o = area(bO, end, d * DAY, d * DAY + DAY);
    fairAlice += 10n * WAD * a / (a + o);
    fairOwner += 10n * WAD * o / (a + o);
  }
  const pa = area(bA, end, E * DAY, x), po = area(bO, end, E * DAY, x);
  expect(await f.vault.exitDayArea(f.alice.address)).to.equal(pa);
  expect(await f.vault.exitDayArea(f.owner.address)).to.equal(po);
  expect(await f.vault.exitDayTotalArea()).to.equal(pa + po);
  fairAlice += exitShare(10n * WAD, x, pa, pa + po);
  fairOwner += exitShare(10n * WAD, x, po, pa + po);
  const ownerAtSwitch = (await f.vault.claimable(f.owner.address, weth, 64)).amount;
  if (leaveAfter !== null) await txAt(x + leaveAfter, () => f.vault.connect(f.alice).withdraw());
  // Alice leaving changes nothing the owner can claim, now or later.
  expect((await f.vault.claimable(f.owner.address, weth, 64)).amount).to.equal(ownerAtSwitch);
  await mineAt((L + 9n) * DAY);
  const qo = await f.vault.claimable(f.owner.address, weth, 64), qa = await f.vault.claimable(f.alice.address, weth, 64);
  expect([qo.caughtUp, qa.caughtUp]).to.deep.equal([true, true]);
  const cursor = E - L + 1n; // every day from launch through the exit day
  expect([qo.nextCursor, qa.nextCursor]).to.deep.equal([cursor, cursor]);
  return { f, weth, L, E, x, owner: qo.amount, alice: qa.amount, ownerAtSwitch, fairOwner, fairAlice };
}

describe('PulpVeVault: the exit day is paid up to the switch second (review M-A)', function () {
  it('PoC M-A, switch at 23:59:50: lockers keep everything earned that day but the last 10 seconds', async function () {
    const r = await scenario(-10n, 600n);
    const { f, weth, L } = r;
    expect(r.owner).to.equal(r.fairOwner);
    expect(r.alice).to.equal(r.fairAlice);
    expect(r.ownerAtSwitch).to.equal(r.fairOwner);
    const lockers = r.owner + r.alice, earnable = 20n * WAD - 10n * WAD * 10n / DAY; // 20 WETH minus 10 s of a day
    expect(lockers).to.be.lessThanOrEqual(earnable);
    expect(earnable - lockers).to.be.lessThan(5n); // floor rounding: one closed day, the exit-day budget, two shares
    console.log(`      M-A after the fix (switch 23:59:50): lockers ${ethers.formatEther(lockers)} of 20 WETH earned ` +
      `(was 20 of 70 to lockers, 50 to the caller; then 10)`);

    // The last 10 s of the exit day and days L+3..L+7 go back, and only to the treasury.
    const unearnedExitDay = 10n * WAD - 10n * WAD * (DAY - 10n) / DAY;
    expect(await f.vault.totalReleased(weth)).to.equal(unearnedExitDay);
    expect(await f.vault.connect(f.stranger).releasePostExitRewards.staticCall(weth)).to.equal(50n * WAD);
    await f.vault.connect(f.stranger).releasePostExitRewards(weth);
    await expect(f.vault.releaseEmptyRewards(weth, L + 2n)).to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
    await expectHeld(f, [f.pulp, f.weth], { [weth]: 50n * WAD + unearnedExitDay });
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, 50n * WAD + unearnedExitDay);
    await expectHeld(f, [f.pulp, f.weth]);
    await expect(f.vault.connect(f.alice).claim(weth, 64)).to.changeTokenBalance(f.weth, f.alice, r.fairAlice);
    await expect(f.vault.connect(f.owner).claim(weth, 64)).to.changeTokenBalance(f.weth, f.owner, r.fairOwner);
    expect(await f.vault.reserved(weth)).to.be.lessThan(3n); // rounding dust only
    await expectHeld(f, [f.pulp, f.weth]);
    await expectWithdraw(f, f.owner, 'stayer withdraws after release and sweep');
  });

  it('switch at 00:00:10: nothing earned is lost (two closed days plus 10 seconds of the third)', async function () {
    const r = await scenario(10n, null);
    expect([r.owner, r.alice]).to.deep.equal([r.fairOwner, r.fairAlice]);
    const earned = 20n * WAD + 10n * WAD * 10n / DAY;
    expect(earned - (r.owner + r.alice)).to.be.lessThan(4n);
    expect(await r.f.vault.releasePostExitRewards.staticCall(r.weth)).to.equal(40n * WAD);
    expect(await r.f.vault.totalReleased(r.weth)).to.equal(10n * WAD - 10n * WAD * 10n / DAY);
  });

  it('no timing lever beyond seconds: lockers get the funded rate times the seconds elapsed, leaving or staying', async function () {
    const offsets = [-DAY / 2n, -10n, -1n, 0n, 1n, 10n, DAY / 2n];
    for (const offset of offsets) {
      let first;
      for (const leaveAfter of [null, 1n, DAY]) {
        const r = await scenario(offset, leaveAfter);
        expect([r.owner, r.alice], `switch ${offset}s, leave ${leaveAfter}`).to.deep.equal([r.fairOwner, r.fairAlice]);
        first ??= r;
        expect([r.owner, r.alice], 'leaving or staying changes nothing').to.deep.equal([first.owner, first.alice]);
        // 10 WETH a day from day L+1 on, by the second, up to the switch: within rounding.
        const accrued = 10n * WAD * (r.x - (r.L + 1n) * DAY) / DAY;
        expect(accrued - (r.owner + r.alice), `switch ${offset}s`).to.be.lessThan(5n);
        expect(accrued >= r.owner + r.alice).to.equal(true);
      }
    }
  });

  it('PoC P3: a switch one hour into the first funded day pays that hour by area and returns the rest', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    const L = f.launch / DAY, end = f.launch + 30n * DAY;
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(1_000_000n * WAD, 30));
    await txAt(f.launch, () => f.vault.connect(f.owner).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 70n * WAD });
    const x = (L + 1n) * DAY + 3600n;
    await txAt(x, () => f.vault.enableEmergencyExit());
    await txAt(x + 1n, () => f.vault.connect(f.alice).withdraw());
    expect(await f.vault.exitEpoch()).to.equal(L + 1n);
    const pa = area(1_000_000n * WAD * 2n * WAD, end, (L + 1n) * DAY, x), po = area(PULP * 2n * WAD, end, (L + 1n) * DAY, x);
    await mineAt((L + 9n) * DAY);
    const qa = await f.vault.claimable(f.alice.address, weth, 64), qo = await f.vault.claimable(f.owner.address, weth, 64);
    expect([qa.amount, qa.nextCursor, qa.caughtUp]).to.deep.equal([exitShare(10n * WAD, x, pa, pa + po), 2n, true]);
    expect([qo.amount, qo.nextCursor, qo.caughtUp]).to.deep.equal([exitShare(10n * WAD, x, po, pa + po), 2n, true]);
    const P = 10n * WAD * 3600n / DAY;
    console.log(`      P3 after the fix: leaver ${ethers.formatEther(qa.amount)}, stayer ${ethers.formatEther(qo.amount)}, ` +
      `released ${ethers.formatEther(70n * WAD - P)} WETH`);
    await expect(f.vault.releaseEmptyRewards(weth, L)).to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
    await expect(f.vault.releaseEmptyRewards(weth, L + 1n)).to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
    expect(await f.vault.releasePostExitRewards.staticCall(weth)).to.equal(60n * WAD);
    await f.vault.releasePostExitRewards(weth);
    expect(await f.vault.totalReleased(weth)).to.equal(70n * WAD - P);
    expect(await f.vault.reserved(weth)).to.equal(P);
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, 70n * WAD - P);
    await expect(f.vault.connect(f.owner).claim(weth, 64)).to.changeTokenBalance(f.weth, f.owner, qo.amount);
    await expect(f.vault.connect(f.alice).claim(weth, 64)).to.changeTokenBalance(f.weth, f.alice, qa.amount);
    await expectHeld(f, [f.pulp, f.weth]);
    await expectWithdraw(f, f.owner, 'stayer withdraws after release and sweep');
  });

  it('exit-day areas are exact for restarts, extensions, top-ups and locks ending before, at or after the switch', async function () {
    const f = await fixture();
    const signers = await ethers.getSigners();
    const [dave, erin] = [signers[7], signers[8]];
    for (const s of [dave, erin]) {
      await f.pulp.mint(s.address, 10n ** 30n);
      await f.pulp.connect(s).approve(await f.vault.getAddress(), ethers.MaxUint256);
    }
    const L = f.launch / DAY, D = L + 20n, ds = D * DAY, x = ds + 40_000n;
    // Independent segments: [start, stop) of a trajectory with `boost` that would reach zero at `end`.
    const segs = new Map();
    const add = (who, start, end, boost) => { if (!segs.has(who)) segs.set(who, []); segs.get(who).push({ start, stop: end, end, boost }); };
    const cut = (who, t) => { for (const s of segs.get(who)) if (s.stop > t) s.stop = t; };
    const lockAt = async (s, t, days, amount = PULP) => {
      await txAt(t, () => f.vault.connect(s).lock(amount, days));
      add(s.address, t, t + BigInt(days) * DAY, (await f.vault.locks(s.address)).boosted);
    };
    await lockAt(f.carol, (D - 20n) * DAY + 50_000n, 20);  // ends later on the exit day, another bucket
    await lockAt(f.alice, (D - 10n) * DAY + 3_600n, 10);   // ends at 01:00 on the exit day, then restarts
    await lockAt(dave, (D - 10n) * DAY + 10_000n, 10);      // ends before the switch and withdraws before it
    await lockAt(f.bob, (D - 10n) * DAY + 40_030n, 10);     // ends 30 s after the switch, same 10-minute bucket
    await lockAt(erin, (D - 10n) * DAY + 40_900n, 10, 7n * PULP); // ends 900 s after the switch
    await lockAt(f.stranger, (D - 9n) * DAY, 10);            // ends exactly at the end of the exit day
    await lockAt(f.distributor, (D - 5n) * DAY + 777n, 30);  // ends weeks later
    await lockAt(f.owner, (D - 3n) * DAY + 100n, 10, 3n * PULP);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await txAt(ds + 15_000n, () => f.vault.connect(dave).withdraw());
    await txAt(ds + 20_000n, () => f.vault.connect(f.owner).extend(30));            // mid-day extension
    cut(f.owner.address, ds + 20_000n);
    add(f.owner.address, ds + 20_000n, ds + 20_000n + 30n * DAY, (await f.vault.locks(f.owner.address)).boosted);
    const boostedBefore = (await f.vault.locks(f.owner.address)).boosted;
    await txAt(ds + 30_000n, () => f.vault.connect(f.owner).increaseAmount(5n * PULP)); // mid-day top-up
    add(f.owner.address, ds + 30_000n, ds + 20_000n + 30n * DAY, (await f.vault.locks(f.owner.address)).boosted - boostedBefore);
    await txAt(ds + 39_000n, () => f.vault.connect(f.alice).extend(10));            // restart after expiry
    add(f.alice.address, ds + 39_000n, ds + 39_000n + 10n * DAY, (await f.vault.locks(f.alice.address)).boosted);

    // Everything closed before the exit day is claimed first, so what is left below is the exit day alone.
    const weth = await f.weth.getAddress();
    const everyone = [f.carol, f.alice, dave, f.bob, erin, f.stranger, f.distributor, f.owner];
    await txAt(ds + 39_500n, () => f.vault.connect(everyone[0]).claim(weth, 64));
    for (const s of everyone.slice(1)) await f.vault.connect(s).claim(weth, 64);
    expect(await f.vault.epochRewards(weth, D)).to.equal(WAD); // funded on day D-3: days D-2..D+4

    const tx = await txAt(x, () => f.vault.enableEmergencyExit());
    console.log(`      gas: enableEmergencyExit with 8 locks=${(await tx.wait()).gasUsed}`);
    const partial = (who) => (segs.get(who) || []).reduce((sum, s) => {
      const a = s.start > ds ? s.start : ds, b = s.stop < x ? s.stop : x;
      return a < b ? sum + s.boost * ((s.end - a) ** 2n - (s.end - b) ** 2n) : sum;
    }, 0n);
    let total = 0n;
    for (const s of everyone) {
      const p = partial(s.address);
      expect(p, `${s.address} accrued something`).to.be.greaterThan(0n);
      expect(await f.vault.exitDayArea(s.address), `exit-day area ${s.address}`).to.equal(p);
      total += p;
    }
    expect(await f.vault.exitDayTotalArea()).to.equal(total);
    // Withdrawals after the switch change no exit-day area; each payout is floor(P * area / total) with
    // P = floor(budget * elapsed / DAY), within one unit of budget * elapsed/DAY * area/total.
    for (const s of [f.bob, erin, f.alice]) await f.vault.connect(s).withdraw();
    await mineAt((D + 1n) * DAY);
    let paid = 0n;
    for (const s of everyone) {
      const p = partial(s.address);
      expect(await f.vault.exitDayArea(s.address)).to.equal(p);
      const q = await f.vault.claimable(s.address, weth, 64);
      expect(q.amount, `exit-day payout ${s.address}`).to.equal(exitShare(WAD, x, p, total));
      const exact = WAD * (x - ds) * p, denom = DAY * total; // the rational the payout rounds down
      expect(q.amount * denom <= exact && exact - q.amount * denom < 2n * denom).to.equal(true);
      await expect(f.vault.connect(s).claim(weth, 64)).to.changeTokenBalance(f.weth, s, q.amount);
      paid += q.amount;
    }
    const P = WAD * (x - ds) / DAY;
    expect(paid <= P && P - paid < BigInt(everyone.length)).to.equal(true);
    expect(await f.vault.totalReleased(weth)).to.equal(WAD - P);
  });
});

describe('PulpVeVault: after the switch, paging, releases and launch-day edges', function () {
  it('a user who claimed partway keeps every closed day and the exit day; pages stop after the exit day', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    const L = f.launch / DAY, end = f.launch + 30n * DAY;
    const boostB = PULP * 2n * WAD, boostC = 3n * PULP * 2n * WAD;
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 30));
    await txAt(f.launch, () => f.vault.connect(f.carol).lock(3n * PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });            // days L+1..L+7: 1 WETH
    await txAt((L + 3n) * DAY + 50n, () => f.vault.connect(f.distributor).notifyRewardETH({ value: 14n * WAD })); // L+4..L+10: +2
    const budget = (d) => (d >= L + 1n && d <= L + 7n ? WAD : 0n) + (d >= L + 4n && d <= L + 10n ? 2n * WAD : 0n);
    const x = (L + 5n) * DAY + 7200n, tLeave = x + 100n;
    const share = (d, who) => {
      const from = d * DAY, to = from + DAY;
      const b = area(boostB, end, from, to), c = area(boostC, end, from, to);
      return budget(d) * (who === 'bob' ? b : c) / (b + c);
    };
    const pb = area(boostB, end, (L + 5n) * DAY, x), pc = area(boostC, end, (L + 5n) * DAY, x);
    const exitOf = (who) => exitShare(budget(L + 5n), x, who === 'bob' ? pb : pc, pb + pc);
    let bob = 0n;
    const claimBob = async (n, expectedCursor) => {
      const q = await f.vault.claimable(f.bob.address, weth, n);
      await expect(f.vault.connect(f.bob).claim(weth, n)).to.emit(f.vault, 'RewardPaid').withArgs(f.bob.address, weth, q.amount, expectedCursor);
      bob += q.amount;
      return q;
    };

    await txAt((L + 3n) * DAY + 100n, () => claimBob(2, 2n));               // days L, L+1 before the exit
    await txAt(x, () => f.vault.enableEmergencyExit());                      // exit day L+5
    await txAt(tLeave, () => f.vault.connect(f.carol).withdraw());         // Carol leaves; Bob stays
    await claimBob(1, 3n);                                                   // L+2, on the (still open) exit day
    let q = await f.vault.claimable(f.bob.address, weth, 64);
    expect([q.amount, q.nextCursor, q.caughtUp]).to.deep.equal([share(L + 3n, 'bob') + share(L + 4n, 'bob') + exitOf('bob'), 6n, true]);

    await mineAt((L + 20n) * DAY);
    await claimBob(1, 4n);                                                   // L+3
    q = await claimBob(1, 5n);                                               // L+4, the last full day before the switch
    expect(q.caughtUp).to.equal(false);                                      // the exit day is still to come
    q = await claimBob(1, 6n);                                               // L+5, the exit day up to the switch
    expect([q.amount, q.caughtUp]).to.deep.equal([exitOf('bob'), true]);
    await claimBob(64, 6n);                                                  // nothing more, cursor stays
    let expected = exitOf('bob');
    for (let d = L + 1n; d <= L + 4n; d++) expected += share(d, 'bob');
    expect(bob).to.equal(expected);
    expect(await f.weth.balanceOf(f.bob.address)).to.equal(expected);
    let carol = exitOf('carol');
    for (let d = L + 1n; d <= L + 4n; d++) carol += share(d, 'carol');
    await expect(f.vault.connect(f.carol).claim(weth, 64)).to.changeTokenBalance(f.weth, f.carol, carol);

    // The exit day after the switch (3 WETH * the rest of the day) went back at the switch; L+6..L+10
    // (3+3+2+2+2 WETH) pay nobody: one call releases them all, the owner sends them to the treasury.
    const P = 3n * WAD * 7200n / DAY;
    expect(await f.vault.releasePostExitRewards.staticCall(weth)).to.equal(12n * WAD);
    await f.vault.releasePostExitRewards(weth);
    await expectHeld(f, [f.pulp, f.weth], { [weth]: 15n * WAD - P });
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, 15n * WAD - P);
    await expectHeld(f, [f.pulp, f.weth]);
    expect(await f.vault.reserved(weth)).to.equal(6n * WAD + P - expected - carol); // rounding dust only
    expect(await f.vault.reserved(weth)).to.be.lessThan(10n);
    await expectWithdraw(f, f.bob, 'stayer');
  });

  it('a claim cursor already at today when the switch happens pages into the exit day and stops there', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    const L = f.launch / DAY;
    await txAt(f.launch, () => f.vault.connect(f.bob).lock(PULP, 30));
    await txAt(f.launch, () => f.vault.connect(f.carol).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    // Bob claims everything closed on day L+4 (days L..L+3), then the switch comes the same day.
    await txAt((L + 4n) * DAY + 100n, () => f.vault.connect(f.bob).claim(weth, 64));
    expect(await f.vault.claimCursor(f.bob.address, weth)).to.equal(4n);
    expect(await f.weth.balanceOf(f.bob.address)).to.equal(3n * WAD / 2n);
    await txAt((L + 4n) * DAY + 200n, () => f.vault.enableEmergencyExit());
    expect(await f.vault.exitEpoch()).to.equal(L + 4n);
    const P = WAD * 200n / DAY;
    for (const t of [(L + 4n) * DAY + 300n, (L + 5n) * DAY, (L + 12n) * DAY]) {
      await mineAt(t);
      const q = await f.vault.claimable(f.bob.address, weth, 64);
      expect([q.amount, q.nextCursor, q.caughtUp]).to.deep.equal([P / 2n, 5n, true]);
    }
    await expect(f.vault.connect(f.bob).claim(weth, 64)).to.emit(f.vault, 'RewardPaid').withArgs(f.bob.address, weth, P / 2n, 5n);
    await expect(f.vault.connect(f.bob).claim(weth, 64)).to.emit(f.vault, 'RewardPaid').withArgs(f.bob.address, weth, 0n, 5n);
    await expect(f.vault.connect(f.carol).claim(weth, 64)).to.changeTokenBalance(f.weth, f.carol, 3n * WAD / 2n + P / 2n);
    expect(await f.vault.releasePostExitRewards.staticCall(weth)).to.equal(3n * WAD); // L+5..L+7
    await f.vault.releasePostExitRewards(weth);
    await f.vault.recoverExcess(weth);
    expect(await f.weth.balanceOf(f.treasury.address)).to.equal(4n * WAD - P);
    expect(await f.vault.reserved(weth)).to.equal(P % 2n);
    await expectHeld(f, [f.pulp, f.weth]);
  });

  it('funding made on the exit day before the switch is released in full by the one call; a second call reverts', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    const L = f.launch / DAY;
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });                   // L+1..L+7: 1 each
    await txAt((L + 3n) * DAY + 100n, () => f.vault.connect(f.distributor).notifyRewardETH({ value: 14n * WAD + 5n })); // L+4..L+10
    await txAt((L + 3n) * DAY + 200n, () => f.vault.enableEmergencyExit());                     // same day: exit day L+3
    expect(await f.vault.exitEpoch()).to.equal(L + 3n);
    expect(await f.vault.epochRewards(weth, L + 10n)).to.equal(2n * WAD + 5n); // exitEpoch + 7
    const P = WAD * 200n / DAY;
    // Seven funded days after the exit day: L+4..L+7 (3 each), L+8, L+9 (2), L+10 (2 + 5 wei).
    const after = 18n * WAD + 5n;
    expect(await f.vault.connect(f.stranger).releasePostExitRewards.staticCall(weth)).to.equal(after);
    const tx = await f.vault.connect(f.stranger).releasePostExitRewards(weth);
    const receipt = await tx.wait();
    await expect(tx).to.emit(f.vault, 'EmptyRewardsReleased').withArgs(weth, L + 4n, 3n * WAD);
    await expect(tx).to.emit(f.vault, 'EmptyRewardsReleased').withArgs(weth, L + 10n, 2n * WAD + 5n);
    for (let d = L + 4n; d <= L + 10n; d++) expect(await f.vault.epochRewards(weth, d), `day ${d}`).to.equal(0n);
    console.log(`      gas: releasePostExitRewards over 7 funded days=${receipt.gasUsed}`);
    expect(receipt.gasUsed).to.be.lessThan(150_000n);
    await expect(f.vault.releasePostExitRewards(weth)).to.be.revertedWithCustomError(f.vault, 'NothingToFund');
    await expect(f.vault.releaseEmptyRewards(weth, L + 10n)).to.be.revertedWithCustomError(f.vault, 'NothingToFund');
    await expect(f.vault.releaseEmptyRewards(weth, L + 2n)).to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
    await expect(f.vault.releaseEmptyRewards(weth, L + 3n)).to.be.revertedWithCustomError(f.vault, 'EpochHasPower');
    expect(await f.vault.totalReleased(weth)).to.equal(after + WAD - P);
    expect(await f.vault.reserved(weth)).to.equal(2n * WAD + P); // L+1, L+2 and the exit day up to the switch
    await expectHeld(f, [f.pulp, f.weth], { [weth]: after + WAD - P });
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, after + WAD - P);
    await expect(f.vault.connect(f.alice).claim(weth, 64)).to.changeTokenBalance(f.weth, f.alice, 2n * WAD + P);
    expect(await f.weth.balanceOf(await f.vault.getAddress())).to.equal(0n);
    await expectHeld(f, [f.pulp, f.weth]);
  });

  it('exit around the 00:00 UTC launch: before it nothing is payable; after it the launch day pays up to the switch', async function () {
    for (const before of [true, false]) {
      const f = await fixture();
      const weth = await f.weth.getAddress();
      const L = f.launch / DAY;
      expect(f.launch % DAY).to.equal(0n);
      await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });        // before launch: L..L+6
      let total, owed;
      if (before) {
        await txAt(f.launch - 3600n, () => f.vault.enableEmergencyExit());
        expect(await f.vault.exitEpoch()).to.equal(L - 1n);
        await expect(txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30))).to.be.revertedWithCustomError(f.vault, 'EmergencyExitActive');
        total = 7n * WAD; owed = 0n;
        expect(await f.vault.releasePostExitRewards.staticCall(weth)).to.equal(7n * WAD); // scans L..L+6
      } else {
        await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
        await txAt(f.launch + 100n, () => f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD })); // L+1..L+7
        await txAt(f.launch + 3600n, () => f.vault.enableEmergencyExit());
        expect(await f.vault.exitEpoch()).to.equal(L);
        owed = WAD * 3600n / DAY;                                                          // the launch day's first hour
        total = 14n * WAD - owed;
        expect(await f.vault.releasePostExitRewards.staticCall(weth)).to.equal(13n * WAD); // L+1..L+7
      }
      await f.vault.releasePostExitRewards(weth);
      await mineAt((L + 9n) * DAY);
      const q = await f.vault.claimable(f.alice.address, weth, 64);
      expect([q.amount, q.caughtUp]).to.deep.equal([owed, true]);
      expect(await f.vault.reserved(weth)).to.equal(owed);
      await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, total);
      if (!before) {
        await expect(f.vault.connect(f.alice).claim(weth, 64)).to.changeTokenBalance(f.weth, f.alice, owed);
        await expect(f.vault.connect(f.alice).withdraw()).to.changeTokenBalance(f.pulp, f.alice, PULP);
        expect(await f.vault.reserved(await f.pulp.getAddress())).to.equal(0n);
      }
    }
  });

  it('releases every funded day in one call even when the funding sits at a launch day after the exit', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    const launchDay = f.launch / DAY;
    // Funded before launch: the seven days start at the launch day, after the exit day below.
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD + 3n });
    await f.vault.enableEmergencyExit();
    expect(await f.vault.exitEpoch()).to.be.lessThan(launchDay - 1n);
    await expect(f.vault.releaseEmptyRewards(weth, launchDay + 2n))
      .to.emit(f.vault, 'EmptyRewardsReleased').withArgs(weth, launchDay + 2n, WAD);
    const tx = await f.vault.releasePostExitRewards(weth);
    await expect(tx).to.emit(f.vault, 'EmptyRewardsReleased').withArgs(weth, launchDay, WAD);
    await expect(tx).to.emit(f.vault, 'EmptyRewardsReleased').withArgs(weth, launchDay + 6n, WAD + 3n);
    expect(await f.vault.totalReleased(weth)).to.equal(7n * WAD + 3n);
    expect(await f.vault.reserved(weth)).to.equal(0n);
    await expect(f.vault.recoverExcess(weth)).to.changeTokenBalance(f.weth, f.treasury, 7n * WAD + 3n);
    await expect(f.vault.connect(f.alice).lock(PULP, 30)).to.be.revertedWithCustomError(f.vault, 'EmergencyExitActive');
  });

  it('release calls need the exit and a reward token; the one-call release is bounded', async function () {
    const f = await fixture();
    const weth = await f.weth.getAddress();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await expect(f.vault.releasePostExitRewards(weth)).to.be.revertedWithCustomError(f.vault, 'EmergencyExitOff');
    await f.vault.enableEmergencyExit();
    await expect(f.vault.releasePostExitRewards(f.stranger.address)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    const pulp = await f.pulp.getAddress();
    await expect(f.vault.releasePostExitRewards(pulp)).to.be.revertedWithCustomError(f.vault, 'NotRewardToken');
    const gas = (await (await f.vault.releasePostExitRewards(weth)).wait()).gasUsed;
    expect(gas).to.be.lessThan(250_000n);
    expect(await f.vault.reserved(weth)).to.equal(0n); // exit on the launch day: every funded day is after it
    await expectWithdraw(f, f.alice, 'withdraw after the one-call release');
  });

  it('the switch reads a bounded index: gas with a lock ending in every 10 minutes of the day and on 30 later days', async function () {
    const f = await fixture();
    const L = f.launch / DAY, D = L + 31n, ds = D * DAY, x = ds + 10n;
    const times = [];
    for (let j = 1n; j <= 30n; j++) times.push([(D - 30n + j) * DAY + 5n, 30]);          // ends on D+1..D+30
    times.push([(D - 10n) * DAY + 11n, 10]);                                               // ends 1 s after the switch
    for (let k = 1n; k < DAY / 600n; k++) times.push([(D - 10n) * DAY + k * 600n + 7n, 10]); // one end in every later bucket
    times.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [t, days] of times) {
      const who = ethers.Wallet.createRandom().address;
      await txAt(t, () => f.vault.connect(f.carol).lockFor(who, PULP, days));
    }
    const tx = await txAt(x, () => f.vault.enableEmergencyExit());
    const gas = (await tx.wait()).gasUsed;
    console.log(`      gas: enableEmergencyExit, worst-case index (${times.length} lock ends)=${gas}`);
    expect(gas).to.be.lessThan(4_000_000n);
    // Every one of these locks accrued area in the 10 seconds before the switch: an independent sum.
    let total = 0n;
    for (const [t, days] of times) total += area(PULP * WAD, t + BigInt(days) * DAY, t > ds ? t : ds, x);
    expect(await f.vault.exitDayTotalArea()).to.equal(total);
  });
});

describe('PulpVeVault: withdrawal cannot be blocked', function () {
  it('while locks are paused', async function () {
    const f = await fixture();
    await lockBoth(f);
    await f.vault.setLocksPaused(true);
    await bothPaths(f);
  });

  it('with the compound fee at the 2% cap and a treasury that refuses PULP', async function () {
    const carol = (await ethers.getSigners())[4].address;
    const f = await fixture({ tokenKind: 'MockBlockingERC20', compoundFeeBps: 200, treasury: carol });
    await f.vault.addRewardToken(await f.pulp.getAddress());
    await lockBoth(f);
    await f.vault.connect(f.distributor).notifyRewardAmount(await f.pulp.getAddress(), 7n * PULP);
    await f.pulp.setBlockedRecipient(f.carol.address, true);
    await mineAt(f.launch + 9n * DAY);
    await expect(f.vault.connect(f.bob).compound(64, 200)).to.be.revertedWith('MockBlockingERC20: blocked recipient');
    await bothPaths(f);
    expect(await f.pulp.balanceOf(f.carol.address)).to.equal(10n ** 30n); // never paid, never needed
  });

  it('with registered reward tokens that revert, return false, or are paused', async function () {
    const f = await fixture();
    const add = async (kind) => {
      const token = await (await ethers.getContractFactory(kind)).deploy(kind, kind, 18);
      await f.vault.addRewardToken(await token.getAddress());
      await token.mint(f.distributor.address, 7n * WAD);
      await token.connect(f.distributor).approve(await f.vault.getAddress(), 7n * WAD);
      await f.vault.connect(f.distributor).notifyRewardAmount(await token.getAddress(), 7n * WAD);
      return token;
    };
    await lockBoth(f);
    const blocking = await add('MockBlockingERC20');
    const falsy = await add('MockFalseReturnToken');
    const pausable = await add('MockPausableERC20');
    await blocking.setBlockedRecipient(f.alice.address, true);
    await blocking.setBlockedRecipient(f.bob.address, true);
    await falsy.setReturnFalse(true);
    await pausable.setPaused(true);
    await mineAt(f.launch + 9n * DAY);
    await expect(f.vault.connect(f.alice).claimAll(64)).to.be.reverted;
    await bothPaths(f);
    // The broken tokens' entitlements are intact for when they work again.
    await pausable.setPaused(false);
    expect((await f.vault.claimable(f.bob.address, await pausable.getAddress(), 64)).amount).to.be.greaterThan(0n);
    await f.vault.connect(f.bob).claim(await pausable.getAddress(), 64);
  });

  it('with every distributor removed', async function () {
    const f = await fixture();
    await lockBoth(f);
    await f.vault.connect(f.distributor).notifyRewardETH({ value: 7n * WAD });
    await f.vault.setDistributor(f.distributor.address, false);
    await bothPaths(f);
  });

  it('in the middle of an ownership transfer', async function () {
    const f = await fixture();
    await lockBoth(f);
    await f.vault.transferOwnership(f.stranger.address);
    expect(await f.vault.pendingOwner()).to.equal(f.stranger.address);
    await expect(f.vault.connect(f.stranger).enableEmergencyExit()).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    await bothPaths(f); // the current owner can still let people out
    expect(await f.vault.pendingOwner()).to.equal(f.stranger.address);
  });

  it('after someone else opened or topped up the lock: nobody can delay it', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.carol).lockFor(f.alice.address, PULP, 10));
    await txAt(f.launch, () => f.vault.connect(f.carol).increaseAmountFor(f.alice.address, 2n * PULP));
    await txAt(f.launch, () => f.vault.connect(f.carol).lockFor(f.bob.address, PULP, 30));
    await txAt(f.launch + DAY, () => f.vault.connect(f.carol).increaseAmountFor(f.bob.address, 5n * PULP));
    const { end } = await f.vault.locks(f.alice.address);
    await mineAt(end);
    // A third party cannot move a matured lock's end or re-open it under the owner.
    await expect(f.vault.connect(f.carol).increaseAmountFor(f.alice.address, PULP)).to.be.revertedWithCustomError(f.vault, 'LockExpired');
    await expect(f.vault.connect(f.carol).lockFor(f.alice.address, PULP, 30)).to.be.revertedWithCustomError(f.vault, 'LockExists');
    expect((await f.vault.locks(f.alice.address)).end).to.equal(end);
    await expectWithdraw(f, f.alice, 'gifted matured lock');
    expect(await f.pulp.balanceOf(f.alice.address)).to.equal(10n ** 30n + 3n * PULP);
    await f.vault.enableEmergencyExit();
    await expectWithdraw(f, f.bob, 'gifted active lock after exit');
    expect(await f.vault.totalLocked()).to.equal(0n);
  });

  it('with long histories and idle years: gas stays bounded on both paths', async function () {
    const f = await fixture();
    await txAt(f.launch, () => f.vault.connect(f.alice).lock(PULP, 30));
    await txAt(f.launch + 1n, () => f.vault.connect(f.bob).lock(PULP, 30));
    for (let i = 1n; i <= 20n; i++) { // ~420 recorded days each
      await txAt(f.launch + i * 20n * DAY, () => f.vault.connect(f.alice).extend(30));
      await txAt(f.launch + i * 20n * DAY + 1n, () => f.vault.connect(f.bob).extend(30));
    }
    expect(await f.vault.userEpochCount(f.bob.address)).to.be.greaterThan(400n);
    // Bob: 30 days left, starting mid-day, so the most days (31) to cut. Alice: idle for ten years.
    const t = f.launch + 400n * DAY + DAY / 2n;
    await txAt(t, () => f.vault.connect(f.bob).extend(30));
    await f.vault.enableEmergencyExit();
    const early = await (await f.vault.connect(f.bob).withdraw()).wait();
    await mineAt(f.launch + 3650n * DAY);
    const matured = await (await f.vault.connect(f.alice).withdraw()).wait();
    expect(early.gasUsed).to.be.lessThan(100_000n);
    expect(matured.gasUsed).to.be.lessThan(100_000n);
    expect(await f.vault.totalLocked()).to.equal(0n);
    console.log(`      gas: emergency withdraw of a 30-day lock=${early.gasUsed}, matured withdraw after 10 idle years=${matured.gasUsed}`);
  });

  it('a PULP transfer hook cannot re-enter withdraw, and the withdrawal still lands', async function () {
    const f = await fixture({ tokenKind: 'MockReentrantToken' });
    const token = await f.pulp.getAddress(), vault = await f.vault.getAddress();
    // The token contract itself owns a matured lock, so a re-entrant withdraw() from it would be a real one.
    // lockFor refuses the PULP address (typo protection), so the token opens its own lock through its callback:
    // first it approves the vault, then it calls lock (each triggered by an ordinary transfer).
    await f.pulp.mint(token, PULP);
    await f.pulp.configureCallback(token, f.pulp.interface.encodeFunctionData('approve', [vault, PULP]), true);
    await f.pulp.connect(f.carol).transfer(f.carol.address, 0n);
    await f.pulp.configureCallback(ethers.ZeroAddress, '0x', false);
    await lockBoth(f);
    await f.pulp.configureCallback(vault, f.vault.interface.encodeFunctionData('lock', [PULP, 10]), true);
    await txAt(f.launch, () => f.pulp.connect(f.carol).transfer(f.carol.address, 0n));
    expect((await f.vault.locks(token)).amount).to.equal(PULP);
    expect(await f.pulp.succeededCallbacks()).to.equal(2n);
    await expect(f.vault.connect(f.carol).lockFor(token, PULP, 10)).to.be.revertedWithCustomError(f.vault, 'InvalidBeneficiary');
    await f.pulp.configureCallback(vault, f.vault.interface.encodeFunctionData('withdraw'), true);
    const [attempted, succeeded] = [await f.pulp.attemptedCallbacks(), await f.pulp.succeededCallbacks()];
    await bothPaths(f, PULP); // two outgoing transfers, each with a re-entry attempt
    expect(await f.pulp.attemptedCallbacks()).to.equal(attempted + 2n);
    expect(await f.pulp.succeededCallbacks()).to.equal(succeeded);
    expect((await f.vault.locks(token)).amount).to.equal(PULP);
    // Outside a vault call the same callback succeeds: the guard was what stopped it.
    await f.pulp.connect(f.alice).transfer(f.bob.address, 1n);
    expect(await f.pulp.succeededCallbacks()).to.equal(succeeded + 1n);
    expect((await f.vault.locks(token)).amount).to.equal(0n);
    expect(await f.pulp.balanceOf(vault)).to.equal(0n);
  });

  it('the owner has no function that can move locked principal or delay a matured withdrawal', async function () {
    const f = await fixture({ compoundFeeBps: 100 });
    const pulp = await f.pulp.getAddress(), vault = await f.vault.getAddress();
    // Every state-changing entry point, by who may call it. A new one fails this test until classified.
    const USER = ['lock', 'lockFor', 'increaseAmount', 'increaseAmountFor', 'compound', 'extend', 'withdraw',
      'claim', 'claimTo', 'claimAll', 'claimAllTo', 'recycleEmptyRewards', 'releaseEmptyRewards', 'releasePostExitRewards',
      'acceptOwnership', 'acceptTreasury', 'expireRewardToken'];
    const DISTRIBUTOR = ['notifyRewardAmount', 'notifyRewardETH'];
    const OWNER = ['addRewardToken', 'removeRewardToken', 'setDistributor', 'setLocksPaused', 'setCompoundFee',
      'proposeTreasury', 'recoverERC20', 'recoverExcess', 'enableEmergencyExit', 'transferOwnership', 'renounceOwnership'];
    const writers = f.vault.interface.fragments
      .filter((x) => x.type === 'function' && !['view', 'pure'].includes(x.stateMutability)).map((x) => x.name);
    expect(writers.sort()).to.deep.equal([...USER, ...DISTRIBUTOR, ...OWNER].filter((n) => n !== 'renounceOwnership').sort());
    expect(f.vault.interface.getFunction('renounceOwnership').stateMutability).to.equal('pure'); // always reverts
    const hostile = {
      addRewardToken: [await (await (await ethers.getContractFactory('MockPausableERC20')).deploy('P', 'P', 18)).getAddress()],
      removeRewardToken: [pulp], setDistributor: [f.distributor.address, false], setLocksPaused: [true], setCompoundFee: [200],
      proposeTreasury: [f.owner.address], recoverERC20: [pulp, 1n], recoverExcess: [pulp],
      enableEmergencyExit: [], transferOwnership: [f.stranger.address], renounceOwnership: [],
    };
    expect(Object.keys(hostile).sort()).to.deep.equal([...OWNER].sort());
    for (const name of OWNER.filter((n) => n !== 'renounceOwnership')) {
      await expect(f.vault.connect(f.alice)[name](...hostile[name]), name).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount');
    }

    await f.vault.addRewardToken(pulp);
    await lockBoth(f);
    await f.vault.connect(f.distributor).notifyRewardAmount(pulp, 7n * PULP);
    await f.pulp.connect(f.carol).transfer(vault, 5n); // a mistaken transfer: the only PULP the owner may move
    await mineAt(f.launch + 10n * DAY);
    const aliceLock = await f.vault.locks(f.alice.address);
    const owed = await f.vault.reserved(pulp);
    expect(owed).to.equal(4n * PULP + 7n * PULP);
    // The owner uses every power it has, in the worst order for Alice, and checks nothing owed moved.
    const results = {};
    for (const name of OWNER) {
      try {
        await (await f.vault[name](...hostile[name])).wait();
        results[name] = 'ok';
      } catch (e) {
        results[name] = f.vault.interface.parseError(e.data)?.name ?? 'reverted';
      }
      expect(await f.pulp.balanceOf(vault), `after ${name}`).to.be.greaterThanOrEqual(owed);
      expect(await f.vault.reserved(pulp), `after ${name}`).to.equal(owed);
      const l = await f.vault.locks(f.alice.address);
      expect([l.amount, l.boosted, l.end], `after ${name}`).to.deep.equal([aliceLock.amount, aliceLock.boosted, aliceLock.end]);
    }
    expect(results).to.deep.equal({
      addRewardToken: 'ok', removeRewardToken: 'ok', setDistributor: 'ok', setLocksPaused: 'ok', setCompoundFee: 'ok', proposeTreasury: 'ok',
      recoverERC20: 'ProtectedToken', recoverExcess: 'ok', enableEmergencyExit: 'ok', transferOwnership: 'ok',
      renounceOwnership: 'RenounceDisabled',
    });
    expect(await f.pulp.balanceOf(vault)).to.equal(owed); // only the 5 stray units left
    await expectWithdraw(f, f.alice, 'matured, after every owner power');
    await expectWithdraw(f, f.bob, 'active, after every owner power (exit on)');
  });
});
