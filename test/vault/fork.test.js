// Fork test against Robinhood Chain mainnet (4663). Opt-in: `npm run test:fork` (FORK=1); skipped by `npm test`.
// Deploys a fresh vault on a local fork with the REAL $pulp and WETH, then walks every token path with
// real transfers. Nothing is broadcast: the RPC is only read. Test PULP comes from impersonating the
// Uniswap v4 PoolManager (a large PULP holder) on the fork only.
//
// Hardhat replays the fork under Ethereum (Cancun) rules, not Arbitrum/Orbit ones: no ArbOS precompiles,
// no L1 data fee in gas, and block.number is the L2 number. The vault only uses block.timestamp and plain
// ERC20/WETH9 calls, so token behaviour is what this checks; gas numbers here are not Robinhood Chain fees.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const A = {
  pulp: '0xBc2283d12B1f2f46c1613AE672E95C55b69Ca414',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
};
const WAD = 10n ** 18n;
const DAY = 86400n;
const PULP = 1000n * WAD;
const FEE_BPS = 100n;

const enabled = process.env.FORK === '1';
(enabled ? describe : describe.skip)('PulpVeVault on a Robinhood Chain mainnet fork (real $pulp and WETH)', function () {
  let vault, vaultAddr, pulp, weth, owner, distributor, alice, bob, carol, stranger, treasury, launch;

  const now = async () => BigInt((await ethers.provider.getBlock('latest')).timestamp);
  async function mineAt(t) {
    await network.provider.send('evm_setNextBlockTimestamp', [Number(t)]);
    await network.provider.send('evm_mine');
  }
  // The vault always holds at least what it owes (balance >= reserved). At these checkpoints there are no
  // strays and no unswept releases, so the two are equal, in both real tokens.
  async function expectReserved(label) {
    for (const token of [pulp, weth]) {
      const addr = await token.getAddress();
      expect(await token.balanceOf(vaultAddr), `${label}: balance == reserved here (${addr})`)
        .to.equal(await vault.reserved(addr));
    }
  }
  // Delta of `token` balances across `fn`, for each address in `who`.
  async function deltas(token, who, fn) {
    const before = await Promise.all(who.map((a) => token.balanceOf(a)));
    const result = await fn();
    const after = await Promise.all(who.map((a) => token.balanceOf(a)));
    return { result, d: after.map((x, i) => x - before[i]) };
  }

  before(async function () {
    const { chainId } = await ethers.provider.getNetwork();
    expect(chainId).to.equal(4663n);
    // Calls at the fork block itself count as historical and EDR has no Orbit hardfork table for
    // them; mine one local block so every call runs on local state under the configured Cancun rules.
    await network.provider.send('evm_mine');
    [owner, distributor, alice, bob, carol, stranger] = await ethers.getSigners();
    treasury = ethers.Wallet.createRandom().address;
    pulp = await ethers.getContractAt('@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20', A.pulp);
    weth = new ethers.Contract(A.weth, [
      'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)',
      'function approve(address,uint256) returns (bool)', 'function deposit() payable',
      'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
    ], ethers.provider);
    const meta = new ethers.Contract(A.pulp, ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'], ethers.provider);
    expect(await meta.decimals()).to.equal(18n);
    const block = await ethers.provider.getBlock('latest');
    console.log(`      forked block ${block.number} (${new Date(block.timestamp * 1000).toISOString()}), ` +
      `PULP=${await meta.symbol()}, WETH=${await weth.symbol()}`);

    // Real PULP for the test wallets, from the PoolManager's balance on this fork only.
    await network.provider.send('hardhat_impersonateAccount', [A.poolManager]);
    await network.provider.send('hardhat_setBalance', [A.poolManager, '0x56BC75E2D63100000']);   // 100 ETH for gas
    const pm = await ethers.getSigner(A.poolManager);
    expect(await pulp.balanceOf(A.poolManager)).to.be.greaterThan(100_000n * WAD);
    for (const s of [distributor, alice, bob, carol, stranger]) {
      await (await pulp.connect(pm).transfer(s.address, 20_000n * WAD)).wait();
    }
    await network.provider.send('hardhat_stopImpersonatingAccount', [A.poolManager]);

    launch = ((await now()) / DAY + 1n) * DAY; // the next 00:00 UTC
    vault = await (await ethers.getContractFactory('PulpVeVault')).deploy({
      pulp: A.pulp, weth: A.weth, owner: owner.address, distributor: distributor.address,
      launchStart: launch, earlyWindow: DAY, minLockAmount: PULP,
      compoundFeeBps: FEE_BPS, treasury,
    });
    await vault.waitForDeployment();
    vaultAddr = await vault.getAddress();
    for (const s of [distributor, alice, bob, carol, stranger]) {
      await (await pulp.connect(s).approve(vaultAddr, ethers.MaxUint256)).wait();
    }
    expect(await vault.getRewardTokens()).to.deep.equal([A.weth]);
    await mineAt(launch);
  });

  it('locks real PULP: lock, lockFor, increaseAmount, increaseAmountFor, extend', async function () {
    let r = await deltas(pulp, [alice.address, vaultAddr], async () => (await vault.connect(alice).lock(PULP, 30)).wait());
    expect(r.d).to.deep.equal([-PULP, PULP]);
    // Bob pays, Carol owns.
    r = await deltas(pulp, [bob.address, carol.address, vaultAddr],
      async () => (await vault.connect(bob).lockFor(carol.address, 2n * PULP, 20)).wait());
    expect(r.d).to.deep.equal([-2n * PULP, 0n, 2n * PULP]);
    expect((await vault.locks(carol.address)).amount).to.equal(2n * PULP);
    expect((await vault.locks(bob.address)).amount).to.equal(0n);
    await (await vault.connect(alice).increaseAmount(500n * WAD)).wait();
    r = await deltas(pulp, [bob.address, vaultAddr], async () => (await vault.connect(bob).increaseAmountFor(carol.address, 300n * WAD)).wait());
    expect(r.d).to.deep.equal([-300n * WAD, 300n * WAD]);
    const before = await vault.locks(carol.address);
    await (await vault.connect(carol).extend(30)).wait();
    const after = await vault.locks(carol.address);
    expect(after.end).to.be.greaterThan(before.end);
    expect(after.boosted).to.equal(before.boosted);
    expect(await vault.totalLocked()).to.equal(PULP + 500n * WAD + 2n * PULP + 300n * WAD);
    expect(await pulp.balanceOf(vaultAddr)).to.equal(await vault.totalLocked());
    await expectReserved('after locks');
  });

  it('funds rewards: notifyRewardETH wraps into real WETH; PULP rewards after addRewardToken', async function () {
    const eth = WAD / 10n;
    let r = await deltas(weth, [vaultAddr], async () => (await vault.connect(distributor).notifyRewardETH({ value: eth })).wait());
    expect(r.d).to.deep.equal([eth]);
    expect(await vault.totalNotified(A.weth)).to.equal(eth);
    expect(await ethers.provider.getBalance(vaultAddr)).to.equal(0n);
    // A plain ETH transfer from the distributor funds too; from anyone else it is refused.
    await (await distributor.sendTransaction({ to: vaultAddr, value: eth, gasLimit: 300_000 })).wait();
    await expect(stranger.sendTransaction({ to: vaultAddr, value: eth, gasLimit: 300_000 })).to.be.reverted;
    expect(await weth.balanceOf(vaultAddr)).to.equal(2n * eth);

    await expect(vault.connect(distributor).notifyRewardAmount(A.pulp, PULP)).to.be.revertedWithCustomError(vault, 'NotRewardToken');
    await (await vault.connect(owner).addRewardToken(A.pulp)).wait();
    r = await deltas(pulp, [distributor.address, vaultAddr],
      async () => (await vault.connect(distributor).notifyRewardAmount(A.pulp, 7n * PULP)).wait());
    expect(r.d).to.deep.equal([-7n * PULP, 7n * PULP]);
    await expectReserved('after funding');
  });

  it('claims real WETH and PULP after the funded days close', async function () {
    await mineAt(launch + 9n * DAY);
    for (const s of [alice, carol]) {
      const q = await vault.claimable(s.address, A.weth, 64);
      expect(q.amount).to.be.greaterThan(0n);
      const r = await deltas(weth, [s.address, vaultAddr], async () => (await vault.connect(s).claim(A.weth, 64)).wait());
      expect(r.d).to.deep.equal([q.amount, -q.amount]);
      await expectReserved(`after WETH claim ${s.address}`);
    }
    const q = await vault.claimable(carol.address, A.pulp, 64);
    expect(q.amount).to.be.greaterThan(0n);
    const r = await deltas(pulp, [carol.address, vaultAddr, treasury], async () => (await vault.connect(carol).claim(A.pulp, 64)).wait());
    expect(r.d).to.deep.equal([q.amount, -q.amount, 0n]);   // plain claim: no fee
    await expectReserved('after PULP claim');
  });

  it('compounds real PULP with the fee: the treasury receives PULP, the rest is locked', async function () {
    const q = await vault.claimable(alice.address, A.pulp, 64);
    expect(q.amount).to.be.greaterThan(0n);
    const fee = q.amount * FEE_BPS / 10_000n;
    const lockedBefore = (await vault.locks(alice.address)).amount;
    const r = await deltas(pulp, [alice.address, vaultAddr, treasury], async () => vault.connect(alice).compound(64, FEE_BPS));
    await expect(r.result).to.emit(vault, 'Compounded').withArgs(alice.address, q.amount - fee, fee, q.nextCursor);
    expect(fee).to.be.greaterThan(0n);
    expect(r.d).to.deep.equal([0n, -fee, fee]);
    expect((await vault.locks(alice.address)).amount).to.equal(lockedBefore + q.amount - fee);
    await expectReserved('after compound');
  });

  it('recovers mistaken PULP and WETH transfers, and only those, to the treasury', async function () {
    await (await pulp.connect(stranger).transfer(vaultAddr, 3n * WAD)).wait();
    await (await weth.connect(stranger).deposit({ value: WAD / 100n })).wait();
    await (await weth.connect(stranger).transfer(vaultAddr, WAD / 100n)).wait();
    for (const [token, amount] of [[pulp, 3n * WAD], [weth, WAD / 100n]]) {
      const addr = await token.getAddress();
      expect(await token.balanceOf(vaultAddr)).to.equal(await vault.reserved(addr) + amount);
      const r = await deltas(token, [treasury, vaultAddr, owner.address], async () => (await vault.connect(owner).recoverExcess(addr)).wait());
      expect(r.d).to.deep.equal([amount, -amount, 0n]);
      await expect(vault.connect(owner).recoverExcess(addr)).to.be.revertedWithCustomError(vault, 'NothingToRecover');
    }
    await expectReserved('after recoverExcess');
  });

  it('withdraws real PULP at expiry and leaves only what is still owed', async function () {
    await mineAt(launch + 31n * DAY);
    for (const s of [alice, carol]) {
      const amount = (await vault.locks(s.address)).amount;
      const r = await deltas(pulp, [s.address, vaultAddr], async () => (await vault.connect(s).withdraw()).wait());
      expect(r.d).to.deep.equal([amount, -amount]);
      await expectReserved(`after withdraw ${s.address}`);
    }
    expect(await vault.totalLocked()).to.equal(0n);
    // Remaining balances are exactly the unclaimed rewards (including rounding dust).
    for (const s of [alice, carol]) {
      for (const token of [A.weth, A.pulp]) {
        while (!(await vault.claimable(s.address, token, 64)).caughtUp) await (await vault.connect(s).claim(token, 64)).wait();
        await (await vault.connect(s).claim(token, 64)).wait();
      }
    }
    await expectReserved('after final claims');
    expect(await weth.balanceOf(vaultAddr)).to.be.lessThan(100n);
    expect(await pulp.balanceOf(vaultAddr)).to.be.lessThan(100n);
  });

  it('emergency exit: a second vault lets active real-PULP locks out at once, pays the exit day up to the switch and releases the rest', async function () {
    const start = ((await now()) / DAY + 1n) * DAY;
    const v = await (await ethers.getContractFactory('PulpVeVault')).deploy({
      pulp: A.pulp, weth: A.weth, owner: owner.address, distributor: distributor.address,
      launchStart: start, earlyWindow: DAY, minLockAmount: PULP, compoundFeeBps: FEE_BPS, treasury,
    });
    await v.waitForDeployment();
    const vAddr = await v.getAddress();
    expect(await v.emergencyExit()).to.equal(false);
    // balance >= reserved always; equal at these checkpoints (no strays, every release swept).
    const reservedIsBalance = async (label, excess = {}) => {
      for (const token of [pulp, weth]) {
        const addr = await token.getAddress();
        expect(await token.balanceOf(vAddr), `${label}: balance - reserved (${addr})`).to.equal(await v.reserved(addr) + (excess[addr] ?? 0n));
      }
    };
    for (const s of [distributor, alice, bob, carol]) await (await pulp.connect(s).approve(vAddr, ethers.MaxUint256)).wait();
    await (await v.connect(owner).addRewardToken(A.pulp)).wait();
    await mineAt(start);
    await (await v.connect(alice).lock(PULP, 30)).wait();
    await (await v.connect(carol).lockFor(bob.address, 2n * PULP, 20)).wait();
    await (await v.connect(distributor).notifyRewardETH({ value: WAD / 10n })).wait();
    await (await v.connect(distributor).notifyRewardAmount(A.pulp, 7n * PULP)).wait();
    const today = start / DAY;
    const x = (today + 3n) * DAY + 3600n; // two funded days closed, one hour into the third; weeks left on both locks
    await mineAt(x - 10n);
    await expect(v.connect(alice).withdraw()).to.be.revertedWithCustomError(v, 'LockActive');
    await expect(v.connect(bob).enableEmergencyExit()).to.be.revertedWithCustomError(v, 'OwnableUnauthorizedAccount');
    await network.provider.send('evm_setNextBlockTimestamp', [Number(x)]);
    const tx = await v.connect(owner).enableEmergencyExit();
    await expect(tx).to.emit(v, 'EmergencyExitEnabled');
    expect([await v.exitEpoch(), await v.exitTimestamp()]).to.deep.equal([today + 3n, x]);
    expect(await v.exitDayTotalArea()).to.equal((await v.exitDayArea(alice.address)) + (await v.exitDayArea(bob.address)));
    await expect(v.connect(alice).increaseAmount(PULP)).to.be.revertedWithCustomError(v, 'EmergencyExitActive');
    await expect(v.connect(distributor).notifyRewardETH({ value: 1n })).to.be.revertedWithCustomError(v, 'EmergencyExitActive');
    // The unearned 23 hours of the exit day went back at the switch.
    const atSwitch = { [A.weth]: await v.totalReleased(A.weth), [A.pulp]: await v.totalReleased(A.pulp) };
    expect(atSwitch[A.weth]).to.equal(WAD / 70n - WAD / 70n * 3600n / DAY);
    await reservedIsBalance('after exit', atSwitch);

    // Real PULP leaves at once, exactly the principal; the vault keeps only what is still owed.
    for (const [s, amount] of [[alice, PULP], [bob, 2n * PULP]]) {
      const r = await deltas(pulp, [s.address, vAddr], async () => (await v.connect(s).withdraw()).wait());
      expect(r.d).to.deep.equal([amount, -amount]);
      await reservedIsBalance(`after emergency withdraw ${s.address}`, atSwitch);
    }
    expect(await v.totalLocked()).to.equal(0n);

    // Every day after the exit day was funded but pays nobody: released (WETH day by day, PULP in one
    // call), then (only they, plus the exit day's unearned part) swept to the treasury.
    const released = { ...atSwitch };
    for (let epoch = today + 4n; epoch <= today + 7n; epoch++) {
      const amount = await v.epochRewards(A.weth, epoch);
      if (amount === 0n) continue;
      await (await v.connect(stranger).releaseEmptyRewards(A.weth, epoch)).wait();
      released[A.weth] += amount;
    }
    let pulpAfter = 0n;
    for (let epoch = today + 4n; epoch <= today + 7n; epoch++) pulpAfter += await v.epochRewards(A.pulp, epoch);
    expect(await v.connect(stranger).releasePostExitRewards.staticCall(A.pulp)).to.equal(pulpAfter);
    await (await v.connect(stranger).releasePostExitRewards(A.pulp)).wait();
    released[A.pulp] += pulpAfter;
    for (const token of [A.weth, A.pulp]) {
      await expect(v.releaseEmptyRewards(token, today + 3n)).to.be.revertedWithCustomError(v, 'EpochHasPower'); // the exit day, earned part
      await expect(v.releaseEmptyRewards(token, today + 2n)).to.be.revertedWithCustomError(v, 'EpochHasPower'); // closed, earned
      await expect(v.releasePostExitRewards(token)).to.be.revertedWithCustomError(v, 'NothingToFund');
    }
    for (const token of [pulp, weth]) {
      const addr = await token.getAddress();
      const r = await deltas(token, [treasury, vAddr], async () => (await v.connect(owner).recoverExcess(addr)).wait());
      expect(r.d).to.deep.equal([released[addr], -released[addr]]);
      await expect(v.connect(owner).recoverExcess(addr)).to.be.revertedWithCustomError(v, 'NothingToRecover');
    }
    await reservedIsBalance('after release + sweep');

    // Everything earned before the switch (two closed days and the exit day's first hour) is paid, in real WETH and PULP.
    for (const s of [alice, bob]) {
      for (const [token, addr] of [[weth, A.weth], [pulp, A.pulp]]) {
        const q = await v.claimable(s.address, addr, 64);
        expect(q.amount).to.be.greaterThan(0n);
        expect(q.nextCursor).to.equal(4n); // days today .. today + 3 (the exit day)
        const r = await deltas(token, [s.address], async () => (await v.connect(s).claim(addr, 64)).wait());
        expect(r.d).to.deep.equal([q.amount]);
      }
    }
    await reservedIsBalance('after claims');
    expect(await weth.balanceOf(vAddr)).to.be.lessThan(100n);
    expect(await pulp.balanceOf(vAddr)).to.be.lessThan(100n);
  });
});
