const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const DAY = 86400n;
const WAD = 10n ** 18n;
const MIN_LOCK = 1000n * WAD; // vault minLockAmount used in these tests
const PRICE = 2_000_000n * WAD; // mock pool: 2,000,000 PULP per ETH before tax
const TAX_BPS = 300n;
const HOOKS = '0x4Bc7Ba3a253d048Dc36C17Ac3f4E6484dAD120CC';
const MAX = ethers.MaxUint256;
// Caller bounds for tests that are not about them: no unlock-time bound, any fee up to the 2% cap.
const ANY_END = MAX;
const ANY_FEE = 200;
const NO_LIMIT = 0n; // minSqrtPriceX96 = 0: no caller price limit
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
// selfZap's order tuple: (beneficiary, daysLocked, minPulpOut, minSqrtPriceX96, maxUnlockTime, maxFeeBps, deadline).
const order = (b, days, minOut, ul = ANY_END, fb = ANY_FEE, dl = MAX, lim = NO_LIMIT) => [b, days, minOut, lim, ul, fb, dl];
// The v4 pool id for (ETH, pulp, fee 0, tickSpacing 60, HOOKS): the constructor's expectedPoolId.
const poolIdOf = (pulpAddr, hooks = HOOKS, fee = 0, ts = 60) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder()
  .encode(['address', 'address', 'uint24', 'int24', 'address'], [ethers.ZeroAddress, pulpAddr, fee, ts, hooks]));

const net = (eth, price = PRICE, tax = TAX_BPS) => {
  const gross = (eth * price) / WAD;
  return gross - (gross * tax) / 10_000n;
};

async function mineAt(t) {
  await network.provider.send('evm_setNextBlockTimestamp', [Number(t)]);
  await network.provider.send('evm_mine');
}
async function now() {
  return BigInt((await ethers.provider.getBlock('latest')).timestamp);
}

async function fixture(opts = {}) {
  await network.provider.send('hardhat_reset');
  const [owner, distributor, alice, bob, carol, feeTo, vaultTreasury] = await ethers.getSigners(); // vaultTreasury: the vault's treasury only
  const pulp = await (await ethers.getContractFactory(opts.pulpKind || 'MockERC20')).deploy('PULP', 'PULP', 18);
  const weth = await (await ethers.getContractFactory('MockWETH9')).deploy();
  const block = await ethers.provider.getBlock('latest');
  const launch = (BigInt(block.timestamp) / DAY + 1n) * DAY; // the next 00:00 UTC (the vault requires a multiple of 86400)
  const vault = await (await ethers.getContractFactory('PulpVeVault')).deploy({
    pulp: await pulp.getAddress(), weth: await weth.getAddress(), owner: owner.address,
    distributor: distributor.address, launchStart: launch, earlyWindow: DAY, minLockAmount: MIN_LOCK,
    compoundFeeBps: 0, treasury: vaultTreasury.address, // vault Config fields the zap does not use
  });
  const pm = await (await ethers.getContractFactory('MockPoolManager')).deploy(await pulp.getAddress(), HOOKS, 0, 60, PRICE);
  await pulp.mint(await pm.getAddress(), 10n ** 30n);
  // Default: no fee (the pre-fee tests); fee tests pass opts.feeBps (recipient = feeTo).
  const feeBps = opts.feeBps || 0;
  const zap = await (await ethers.getContractFactory('PulpZap')).deploy(
    await pm.getAddress(), await vault.getAddress(), await weth.getAddress(), HOOKS, 0, 60, poolIdOf(await pulp.getAddress()),
    owner.address, feeBps, feeBps > 0 || opts.withRecipient ? feeTo.address : ethers.ZeroAddress,
  );
  for (const s of [alice, bob, carol]) await pulp.mint(s.address, 10n ** 24n);
  if (!opts.preLaunch) await mineAt(launch + 2n * DAY); // past the early-entry window
  const f = { owner, distributor, alice, bob, carol, feeTo, vaultTreasury, pulp, weth, vault, pm, zap, launch, feeBps: BigInt(feeBps) };
  f.zapAddr = await zap.getAddress();
  f.vaultAddr = await vault.getAddress();
  return f;
}

async function deadline() {
  return (await now()) + 600n;
}

// The zap must never keep ETH, PULP, WETH or a vault allowance after any call.
async function expectClean(f) {
  expect(await ethers.provider.getBalance(f.zapAddr)).to.equal(0n);
  expect(await f.pulp.balanceOf(f.zapAddr)).to.equal(0n);
  expect(await f.weth.balanceOf(f.zapAddr)).to.equal(0n);
  expect(await f.pulp.allowance(f.zapAddr, f.vaultAddr)).to.equal(0n);
  expect(await f.weth.allowance(f.zapAddr, f.vaultAddr)).to.equal(0n);
}

describe('PulpZap (mock PoolManager + real PulpVeVault)', function () {
  describe('deployment', function () {
    it('wires immutables and computes the v4 pool id like PoolIdLibrary', async function () {
      const f = await fixture();
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const id = ethers.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'],
        [ethers.ZeroAddress, await f.pulp.getAddress(), 0, 60, HOOKS]));
      expect(await f.zap.poolId()).to.equal(id);
      expect(await f.pm.poolId()).to.equal(id); // the mock's extsload uses the same id
      expect(await f.zap.sqrtPriceX96()).to.equal(await f.pm.sqrtPriceX96());
      expect(await f.zap.pulp()).to.equal(await f.pulp.getAddress());
      expect(await f.zap.minLockAmount()).to.equal(MIN_LOCK);
      expect(await f.zap.minLockTime()).to.equal(10n * DAY);
      const key = await f.zap.poolKey();
      expect(key.currency0).to.equal(ethers.ZeroAddress);
      expect(key.hooks).to.equal(HOOKS);
    });
    it('rejects non-contract dependencies', async function () {
      const f = await fixture();
      const Zap = await ethers.getContractFactory('PulpZap');
      const id = poolIdOf(await f.pulp.getAddress());
      await expect(Zap.deploy(f.alice.address, f.vaultAddr, await f.weth.getAddress(), HOOKS, 0, 60, id, f.owner.address, 0, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Zap, 'NotAContract');
      await expect(Zap.deploy(await f.pm.getAddress(), f.vaultAddr, f.alice.address, HOOKS, 0, 60, id, f.owner.address, 0, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Zap, 'NotAContract');
    });
    it('GA-4: reverts PoolIdMismatch unless the computed pool id equals expectedPoolId', async function () {
      const f = await fixture();
      const Zap = await ethers.getContractFactory('PulpZap');
      const id = poolIdOf(await f.pulp.getAddress());
      const args = async (expected, ts = 60) => [await f.pm.getAddress(), f.vaultAddr, await f.weth.getAddress(), HOOKS, 0, ts, expected, f.owner.address, 0, ethers.ZeroAddress];
      // Wrong tick spacing (a typo in the deploy config) -> a different pool: caught at deploy.
      await expect(Zap.deploy(...(await args(id, 10)))).to.be.revertedWithCustomError(Zap, 'PoolIdMismatch')
        .withArgs(poolIdOf(await f.pulp.getAddress(), HOOKS, 0, 10), id);
      await expect(Zap.deploy(...(await args(ethers.ZeroHash)))).to.be.revertedWithCustomError(Zap, 'PoolIdMismatch').withArgs(id, ethers.ZeroHash);
      // The real Robinhood id cannot be passed for a mock pool either.
      const real = '0xdd086a556aa997e79d16cde88a6fcda21f615737df3d331ca1af74642e99dc09';
      await expect(Zap.deploy(...(await args(real)))).to.be.revertedWithCustomError(Zap, 'PoolIdMismatch').withArgs(id, real);
      const ok = await Zap.deploy(...(await args(id)));
      expect(await ok.poolId()).to.equal(id);
    });
  });

  describe('zapETH', function () {
    for (const days of [10n, 20n, 30n]) {
      it(`opens a new ${days}-day lock for a beneficiary that is not the caller`, async function () {
        const f = await fixture();
        const eth = WAD / 1000n; // 0.001 ETH -> 1940 PULP net
        const out = net(eth);
        const dl = await deadline();
        const tx = f.zap.connect(f.alice).zapETH(f.bob.address, days, out, NO_LIMIT, ANY_END, ANY_FEE, dl, { value: eth });
        await expect(tx).to.emit(f.zap, 'Zapped');
        await expect(tx).to.emit(f.vault, 'DepositedFor').withArgs(f.zapAddr, f.bob.address, out);
        const r = await (await tx).wait();
        const t = BigInt((await ethers.provider.getBlock(r.blockNumber)).timestamp);
        const l = await f.vault.locks(f.bob.address);
        expect(l.amount).to.equal(out);
        expect(l.end).to.equal(t + days * DAY);
        expect((await f.vault.locks(f.alice.address)).amount).to.equal(0n);
        await expect(tx).to.emit(f.zap, 'Zapped')
          .withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, 0n, out, true, t + days * DAY);
        await expectClean(f);
      });
    }

    it('adds to an existing lock (daysLocked ignored, end unchanged)', async function () {
      const f = await fixture();
      await f.pulp.connect(f.bob).approve(f.vaultAddr, MAX);
      await f.vault.connect(f.bob).lock(5000n * WAD, 30);
      const before = await f.vault.locks(f.bob.address);
      const eth = WAD / 2000n;
      const out = net(eth);
      await expect(f.zap.connect(f.alice).zapETH(f.bob.address, 0, 1n, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth }))
        .to.emit(f.vault, 'Increased');
      const after = await f.vault.locks(f.bob.address);
      expect(after.amount).to.equal(before.amount + out);
      expect(after.end).to.equal(before.end);
      await expectClean(f);
    });

    it('adds when exactly 10 days remain, reverts LockEndsTooSoon one second later', async function () {
      const f = await fixture();
      await f.pulp.connect(f.bob).approve(f.vaultAddr, MAX);
      await f.vault.connect(f.bob).lock(MIN_LOCK, 20);
      const { end } = await f.vault.locks(f.bob.address);
      await mineAt(end - 10n * DAY - 5n);
      await network.provider.send('evm_setNextBlockTimestamp', [Number(end - 10n * DAY)]);
      await f.zap.zapETH(f.bob.address, 10, 1n, NO_LIMIT, ANY_END, ANY_FEE, end, { value: WAD / 1000n });
      await network.provider.send('evm_setNextBlockTimestamp', [Number(end - 10n * DAY + 1n)]);
      await expect(f.zap.zapETH(f.bob.address, 10, 1n, NO_LIMIT, ANY_END, ANY_FEE, end, { value: WAD / 1000n }))
        .to.be.revertedWithCustomError(f.zap, 'LockEndsTooSoon');
      await expectClean(f);
    });

    it('reverts before swapping for an expired-but-not-withdrawn lock', async function () {
      const f = await fixture();
      await f.pulp.connect(f.bob).approve(f.vaultAddr, MAX);
      await f.vault.connect(f.bob).lock(MIN_LOCK, 10);
      const { end } = await f.vault.locks(f.bob.address);
      await mineAt(end);
      await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, end + 100n, { value: WAD / 1000n }))
        .to.be.revertedWithCustomError(f.zap, 'LockExpiredWithdrawFirst');
      // After withdrawing, a fresh lock works.
      await f.vault.connect(f.bob).withdraw();
      await f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, end + 100n, { value: WAD / 1000n });
      expect((await f.vault.locks(f.bob.address)).amount).to.equal(net(WAD / 1000n));
      await expectClean(f);
    });

    it('enforces slippage (minPulpOut is net of the tax) and deadline', async function () {
      const f = await fixture();
      const eth = WAD / 1000n;
      const out = net(eth);
      await expect(f.zap.zapETH(f.bob.address, 10, out + 1n, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth }))
        .to.be.revertedWithCustomError(f.zap, 'InsufficientOutput').withArgs(out, out + 1n);
      await f.pm.setTaxBps(500); // the hook raises its tax after the quote
      await expect(f.zap.zapETH(f.bob.address, 10, out, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth }))
        .to.be.revertedWithCustomError(f.zap, 'InsufficientOutput');
      const t = await now();
      await network.provider.send('evm_setNextBlockTimestamp', [Number(t + 10n)]);
      await expect(f.zap.zapETH(f.bob.address, 10, 1n, NO_LIMIT, ANY_END, ANY_FEE, t + 9n, { value: eth }))
        .to.be.revertedWithCustomError(f.zap, 'DeadlineExpired');
      await expectClean(f);
    });

    it('rejects zero amounts, zero minOut, bad durations, sub-minimum new locks and bad beneficiaries', async function () {
      const f = await fixture();
      const dl = await deadline();
      const v = { value: WAD / 1000n };
      await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, dl)).to.be.revertedWithCustomError(f.zap, 'ZeroAmount');
      await expect(f.zap.zapETH(f.bob.address, 10, 0, NO_LIMIT, ANY_END, ANY_FEE, dl, v)).to.be.revertedWithCustomError(f.zap, 'ZeroMinOut');
      for (const d of [0, 7, 11, 31]) {
        await expect(f.zap.zapETH(f.bob.address, d, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, dl, v)).to.be.revertedWithCustomError(f.zap, 'BadDuration');
      }
      await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK - 1n, NO_LIMIT, ANY_END, ANY_FEE, dl, v))
        .to.be.revertedWithCustomError(f.zap, 'MinOutBelowMinLock');
      for (const b of [ethers.ZeroAddress, f.zapAddr, f.vaultAddr]) {
        await expect(f.zap.zapETH(b, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, dl, v)).to.be.revertedWithCustomError(f.zap, 'InvalidBeneficiary');
      }
      await expectClean(f);
    });

    it('reverts while vault locks are paused or before launch', async function () {
      const f = await fixture();
      await f.vault.connect(f.owner).setLocksPaused(true);
      await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: WAD / 1000n }))
        .to.be.revertedWithCustomError(f.zap, 'LocksPaused');
      const g = await fixture({ preLaunch: true });
      await expect(g.zap.zapETH(g.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: WAD / 1000n }))
        .to.be.revertedWithCustomError(g.zap, 'NotLaunched');
    });

    it('reverts on a partial fill instead of keeping unspent ETH', async function () {
      const f = await fixture();
      await f.pm.setPartialFill(true);
      await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: WAD / 100n }))
        .to.be.revertedWithCustomError(f.zap, 'UnexpectedSwapDelta');
      await expectClean(f);
    });

    it('works as a bridge destination call (caller = executor, ETH forwarded as msg.value)', async function () {
      const f = await fixture();
      const exec = await (await ethers.getContractFactory('MockBridgeExecutor')).deploy();
      const eth = 3n * WAD / 1000n;
      const data = f.zap.interface.encodeFunctionData('zapETH', [f.carol.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline()]);
      await expect(exec.execute(f.zapAddr, data, { value: eth }))
        .to.emit(f.zap, 'Zapped').withArgs(await exec.getAddress(), f.carol.address, ethers.ZeroAddress, eth, 0n, net(eth), true, (v) => v > 0n);
      expect((await f.vault.locks(f.carol.address)).amount).to.equal(net(eth));
      expect(await ethers.provider.getBalance(await exec.getAddress())).to.equal(0n);
      await expectClean(f);
    });
  });

  describe('zapWETH and reward reinvest', function () {
    it('reinvests claimed WETH rewards into the beneficiary\'s existing lock', async function () {
      const f = await fixture();
      await f.pulp.connect(f.bob).approve(f.vaultAddr, MAX);
      await f.vault.connect(f.bob).lock(5000n * WAD, 30);
      await f.vault.connect(f.distributor).notifyRewardETH({ value: WAD / 100n });
      await mineAt((await now()) + 9n * DAY); // all seven reward days closed, 21 days left on the lock
      const claimable = (await f.vault.claimable(f.bob.address, await f.weth.getAddress(), 64)).amount;
      expect(claimable).to.be.greaterThan(0n);
      await f.vault.connect(f.bob).claim(await f.weth.getAddress(), 64);
      expect(await f.weth.balanceOf(f.bob.address)).to.equal(claimable);
      const before = (await f.vault.locks(f.bob.address)).amount;
      await f.weth.connect(f.bob).approve(f.zapAddr, MAX);
      await expect(f.zap.connect(f.bob).zapWETH(f.bob.address, MAX, 0, 1n, NO_LIMIT, ANY_END, ANY_FEE, await deadline()))
        .to.emit(f.zap, 'Zapped')
        .withArgs(f.bob.address, f.bob.address, await f.weth.getAddress(), claimable, 0n, net(claimable), false, (v) => v > 0n);
      expect((await f.vault.locks(f.bob.address)).amount).to.equal(before + net(claimable));
      expect(await f.weth.balanceOf(f.bob.address)).to.equal(0n);
      await expectClean(f);
    });

    it('zaps an explicit WETH amount into a new lock for someone else; needs allowance', async function () {
      const f = await fixture();
      const amt = WAD / 1000n;
      await f.weth.connect(f.alice).deposit({ value: 2n * amt });
      await expect(f.zap.connect(f.alice).zapWETH(f.bob.address, amt, 20, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline())).to.be.reverted;
      await f.weth.connect(f.alice).approve(f.zapAddr, amt);
      await f.zap.connect(f.alice).zapWETH(f.bob.address, amt, 20, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline());
      expect((await f.vault.locks(f.bob.address)).amount).to.equal(net(amt));
      expect(await f.weth.balanceOf(f.alice.address)).to.equal(amt);
      expect(await f.weth.allowance(f.alice.address, f.zapAddr)).to.equal(0n);
      await expectClean(f);
    });

    it('rejects zero WETH (explicit 0 or an empty balance with max) and runs pre-checks before pulling', async function () {
      const f = await fixture();
      await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
      await expect(f.zap.connect(f.alice).zapWETH(f.bob.address, 0, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline()))
        .to.be.revertedWithCustomError(f.zap, 'ZeroAmount');
      await expect(f.zap.connect(f.alice).zapWETH(f.bob.address, MAX, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline()))
        .to.be.revertedWithCustomError(f.zap, 'ZeroAmount');
      await f.weth.connect(f.alice).deposit({ value: WAD / 1000n });
      await expect(f.zap.connect(f.alice).zapWETH(f.bob.address, MAX, 11, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline()))
        .to.be.revertedWithCustomError(f.zap, 'BadDuration');
      await expect(f.zap.connect(f.alice).zapWETH(f.bob.address, MAX, 10, net(WAD / 1000n) + 1n, NO_LIMIT, ANY_END, ANY_FEE, await deadline()))
        .to.be.revertedWithCustomError(f.zap, 'InsufficientOutput');
      expect(await f.weth.balanceOf(f.alice.address)).to.equal(WAD / 1000n);
      await expectClean(f);
    });

    it('bridge executor holding WETH can zap its whole balance with amount = max', async function () {
      const f = await fixture();
      const exec = await (await ethers.getContractFactory('MockBridgeExecutor')).deploy();
      const amt = 7n * WAD / 10_000n;
      await f.weth.connect(f.alice).deposit({ value: amt });
      await f.weth.connect(f.alice).transfer(await exec.getAddress(), amt);
      const data = f.zap.interface.encodeFunctionData('zapWETH', [f.carol.address, MAX, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline()]);
      await exec.executeWithToken(await f.weth.getAddress(), f.zapAddr, data);
      expect((await f.vault.locks(f.carol.address)).amount).to.equal(net(amt));
      expect(await f.weth.balanceOf(await exec.getAddress())).to.equal(0n);
      await expectClean(f);
    });
  });

  describe('reentrancy and access control', function () {
    it('blocks re-entry from the pool during the swap', async function () {
      const f = await fixture();
      const data = f.zap.interface.encodeFunctionData('zapETH', [f.alice.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX]);
      await f.pm.setReenter(f.zapAddr, data);
      await f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: WAD / 1000n });
      expect(await f.pm.reenterAttempted()).to.equal(true);
      expect(await f.pm.reenterSucceeded()).to.equal(false);
      expect((await f.vault.locks(f.alice.address)).amount).to.equal(0n);
      // selfZap is not reachable from the pool either.
      const self = f.zap.interface.encodeFunctionData('selfZap', [f.alice.address, 0, order(f.alice.address, 10, MIN_LOCK)]);
      await f.pm.setReenter(f.zapAddr, self);
      await f.zap.zapETH(f.carol.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: WAD / 1000n });
      expect(await f.pm.reenterSucceeded()).to.equal(false);
      await expectClean(f);
    });

    it('blocks re-entry from a PULP token transfer hook', async function () {
      const f = await fixture({ pulpKind: 'MockReentrantToken' });
      const data = f.zap.interface.encodeFunctionData('zapETH', [f.alice.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX]);
      await f.pulp.configureCallback(f.zapAddr, data, true);
      await f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: WAD / 1000n });
      expect(await f.pulp.attemptedCallbacks()).to.be.greaterThan(0n);
      expect(await f.pulp.succeededCallbacks()).to.equal(0n);
      expect((await f.vault.locks(f.bob.address)).amount).to.equal(net(WAD / 1000n));
      expect((await f.vault.locks(f.alice.address)).amount).to.equal(0n);
      await expectClean(f);
    });

    it('only the PoolManager may call unlockCallback and only the zap may call selfZap', async function () {
      const f = await fixture();
      const data = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1n]);
      await expect(f.zap.unlockCallback(data)).to.be.revertedWithCustomError(f.zap, 'NotPoolManager');
      await expect(f.zap.selfZap(f.alice.address, 0, order(f.bob.address, 10, MIN_LOCK), { value: WAD / 1000n }))
        .to.be.revertedWithCustomError(f.zap, 'OnlySelf');
    });

    it('rejects unexpected ETH from anyone but WETH', async function () {
      const f = await fixture();
      await expect(f.alice.sendTransaction({ to: f.zapAddr, value: 1n }))
        .to.be.revertedWithCustomError(f.zap, 'UnexpectedETH');
      await f.alice.sendTransaction({ to: await f.pm.getAddress(), value: 10n });
      await expect(f.pm.sendEth(f.zapAddr, 1n)).to.be.revertedWithCustomError(f.zap, 'UnexpectedETH');
      await expectClean(f);
    });
  });

  describe('fallback (OrRefund) mode for bridges', function () {
    it('locks normally when everything checks out', async function () {
      const f = await fixture();
      const eth = WAD / 1000n;
      const ret = await f.zap.zapETHOrRefund.staticCall(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth });
      expect(ret.locked).to.equal(true);
      expect(ret.pulpLocked).to.equal(net(eth));
      await expect(f.zap.zapETHOrRefund(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth }))
        .to.emit(f.zap, 'Zapped').and.not.to.emit(f.zap, 'Refunded');
      expect((await f.vault.locks(f.bob.address)).amount).to.equal(net(eth));
      await expectClean(f);
    });

    it('sends the ETH to the beneficiary on slippage, expired deadline or a lock that cannot take more', async function () {
      const f = await fixture();
      const eth = WAD / 1000n;
      const sel = (name) => f.zap.interface.getError(name).selector;
      // slippage
      let bal = await ethers.provider.getBalance(f.bob.address);
      await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth }))
        .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, sel('InsufficientOutput'));
      expect(await ethers.provider.getBalance(f.bob.address)).to.equal(bal + eth);
      // deadline
      bal = await ethers.provider.getBalance(f.bob.address);
      await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, 1n, { value: eth }))
        .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, sel('DeadlineExpired'));
      expect(await ethers.provider.getBalance(f.bob.address)).to.equal(bal + eth);
      // existing lock with < 10 days left
      await f.pulp.connect(f.bob).approve(f.vaultAddr, MAX);
      await f.vault.connect(f.bob).lock(MIN_LOCK, 10);
      await mineAt((await now()) + DAY);
      await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
        .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, sel('LockEndsTooSoon'));
      // pool/hook failure (partial fill)
      await f.pm.setPartialFill(true);
      await expect(f.zap.connect(f.alice).zapETHOrRefund(f.carol.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
        .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.carol.address, ethers.ZeroAddress, eth, sel('UnexpectedSwapDelta'));
      await expectClean(f);
    });

    it('refunds as WETH when the beneficiary cannot receive ETH', async function () {
      const f = await fixture();
      const rej = await (await ethers.getContractFactory('EthRejecter')).deploy();
      const eth = WAD / 1000n;
      await expect(f.zap.zapETHOrRefund(await rej.getAddress(), 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
        .to.emit(f.zap, 'Refunded').withArgs(f.owner.address, await rej.getAddress(), await f.weth.getAddress(), eth, (s) => true);
      expect(await f.weth.balanceOf(await rej.getAddress())).to.equal(eth);
      await expectClean(f);
    });

    it('a beneficiary that re-enters on refund cannot zap again, refund still lands', async function () {
      const f = await fixture();
      const r = await (await ethers.getContractFactory('ReentrantReceiver')).deploy();
      const data = f.zap.interface.encodeFunctionData('zapETH', [f.alice.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX]);
      await r.configure(f.zapAddr, data);
      const eth = WAD / 1000n;
      await f.zap.zapETHOrRefund(await r.getAddress(), 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth });
      expect(await r.attempts()).to.equal(1n);
      expect(await r.successes()).to.equal(0n);
      expect(await ethers.provider.getBalance(await r.getAddress())).to.equal(eth);
      await expectClean(f);
    });

    it('zapWETHOrRefund returns the WETH to the beneficiary on failure and locks on success', async function () {
      const f = await fixture();
      const amt = WAD / 1000n;
      await f.weth.connect(f.alice).deposit({ value: 2n * amt });
      await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
      await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.bob.address, amt, 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, MAX))
        .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, await f.weth.getAddress(), amt, f.zap.interface.getError('InsufficientOutput').selector);
      expect(await f.weth.balanceOf(f.bob.address)).to.equal(amt);
      await expectClean(f);
      await f.zap.connect(f.alice).zapWETHOrRefund(f.carol.address, MAX, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX);
      expect((await f.vault.locks(f.carol.address)).amount).to.equal(net(amt));
      await expectClean(f);
    });

    it('still reverts (nothing taken) for zero value or an unusable beneficiary', async function () {
      const f = await fixture();
      await expect(f.zap.zapETHOrRefund(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX)).to.be.revertedWithCustomError(f.zap, 'ZeroAmount');
      await expect(f.zap.zapETHOrRefund(ethers.ZeroAddress, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: 1n }))
        .to.be.revertedWithCustomError(f.zap, 'InvalidBeneficiary');
      await expect(f.zap.zapETHOrRefund(f.vaultAddr, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: 1n }))
        .to.be.revertedWithCustomError(f.zap, 'InvalidBeneficiary');
      await expect(f.zap.zapWETHOrRefund(f.bob.address, 0, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX)).to.be.revertedWithCustomError(f.zap, 'ZeroAmount');
    });
  });

  describe('checkBeneficiary view', function () {
    it('reports new vs existing lock and mirrors the zap errors', async function () {
      const f = await fixture();
      expect(await f.zap.checkBeneficiary(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END)).to.equal(true);
      await expect(f.zap.checkBeneficiary(f.bob.address, 12, MIN_LOCK, NO_LIMIT, ANY_END)).to.be.revertedWithCustomError(f.zap, 'BadDuration');
      await f.pulp.connect(f.bob).approve(f.vaultAddr, MAX);
      await f.vault.connect(f.bob).lock(MIN_LOCK, 30);
      expect(await f.zap.checkBeneficiary(f.bob.address, 0, 1n, NO_LIMIT, ANY_END)).to.equal(false);
      await mineAt((await now()) + 25n * DAY);
      await expect(f.zap.checkBeneficiary(f.bob.address, 0, 1n, NO_LIMIT, ANY_END)).to.be.revertedWithCustomError(f.zap, 'LockEndsTooSoon');
    });
  });

  describe('zap fee', function () {
    const FEE = 50n; // default deploy intent: 0.5%
    const feeOf = (amt, bps = FEE) => (amt * bps) / 10_000n;
    const zapFactory = () => ethers.getContractFactory('PulpZap');
    async function deployZap(f, owner, bps, recipient) {
      return (await zapFactory()).deploy(await f.pm.getAddress(), f.vaultAddr, await f.weth.getAddress(), HOOKS, 0, 60,
        poolIdOf(await f.pulp.getAddress()), owner, bps, recipient);
    }
    async function feeToBalances(f, who = f.feeTo.address) {
      return { eth: await ethers.provider.getBalance(who), weth: await f.weth.balanceOf(who) };
    }

    describe('constructor, cap and quoteFee', function () {
      it('sets owner, fee and recipient; enforces the cap and a recipient when fee > 0', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        expect(await f.zap.owner()).to.equal(f.owner.address);
        expect(await f.zap.zapFeeBps()).to.equal(FEE);
        expect(await f.zap.feeRecipient()).to.equal(f.feeTo.address);
        expect(await f.zap.MAX_ZAP_FEE_BPS()).to.equal(200n);
        const Zap = await zapFactory();
        await expect(deployZap(f, f.owner.address, 201, f.feeTo.address)).to.be.revertedWithCustomError(Zap, 'FeeTooHigh').withArgs(201);
        await expect(deployZap(f, f.owner.address, 1, ethers.ZeroAddress)).to.be.revertedWithCustomError(Zap, 'InvalidFeeRecipient');
        await expect(deployZap(f, f.owner.address, 50, await f.weth.getAddress())).to.be.revertedWithCustomError(Zap, 'InvalidFeeRecipient');
        await expect(deployZap(f, ethers.ZeroAddress, 50, f.feeTo.address)).to.be.revertedWithCustomError(Zap, 'OwnableInvalidOwner');
        // At the cap, and fee 0 with no recipient, both deploy.
        const capped = await deployZap(f, f.owner.address, 200, f.feeTo.address);
        expect(await capped.zapFeeBps()).to.equal(200n);
        const free = await deployZap(f, f.owner.address, 0, ethers.ZeroAddress);
        expect(await free.feeRecipient()).to.equal(ethers.ZeroAddress);
        await expect(free.deploymentTransaction()).to.emit(free, 'ZapFeeSet').withArgs(0, 0);
        await expect(capped.deploymentTransaction()).to.emit(capped, 'FeeRecipientSet').withArgs(ethers.ZeroAddress, f.feeTo.address);
      });

      it('quoteFee floors, never overflows and returns the full amount as net at fee 0', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const q = async (a) => { const r = await f.zap.quoteFee(a); return [r[0], r[1]]; };
        expect(await q(0n)).to.deep.equal([0n, 0n]);
        expect(await q(1n)).to.deep.equal([0n, 1n]);
        expect(await q(199n)).to.deep.equal([0n, 199n]); // 199 * 50 / 10000 = 0.995 -> 0
        expect(await q(200n)).to.deep.equal([1n, 199n]);
        expect(await q(399n)).to.deep.equal([1n, 398n]);
        expect(await q(10_000n)).to.deep.equal([50n, 9950n]);
        expect(await q(WAD)).to.deep.equal([5n * WAD / 1000n, WAD - 5n * WAD / 1000n]);
        const big = await q(MAX);
        expect(big[0]).to.equal(feeOf(MAX));
        expect(big[0] + big[1]).to.equal(MAX);
        await f.zap.setZapFee(200);
        expect(await q(WAD)).to.deep.equal([WAD / 50n, WAD - WAD / 50n]);
        await f.zap.setZapFee(0);
        expect(await q(WAD)).to.deep.equal([0n, WAD]);
      });
    });

    describe('owner powers', function () {
      it('setZapFee / setFeeRecipient: owner only, capped, non-zero recipient, events', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        await expect(f.zap.connect(f.alice).setZapFee(10)).to.be.revertedWithCustomError(f.zap, 'OwnableUnauthorizedAccount').withArgs(f.alice.address);
        await expect(f.zap.connect(f.alice).setFeeRecipient(f.alice.address)).to.be.revertedWithCustomError(f.zap, 'OwnableUnauthorizedAccount');
        await expect(f.zap.setZapFee(201)).to.be.revertedWithCustomError(f.zap, 'FeeTooHigh').withArgs(201);
        await expect(f.zap.setZapFee(200)).to.emit(f.zap, 'ZapFeeSet').withArgs(50, 200);
        await expect(f.zap.setZapFee(0)).to.emit(f.zap, 'ZapFeeSet').withArgs(200, 0);
        // AC-5: the same deny-list as beneficiaries (zero, the zap, vault, WETH, PULP, PoolManager, hook).
        const bad = [ethers.ZeroAddress, f.zapAddr, f.vaultAddr, await f.weth.getAddress(), await f.pulp.getAddress(), await f.pm.getAddress(), HOOKS];
        for (const b of bad) {
          await expect(f.zap.setFeeRecipient(b)).to.be.revertedWithCustomError(f.zap, 'InvalidFeeRecipient');
          if (b !== ethers.ZeroAddress && b !== f.zapAddr) {
            await expect(deployZap(f, f.owner.address, 50, b)).to.be.revertedWithCustomError(f.zap, 'InvalidFeeRecipient');
          }
        }
        await expect(f.zap.setFeeRecipient(f.carol.address)).to.emit(f.zap, 'FeeRecipientSet').withArgs(f.feeTo.address, f.carol.address);
        expect(await f.zap.feeRecipient()).to.equal(f.carol.address);
      });

      it('a zap deployed without recipient cannot turn the fee on until one is set', async function () {
        const f = await fixture();
        expect(await f.zap.feeRecipient()).to.equal(ethers.ZeroAddress);
        await expect(f.zap.setZapFee(1)).to.be.revertedWithCustomError(f.zap, 'InvalidFeeRecipient');
        await f.zap.setFeeRecipient(f.feeTo.address);
        await expect(f.zap.setZapFee(1)).to.emit(f.zap, 'ZapFeeSet').withArgs(0, 1);
      });

      it('two-step ownership transfer; renounce is disabled', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        await expect(f.zap.renounceOwnership()).to.be.revertedWithCustomError(f.zap, 'RenounceDisabled');
        await expect(f.zap.connect(f.alice).transferOwnership(f.alice.address)).to.be.revertedWithCustomError(f.zap, 'OwnableUnauthorizedAccount');
        await f.zap.transferOwnership(f.alice.address);
        expect(await f.zap.owner()).to.equal(f.owner.address);
        expect(await f.zap.pendingOwner()).to.equal(f.alice.address);
        await expect(f.zap.connect(f.alice).setZapFee(10)).to.be.revertedWithCustomError(f.zap, 'OwnableUnauthorizedAccount');
        await expect(f.zap.connect(f.bob).acceptOwnership()).to.be.revertedWithCustomError(f.zap, 'OwnableUnauthorizedAccount');
        await f.zap.connect(f.alice).acceptOwnership();
        expect(await f.zap.owner()).to.equal(f.alice.address);
        expect(await f.zap.pendingOwner()).to.equal(ethers.ZeroAddress);
        await expect(f.zap.setZapFee(10)).to.be.revertedWithCustomError(f.zap, 'OwnableUnauthorizedAccount');
        await f.zap.connect(f.alice).setZapFee(10);
        expect(await f.zap.zapFeeBps()).to.equal(10n);
      });
    });

    describe('charging', function () {
      it('zapETH: fee in ETH to the recipient, only the rest is swapped, Zapped/FeePaid carry the fee', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const eth = WAD / 1000n + 12_345n; // not a multiple of 10_000: exercises the floor
        const fee = feeOf(eth);
        const [qFee, qNet] = await f.zap.quoteFee(eth);
        expect(qFee).to.equal(fee);
        expect(qNet).to.equal(eth - fee);
        const out = net(eth - fee);
        const before = await feeToBalances(f);
        // minPulpOut computed without the fee is now too tight.
        await expect(f.zap.connect(f.alice).zapETH(f.bob.address, 30, net(eth), NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'InsufficientOutput').withArgs(out, net(eth));
        const tx = f.zap.connect(f.alice).zapETH(f.bob.address, 30, out, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth });
        await expect(tx).to.emit(f.zap, 'FeePaid').withArgs(f.feeTo.address, ethers.ZeroAddress, fee);
        await expect(tx).to.emit(f.zap, 'Zapped')
          .withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, fee, out, true, (v) => v > 0n);
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(out);
        const after = await feeToBalances(f);
        expect(after.eth - before.eth).to.equal(fee);
        expect(after.weth).to.equal(before.weth);
        await expectClean(f);
      });

      it('zapWETH: fee in WETH to the recipient, the rest unwrapped and swapped (explicit amount and max)', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const amt = 3n * WAD / 1000n + 7n;
        const fee = feeOf(amt);
        await f.weth.connect(f.alice).deposit({ value: 2n * amt });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        const before = await feeToBalances(f);
        const tx = f.zap.connect(f.alice).zapWETH(f.bob.address, amt, 10, net(amt - fee), NO_LIMIT, ANY_END, ANY_FEE, await deadline());
        await expect(tx).to.emit(f.zap, 'FeePaid').withArgs(f.feeTo.address, await f.weth.getAddress(), fee);
        await expect(tx).to.emit(f.zap, 'Zapped')
          .withArgs(f.alice.address, f.bob.address, await f.weth.getAddress(), amt, fee, net(amt - fee), true, (v) => v > 0n);
        await expectClean(f);
        // Whole balance into the same lock.
        await f.zap.connect(f.alice).zapWETH(f.bob.address, MAX, 0, 1n, NO_LIMIT, ANY_END, ANY_FEE, await deadline());
        const after = await feeToBalances(f);
        expect(after.weth - before.weth).to.equal(2n * fee);
        expect(after.eth).to.equal(before.eth);
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(2n * net(amt - fee));
        expect(await f.weth.balanceOf(f.alice.address)).to.equal(0n);
        await expectClean(f);
      });

      it('fee at the 2% cap, and through a bridge executor', async function () {
        const f = await fixture({ feeBps: 200 });
        const exec = await (await ethers.getContractFactory('MockBridgeExecutor')).deploy();
        const eth = 3n * WAD / 1000n;
        const fee = eth / 50n;
        const before = await feeToBalances(f);
        const data = f.zap.interface.encodeFunctionData('zapETH', [f.carol.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline()]);
        await expect(exec.execute(f.zapAddr, data, { value: eth }))
          .to.emit(f.zap, 'Zapped').withArgs(await exec.getAddress(), f.carol.address, ethers.ZeroAddress, eth, fee, net(eth - fee), true, (v) => v > 0n);
        expect((await feeToBalances(f)).eth - before.eth).to.equal(fee);
        await expectClean(f);
      });

      it('fee 0 (recipient set): no FeePaid, Zapped fee 0, recipient untouched', async function () {
        const f = await fixture({ withRecipient: true });
        expect(await f.zap.feeRecipient()).to.equal(f.feeTo.address);
        const eth = WAD / 1000n;
        const before = await feeToBalances(f);
        // 20 days, so the WETH top-up below is not hit by LockEndsTooSoon if a second passes between blocks.
        const tx = f.zap.connect(f.alice).zapETH(f.bob.address, 20, net(eth), NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth });
        await expect(tx).to.emit(f.zap, 'Zapped').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, 0n, net(eth), true, (v) => v > 0n);
        await expect(tx).to.not.emit(f.zap, 'FeePaid');
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, eth);
        await expect(f.zap.connect(f.alice).zapWETH(f.bob.address, eth, 0, net(eth), NO_LIMIT, ANY_END, ANY_FEE, await deadline())).to.not.emit(f.zap, 'FeePaid');
        expect(await feeToBalances(f)).to.deep.equal(before);
        await expectClean(f);
      });

      it('a fee raised between quote and execution is caught by minPulpOut', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const eth = WAD / 1000n;
        const quoted = net(eth - feeOf(eth));
        await f.zap.setZapFee(200);
        await expect(f.zap.connect(f.alice).zapETH(f.bob.address, 10, quoted, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'InsufficientOutput');
        await expectClean(f);
      });
    });

    describe('hostile or broken recipients', function () {
      it('a recipient that rejects ETH gets the fee as WETH; the zap still locks', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const rej = await (await ethers.getContractFactory('EthRejecter')).deploy();
        await f.zap.setFeeRecipient(await rej.getAddress());
        const eth = WAD / 1000n;
        const fee = feeOf(eth);
        await expect(f.zap.connect(f.alice).zapETH(f.bob.address, 10, net(eth - fee), NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth }))
          .to.emit(f.zap, 'FeePaid').withArgs(await rej.getAddress(), await f.weth.getAddress(), fee);
        expect(await f.weth.balanceOf(await rej.getAddress())).to.equal(fee);
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(net(eth - fee));
        await expectClean(f);
      });

      it('a recipient that burns all gas is capped and paid in WETH', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const burner = await (await ethers.getContractFactory('GasBurner')).deploy();
        await f.zap.setFeeRecipient(await burner.getAddress());
        const eth = WAD / 1000n;
        const fee = feeOf(eth);
        const tx = await f.zap.connect(f.alice).zapETH(f.bob.address, 10, net(eth - fee), NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth, gasLimit: 3_000_000 });
        await expect(tx).to.emit(f.zap, 'FeePaid').withArgs(await burner.getAddress(), await f.weth.getAddress(), fee);
        expect(await f.weth.balanceOf(await burner.getAddress())).to.equal(fee);
        expect(await ethers.provider.getBalance(await burner.getAddress())).to.equal(0n);
        await expectClean(f);
      });

      it('a recipient cannot re-enter the zap while being paid', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const r = await (await ethers.getContractFactory('ReentrantReceiver')).deploy();
        await r.configure(f.zapAddr, f.zap.interface.encodeFunctionData('zapETH', [f.alice.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX]));
        await f.zap.setFeeRecipient(await r.getAddress());
        const eth = WAD / 1000n;
        const fee = feeOf(eth);
        await f.zap.connect(f.alice).zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth });
        expect(await r.successes()).to.equal(0n);
        const paid = (await ethers.provider.getBalance(await r.getAddress())) + (await f.weth.balanceOf(await r.getAddress()));
        expect(paid).to.equal(fee);
        expect((await f.vault.locks(f.alice.address)).amount).to.equal(0n);
        await expectClean(f);
      });
    });

    describe('OrRefund variants', function () {
      it('zapETHOrRefund: refund returns the whole input (no fee); success charges the fee', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const eth = WAD / 1000n;
        const fee = feeOf(eth);
        const before = await feeToBalances(f);
        const bal = await ethers.provider.getBalance(f.bob.address);
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, f.zap.interface.getError('InsufficientOutput').selector)
          .and.not.to.emit(f.zap, 'FeePaid');
        expect(await ethers.provider.getBalance(f.bob.address)).to.equal(bal + eth);
        expect(await feeToBalances(f)).to.deep.equal(before);
        await expectClean(f);
        // A pool failure after the fee would have been paid is rolled back too.
        await f.pm.setPartialFill(true);
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.carol.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.carol.address, ethers.ZeroAddress, eth, f.zap.interface.getError('UnexpectedSwapDelta').selector);
        expect(await feeToBalances(f)).to.deep.equal(before);
        await f.pm.setPartialFill(false);
        const ret = await f.zap.zapETHOrRefund.staticCall(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth });
        expect(ret.pulpLocked).to.equal(net(eth - fee));
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'FeePaid').withArgs(f.feeTo.address, ethers.ZeroAddress, fee);
        expect((await feeToBalances(f)).eth - before.eth).to.equal(fee);
        await expectClean(f);
      });

      it('zapWETHOrRefund: refund returns the whole WETH (no fee); success charges the fee in WETH', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const amt = WAD / 1000n;
        const fee = feeOf(amt);
        await f.weth.connect(f.alice).deposit({ value: 2n * amt });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        const before = await feeToBalances(f);
        await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.bob.address, amt, 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, MAX))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, await f.weth.getAddress(), amt, (s) => true);
        expect(await f.weth.balanceOf(f.bob.address)).to.equal(amt);
        expect(await feeToBalances(f)).to.deep.equal(before);
        await expectClean(f);
        await f.zap.connect(f.alice).zapWETHOrRefund(f.carol.address, MAX, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX);
        expect((await f.vault.locks(f.carol.address)).amount).to.equal(net(amt - fee));
        expect((await feeToBalances(f)).weth - before.weth).to.equal(fee);
        await expectClean(f);
      });

      it('an ETH-rejecting recipient cannot turn a lock into a refund or trap the input', async function () {
        const f = await fixture({ feeBps: Number(FEE) });
        const rej = await (await ethers.getContractFactory('EthRejecter')).deploy();
        await f.zap.setFeeRecipient(await rej.getAddress());
        const eth = WAD / 1000n;
        const fee = feeOf(eth);
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Zapped').and.not.to.emit(f.zap, 'Refunded');
        expect(await f.weth.balanceOf(await rej.getAddress())).to.equal(fee);
        // On a refund it gets nothing and the beneficiary gets everything.
        const bal = await ethers.provider.getBalance(f.carol.address);
        await f.zap.connect(f.alice).zapETHOrRefund(f.carol.address, 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth });
        expect(await ethers.provider.getBalance(f.carol.address)).to.equal(bal + eth);
        expect(await f.weth.balanceOf(await rej.getAddress())).to.equal(fee);
        await expectClean(f);
      });
    });
  });

  describe('vault emergency exit', function () {
    it('strict zaps revert and OrRefund zaps refund the whole input, no fee, once the vault exit is on', async function () {
      const f = await fixture({ feeBps: 50 });
      const eth = WAD / 1000n;
      await f.pulp.connect(f.bob).approve(f.vaultAddr, MAX);
      await f.vault.connect(f.bob).lock(5000n * WAD, 30);
      await f.weth.connect(f.alice).deposit({ value: 2n * eth });
      await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
      await f.vault.connect(f.owner).enableEmergencyExit();
      const feeBefore = [await ethers.provider.getBalance(f.feeTo.address), await f.weth.balanceOf(f.feeTo.address)];
      const sel = f.vault.interface.getError('EmergencyExitActive').selector;

      // Strict: new lock (carol) and existing lock (bob), ETH and WETH. Everything rolls back.
      for (const who of [f.carol, f.bob]) {
        await expect(f.zap.connect(f.alice).zapETH(who.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline(), { value: eth }))
          .to.be.revertedWithCustomError(f.vault, 'EmergencyExitActive');
        await expect(f.zap.connect(f.alice).zapWETH(who.address, eth, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, await deadline()))
          .to.be.revertedWithCustomError(f.vault, 'EmergencyExitActive');
      }
      expect(await f.weth.balanceOf(f.alice.address)).to.equal(2n * eth);
      await expectClean(f);

      // OrRefund: the beneficiary gets the whole input back, with the vault's error as the reason.
      const bal = await ethers.provider.getBalance(f.carol.address);
      await expect(f.zap.connect(f.alice).zapETHOrRefund(f.carol.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
        .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.carol.address, ethers.ZeroAddress, eth, sel)
        .and.not.to.emit(f.zap, 'FeePaid');
      expect(await ethers.provider.getBalance(f.carol.address)).to.equal(bal + eth);
      await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.bob.address, eth, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX))
        .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, await f.weth.getAddress(), eth, sel)
        .and.not.to.emit(f.zap, 'FeePaid');
      expect(await f.weth.balanceOf(f.bob.address)).to.equal(eth);
      expect([await ethers.provider.getBalance(f.feeTo.address), await f.weth.balanceOf(f.feeTo.address)]).to.deep.equal(feeBefore);
      expect((await f.vault.locks(f.carol.address)).amount).to.equal(0n);
      expect((await f.vault.locks(f.bob.address)).amount).to.equal(5000n * WAD);
      await expectClean(f);

      // And the existing lock can leave at once.
      await f.vault.connect(f.bob).withdraw();
      expect(await f.vault.totalLocked()).to.equal(0n);
    });
  });

  describe('review fixes (review 1, docs/SECURITY.md)', function () {
    const sel = (f, name) => f.zap.interface.getError(name).selector;

    describe('L-1: Zapped.caller is the real caller on the OrRefund path', function () {
      it('PoC P1: zapETHOrRefund / zapWETHOrRefund report the caller, direct and through a bridge executor', async function () {
        const f = await fixture();
        const eth = WAD / 1000n;
        const wethAddr = await f.weth.getAddress();
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Zapped').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, 0n, net(eth), true, (v) => v > 0n);
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.carol.address, eth, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX))
          .to.emit(f.zap, 'Zapped').withArgs(f.alice.address, f.carol.address, wethAddr, eth, 0n, net(eth), true, (v) => v > 0n);
        const exec = await (await ethers.getContractFactory('MockBridgeExecutor')).deploy();
        const execAddr = await exec.getAddress();
        const data = f.zap.interface.encodeFunctionData('zapETHOrRefund', [f.owner.address, 20, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX]);
        await expect(exec.execute(f.zapAddr, data, { value: eth }))
          .to.emit(f.zap, 'Zapped').withArgs(execAddr, f.owner.address, ethers.ZeroAddress, eth, 0n, net(eth), true, (v) => v > 0n);
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).transfer(execAddr, eth);
        const wdata = f.zap.interface.encodeFunctionData('zapWETHOrRefund', [f.distributor.address, eth, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX]);
        await expect(exec.executeWithToken(wethAddr, f.zapAddr, wdata))
          .to.emit(f.zap, 'Zapped').withArgs(execAddr, f.distributor.address, wethAddr, eth, 0n, net(eth), true, (v) => v > 0n);
        await expectClean(f);
      });
    });

    describe('M-1: maxUnlockTime', function () {
      it('PoC P2: a planted 30-day lock makes a 10-day strict zap revert and the OrRefund zap refund', async function () {
        const f = await fixture();
        const mallory = f.carol;
        await f.pulp.connect(mallory).approve(f.vaultAddr, MAX);
        await f.vault.connect(mallory).lockFor(f.alice.address, MIN_LOCK, 30); // the front-run, ~0.0005 ETH of PULP
        const { end } = await f.vault.locks(f.alice.address);
        const eth = WAD / 10n;
        const bound = (await now()) + 10n * DAY + 3600n; // frontend: now + 10 days + 1h slack
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);

        // Strict: fails before swapping (with a partial-filling pool a swap would revert UnexpectedSwapDelta).
        await f.pm.setPartialFill(true);
        await expect(f.zap.connect(f.alice).zapETH(f.alice.address, 10, MIN_LOCK, NO_LIMIT, bound, ANY_FEE, MAX, { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'UnlockTooLate').withArgs(end, bound);
        await expect(f.zap.connect(f.alice).zapWETH(f.alice.address, eth, 10, MIN_LOCK, NO_LIMIT, bound, ANY_FEE, MAX))
          .to.be.revertedWithCustomError(f.zap, 'UnlockTooLate').withArgs(end, bound);
        await expect(f.zap.checkBeneficiary(f.alice.address, 10, MIN_LOCK, NO_LIMIT, bound))
          .to.be.revertedWithCustomError(f.zap, 'UnlockTooLate').withArgs(end, bound);
        await f.pm.setPartialFill(false);

        // OrRefund: the whole input goes back to the beneficiary with the reason.
        const bal = await ethers.provider.getBalance(f.alice.address);
        await expect(f.zap.connect(f.bob).zapETHOrRefund(f.alice.address, 10, MIN_LOCK, NO_LIMIT, bound, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Refunded').withArgs(f.bob.address, f.alice.address, ethers.ZeroAddress, eth, sel(f, 'UnlockTooLate'));
        expect(await ethers.provider.getBalance(f.alice.address)).to.equal(bal + eth);
        await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.alice.address, eth, 10, MIN_LOCK, NO_LIMIT, bound, ANY_FEE, MAX))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.alice.address, await f.weth.getAddress(), eth, sel(f, 'UnlockTooLate'));
        expect(await f.weth.balanceOf(f.alice.address)).to.equal(eth);
        expect((await f.vault.locks(f.alice.address)).amount).to.equal(MIN_LOCK); // nothing was absorbed

        // An informed top-up (bound = the displayed end) goes through.
        await f.zap.connect(f.alice).zapETH(f.alice.address, 0, 1n, NO_LIMIT, end, ANY_FEE, MAX, { value: eth });
        expect((await f.vault.locks(f.alice.address)).amount).to.equal(MIN_LOCK + net(eth));
        expect((await f.vault.locks(f.alice.address)).end).to.equal(end);
        await expectClean(f);
      });

      it('new lock: passes with bound = now + days exactly, fails one second below', async function () {
        const f = await fixture();
        const eth = WAD / 1000n;
        const t = (await now()) + 10n;
        await network.provider.send('evm_setNextBlockTimestamp', [Number(t)]);
        await expect(f.zap.zapETH(f.bob.address, 20, MIN_LOCK, NO_LIMIT, t + 20n * DAY - 1n, ANY_FEE, MAX, { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'UnlockTooLate').withArgs(t + 20n * DAY, t + 20n * DAY - 1n);
        const t2 = t + 10n;
        await network.provider.send('evm_setNextBlockTimestamp', [Number(t2)]);
        await expect(f.zap.zapETH(f.bob.address, 20, MIN_LOCK, NO_LIMIT, t2 + 20n * DAY, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Zapped').withArgs(f.owner.address, f.bob.address, ethers.ZeroAddress, eth, 0n, net(eth), true, t2 + 20n * DAY);
        // checkBeneficiary mirrors it for an existing lock.
        expect(await f.zap.checkBeneficiary(f.bob.address, 0, 1n, NO_LIMIT, t2 + 20n * DAY)).to.equal(false);
        await expect(f.zap.checkBeneficiary(f.bob.address, 0, 1n, NO_LIMIT, t2 + 20n * DAY - 1n))
          .to.be.revertedWithCustomError(f.zap, 'UnlockTooLate');
        await expectClean(f);
      });

      it('re-checks the recorded lock end after the vault call (lock extended during the swap)', async function () {
        const f = await fixture();
        // A contract wallet (the mock executor) with its own 20-day lock.
        const w = await (await ethers.getContractFactory('MockBridgeExecutor')).deploy();
        const wAddr = await w.getAddress();
        await f.pulp.mint(wAddr, MIN_LOCK);
        await w.executeWithToken(await f.pulp.getAddress(), f.vaultAddr, f.vault.interface.encodeFunctionData('lock', [MIN_LOCK, 20]));
        const { end } = await f.vault.locks(wAddr);
        expect(await f.zap.checkBeneficiary(wAddr, 0, 1n, NO_LIMIT, end)).to.equal(false); // the preflight is happy
        // During the swap the wallet extends its own lock to 30 days.
        const extend = w.interface.encodeFunctionData('execute', [f.vaultAddr, f.vault.interface.encodeFunctionData('extend', [30])]);
        await f.pm.setReenter(wAddr, extend);
        const eth = WAD / 1000n;
        // lockEnd > end in the error proves the extension ran mid-swap and the post-vault check caught it.
        await expect(f.zap.zapETH(wAddr, 0, 1n, NO_LIMIT, end, ANY_FEE, MAX, { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'UnlockTooLate').withArgs((v) => v > end, end);
        await expect(f.zap.connect(f.alice).zapETHOrRefund(wAddr, 0, 1n, NO_LIMIT, end, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, wAddr, ethers.ZeroAddress, eth, sel(f, 'UnlockTooLate'));
        expect((await f.vault.locks(wAddr)).end).to.equal(end); // the extension was rolled back with the hop
        expect((await f.vault.locks(wAddr)).amount).to.equal(MIN_LOCK);
        expect(await ethers.provider.getBalance(wAddr)).to.equal(eth);
        await expectClean(f);
      });
    });

    describe('L-5: maxFeeBps', function () {
      it('strict zaps revert and OrRefund zaps refund (no fee) when the fee is above the caller bound', async function () {
        const f = await fixture({ feeBps: 50 });
        const eth = WAD / 1000n;
        const wethAddr = await f.weth.getAddress();
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        const feeBefore = [await ethers.provider.getBalance(f.feeTo.address), await f.weth.balanceOf(f.feeTo.address)];
        await f.pm.setPartialFill(true); // checked before the swap
        await expect(f.zap.connect(f.alice).zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, 49, MAX, { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'FeeAboveMax').withArgs(50, 49);
        await expect(f.zap.connect(f.alice).zapWETH(f.bob.address, eth, 10, MIN_LOCK, NO_LIMIT, ANY_END, 0, MAX))
          .to.be.revertedWithCustomError(f.zap, 'FeeAboveMax').withArgs(50, 0);
        await f.pm.setPartialFill(false);

        // The owner front-runs with a raise to the 2% cap; the user's quote assumed 50 bps.
        await f.zap.setZapFee(200);
        const bal = await ethers.provider.getBalance(f.bob.address);
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, 50, MAX, { value: eth }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, sel(f, 'FeeAboveMax'))
          .and.not.to.emit(f.zap, 'FeePaid');
        expect(await ethers.provider.getBalance(f.bob.address)).to.equal(bal + eth);
        await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.bob.address, eth, 10, MIN_LOCK, NO_LIMIT, ANY_END, 50, MAX))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, wethAddr, eth, sel(f, 'FeeAboveMax'));
        expect(await f.weth.balanceOf(f.bob.address)).to.equal(eth);
        expect([await ethers.provider.getBalance(f.feeTo.address), await f.weth.balanceOf(f.feeTo.address)]).to.deep.equal(feeBefore);
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(0n);

        // At exactly the bound it goes through.
        await expect(f.zap.connect(f.alice).zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, 200, MAX, { value: eth }))
          .to.emit(f.zap, 'FeePaid').withArgs(f.feeTo.address, ethers.ZeroAddress, eth / 50n);
        await expectClean(f);
      });
    });

    describe('L-3: dangling sync', function () {
      it('the mock models v4: settle{value} after a dangling sync(PULP) reverts NonzeroNativeValue', async function () {
        const f = await fixture();
        const naive = await (await ethers.getContractFactory('NaiveSettler')).deploy(await f.pm.getAddress());
        await expect(naive.run({ value: 1n })).to.be.revertedWithCustomError(f.pm, 'NonzeroNativeValue');
      });

      it('a sync(PULP) left dangling inside the unlock window (hook or forwarded party) no longer breaks zaps', async function () {
        const f = await fixture();
        await f.pm.setReenter(await f.pm.getAddress(), f.pm.interface.encodeFunctionData('sync', [await f.pulp.getAddress()]));
        const eth = WAD / 1000n;
        await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth })).to.emit(f.zap, 'Zapped');
        expect(await f.pm.reenterAttempted()).to.equal(true);
        expect(await f.pm.reenterSucceeded()).to.equal(true); // PULP really was synced mid-swap
        await expect(f.zap.zapETHOrRefund(f.carol.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Zapped').and.not.to.emit(f.zap, 'Refunded');
        expect((await f.vault.locks(f.carol.address)).amount).to.equal(net(eth));
        await expectClean(f);
      });
    });

    describe('L-2: unusable beneficiaries', function () {
      it('PoC P5: WETH, PULP, PoolManager, hook, vault, zap and zero are rejected everywhere; nothing is stranded', async function () {
        const f = await fixture();
        const eth = WAD / 1000n;
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        const bad = [await f.weth.getAddress(), await f.pulp.getAddress(), await f.pm.getAddress(), HOOKS, f.vaultAddr, f.zapAddr, ethers.ZeroAddress];
        for (const b of bad) {
          await expect(f.zap.connect(f.alice).zapETH(b, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
            .to.be.revertedWithCustomError(f.zap, 'InvalidBeneficiary');
          // P5 itself: an impossible minOut used to refund into WETH.receive and strand the ETH in the zap as WETH.
          await expect(f.zap.connect(f.alice).zapETHOrRefund(b, 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
            .to.be.revertedWithCustomError(f.zap, 'InvalidBeneficiary');
          await expect(f.zap.connect(f.alice).zapWETH(b, eth, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX))
            .to.be.revertedWithCustomError(f.zap, 'InvalidBeneficiary');
          await expect(f.zap.connect(f.alice).zapWETHOrRefund(b, eth, 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, MAX))
            .to.be.revertedWithCustomError(f.zap, 'InvalidBeneficiary');
          await expect(f.zap.checkBeneficiary(b, 10, MIN_LOCK, NO_LIMIT, ANY_END)).to.be.revertedWithCustomError(f.zap, 'InvalidBeneficiary');
        }
        expect(await f.weth.balanceOf(f.alice.address)).to.equal(eth);
        await expectClean(f);
      });
    });

    describe('L-4: refunds under hostile beneficiaries and low gas', function () {
      it('a gas-burning beneficiary gets the refund as WETH instead of making the call revert', async function () {
        const f = await fixture();
        const burner = await (await ethers.getContractFactory('GasBurner')).deploy();
        const b = await burner.getAddress();
        const eth = WAD / 1000n;
        await expect(f.zap.connect(f.alice).zapETHOrRefund(b, 10, 10n ** 30n, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth, gasLimit: 5_000_000 }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, b, await f.weth.getAddress(), eth, sel(f, 'InsufficientOutput'));
        expect(await f.weth.balanceOf(b)).to.equal(eth);
        expect(await ethers.provider.getBalance(b)).to.equal(0n);
        await expectClean(f);
      });
    });

    describe('I-1: sweep', function () {
      it('anyone can push ETH in through WETH withdrawTo; zaps ignore strays; the owner sweeps ETH, WETH and PULP to the treasury', async function () {
        const f = await fixture({ withRecipient: true });
        const amt = WAD / 1000n;
        const wethAddr = await f.weth.getAddress();
        const pulpAddr = await f.pulp.getAddress();
        await f.weth.connect(f.alice).deposit({ value: 2n * amt });
        await f.weth.connect(f.alice).withdrawTo(f.zapAddr, amt); // passes receive(): msg.sender == WETH
        await f.weth.connect(f.alice).transfer(f.zapAddr, amt);
        await f.pulp.connect(f.alice).transfer(f.zapAddr, 5n * WAD);
        expect(await ethers.provider.getBalance(f.zapAddr)).to.equal(amt);
        // Every amount comes from msg.value or a measured delta, so strays neither help nor hurt a zap.
        await f.zap.connect(f.bob).zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: amt });
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(net(amt));
        expect(await ethers.provider.getBalance(f.zapAddr)).to.equal(amt);

        // AC-6: the destination is always the fee recipient (treasury), not an argument.
        const to = f.feeTo.address;
        const ethBefore = await ethers.provider.getBalance(to);
        await expect(f.zap.sweep(ethers.ZeroAddress)).to.emit(f.zap, 'Swept').withArgs(ethers.ZeroAddress, to, amt);
        expect(await ethers.provider.getBalance(to)).to.equal(ethBefore + amt);
        await expect(f.zap.sweep(wethAddr)).to.emit(f.zap, 'Swept').withArgs(wethAddr, to, amt);
        expect(await f.weth.balanceOf(to)).to.equal(amt);
        const pulpBefore = await f.pulp.balanceOf(to);
        await expect(f.zap.sweep(pulpAddr)).to.emit(f.zap, 'Swept').withArgs(pulpAddr, to, 5n * WAD);
        expect(await f.pulp.balanceOf(to)).to.equal(pulpBefore + 5n * WAD);
        await expect(f.zap.sweep(ethers.ZeroAddress)).to.emit(f.zap, 'Swept').withArgs(ethers.ZeroAddress, to, 0n);
        // Moving the fee recipient moves the sweep destination with it (and emits FeeRecipientSet).
        await f.pulp.connect(f.alice).transfer(f.zapAddr, 1n);
        await f.zap.setFeeRecipient(f.carol.address);
        await expect(f.zap.sweep(pulpAddr)).to.emit(f.zap, 'Swept').withArgs(pulpAddr, f.carol.address, 1n);
        await expectClean(f);
      });

      it('owner only; reverts while no fee recipient is set; force-sent ETH is sweepable too', async function () {
        const f = await fixture(); // fee 0, no recipient
        await network.provider.send('hardhat_setBalance', [f.zapAddr, '0x1000']); // stands in for selfdestruct
        await expect(f.zap.connect(f.alice).sweep(ethers.ZeroAddress))
          .to.be.revertedWithCustomError(f.zap, 'OwnableUnauthorizedAccount').withArgs(f.alice.address);
        await expect(f.zap.sweep(ethers.ZeroAddress)).to.be.revertedWithCustomError(f.zap, 'InvalidRecipient');
        await f.zap.setFeeRecipient(f.bob.address);
        await expect(f.zap.sweep(ethers.ZeroAddress)).to.emit(f.zap, 'Swept').withArgs(ethers.ZeroAddress, f.bob.address, 0x1000n);
        await expectClean(f);
      });

      it('cannot run inside a zap, even for an owner contract that is also the fee recipient', async function () {
        const f = await fixture({ feeBps: 50 });
        const r = await (await ethers.getContractFactory('ReentrantReceiver')).deploy();
        const rAddr = await r.getAddress();
        await f.zap.setFeeRecipient(rAddr);
        await f.zap.transferOwnership(rAddr);
        await r.configure(f.zapAddr, f.zap.interface.encodeFunctionData('acceptOwnership'));
        await f.alice.sendTransaction({ to: rAddr, value: 1n }); // r's receive() accepts ownership
        expect(await f.zap.owner()).to.equal(rAddr);
        // While being paid the fee (the zap is holding the rest of msg.value), r tries to sweep all ETH to itself.
        await r.configure(f.zapAddr, f.zap.interface.encodeFunctionData('sweep', [ethers.ZeroAddress]));
        const eth = WAD / 1000n;
        const fee = (eth * 50n) / 10_000n;
        const before = await ethers.provider.getBalance(rAddr);
        await f.zap.connect(f.alice).zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth });
        expect(await r.attempts()).to.equal(2n);
        expect(await r.successes()).to.equal(1n); // only the acceptOwnership
        const got = (await ethers.provider.getBalance(rAddr)) - before + (await f.weth.balanceOf(rAddr));
        expect(got).to.equal(fee);
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(net(eth - fee));
        await expectClean(f);
      });
    });

    describe('I-2: emergency-exit pre-check', function () {
      it('checkBeneficiary and every entry point fail before swapping once the vault exit is on', async function () {
        const f = await fixture();
        const eth = WAD / 1000n;
        expect(sel(f, 'EmergencyExitActive')).to.equal(f.vault.interface.getError('EmergencyExitActive').selector);
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        await f.vault.connect(f.owner).enableEmergencyExit();
        await f.pm.setPartialFill(true); // a swap would revert UnexpectedSwapDelta; the pre-check fires first
        await expect(f.zap.checkBeneficiary(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END)).to.be.revertedWithCustomError(f.zap, 'EmergencyExitActive');
        await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'EmergencyExitActive');
        await expect(f.zap.connect(f.alice).zapWETH(f.bob.address, eth, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX))
          .to.be.revertedWithCustomError(f.zap, 'EmergencyExitActive');
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, sel(f, 'EmergencyExitActive'));
        await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.bob.address, eth, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, await f.weth.getAddress(), eth, sel(f, 'EmergencyExitActive'));
        await expectClean(f);
      });
    });
  });

  describe('audit 2026-10-10 fixes', function () {
    const sel = (f, name) => f.zap.interface.getError(name).selector;
    // Outcome of an OrRefund staticCall/send: 'gas' (reverted InsufficientGas), 'refund' or 'lock'. Anything else throws.
    async function outcome(f, p) {
      try {
        const r = await p;
        return r.locked ? 'lock' : 'refund';
      } catch (e) {
        const parsed = e.data && e.data !== '0x' ? f.zap.interface.parseError(e.data) : null;
        if (!parsed || parsed.name !== 'InsufficientGas') throw e;
        return 'gas';
      }
    }
    // What eth_estimateGas needs: below some gas limit the call reverts, above it the outcome never changes.
    function expectMonotone(seq, label) {
      const first = seq.findIndex((o) => o !== 'gas');
      expect(first, `${label}: never succeeded`).to.be.greaterThan(0);
      const tail = new Set(seq.slice(first));
      expect([...tail], `${label}: ${seq.join(',')}`).to.have.lengthOf(1);
      return seq[first];
    }
    async function sweepOutcomes(f, call, from = 100_000n, to = 3_000_000n, step = 20_000n) {
      const seq = [];
      for (let g = from; g <= to; g += step) seq.push(await outcome(f, call(g)));
      return seq;
    }
    async function sendAndName(f, txPromise) {
      const r = await (await txPromise).wait();
      const names = r.logs.map((l) => { try { return f.zap.interface.parseLog(l).name; } catch { return null; } });
      return names.find((n) => n === 'Zapped' || n === 'Refunded');
    }

    describe('M-B (CB-1, E2E-1): a hop that ran out of gas reverts InsufficientGas instead of refunding', function () {
      it('a relayer that supplies too little gas for the lock: InsufficientGas, nothing taken, no refund', async function () {
        const f = await fixture();
        const eth = WAD / 1000n;
        const need = await f.zap.zapETHOrRefund.estimateGas(f.bob.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth });
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth, gasLimit: need / 2n }))
          .to.be.revertedWithCustomError(f.zap, 'InsufficientGas');
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.bob.address, eth, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { gasLimit: need / 2n }))
          .to.be.revertedWithCustomError(f.zap, 'InsufficientGas');
        expect(await f.weth.balanceOf(f.alice.address)).to.equal(eth); // the pull was rolled back too
        // Below the reserve it reverts up front, as before.
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth, gasLimit: 250_000 }))
          .to.be.revertedWithCustomError(f.zap, 'InsufficientGas');
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(0n);
        expect(await f.weth.balanceOf(f.bob.address)).to.equal(0n);
        await expectClean(f);
      });

      it('gas sweep (gas-burning beneficiary): a lockable order goes InsufficientGas -> lock, an impossible one InsufficientGas -> refund, never mixed', async function () {
        const f = await fixture({ feeBps: 50 });
        // Worst-case beneficiary for the ETH refund: burns the whole REFUND_ETH_GAS, then gets WETH as a fresh holder.
        const burner = await (await ethers.getContractFactory('GasBurner')).deploy();
        const b = await burner.getAddress();
        const eth = WAD / 1000n;
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        for (const [minOut, want] of [[MIN_LOCK, 'lock'], [10n ** 30n, 'refund']]) {
          const calls = {
            eth: (g) => f.zap.connect(f.alice).zapETHOrRefund.staticCall(b, 30, minOut, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth, gasLimit: g }),
            weth: (g) => f.zap.connect(f.alice).zapWETHOrRefund.staticCall(b, eth, 30, minOut, NO_LIMIT, ANY_END, ANY_FEE, MAX, { gasLimit: g }),
          };
          for (const [kind, call] of Object.entries(calls)) {
            const seq = await sweepOutcomes(f, call);
            expect(expectMonotone(seq, `${kind} ${want}`), kind).to.equal(want);
          }
        }
      });

      it('eth_estimateGas on the OrRefund call itself lands on the lock: new 10- and 30-day locks and a top-up, ETH and WETH, sent at exactly the estimate', async function () {
        const f = await fixture({ feeBps: 50 });
        // Off the 00:00 UTC boundary: a new lock made exactly at 00:00 schedules one day less than one made a
        // second later, so an estimate taken at 00:00:00 can be ~70k short a second later (why bridges add headroom).
        // Also off the vault's 10-minute end buckets: a lock whose end falls on a multiple of 600 s writes zero to
        // the bucket's boostedR/boostedR2 slots (end % 600 == 0), ~40k cheaper than one a second later. With
        // allowBlocksWithSameTimestamp the estimate can run at exactly that second, so use 01:05:00, not 01:00:00.
        await mineAt((await now()) + 3600n + 300n);
        const eth = WAD / 1000n;
        const users = [f.bob, f.carol, f.distributor];
        await f.weth.connect(f.alice).deposit({ value: 10n * eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        const est = {};
        const cases = [
          ['ETH new 10-day', users[0], 10, () => [{ value: eth }], 'zapETHOrRefund'],
          ['ETH new 30-day', users[1], 30, () => [{ value: eth }], 'zapETHOrRefund'],
          ['ETH top-up', users[1], 0, () => [{ value: eth }], 'zapETHOrRefund'],
          ['WETH new 30-day', users[2], 30, () => [{}], 'zapWETHOrRefund'],
          ['WETH top-up', users[2], 0, () => [{}], 'zapWETHOrRefund'],
        ];
        for (const [label, who, days, ov, fn] of cases) {
          const args = fn === 'zapETHOrRefund'
            ? [who.address, days, 1n * WAD, NO_LIMIT, ANY_END, 50, MAX]
            : [who.address, eth, days, 1n * WAD, NO_LIMIT, ANY_END, 50, MAX];
          if (days !== 0) args[fn === 'zapETHOrRefund' ? 2 : 3] = MIN_LOCK;
          const gas = await f.zap.connect(f.alice)[fn].estimateGas(...args, ...ov());
          est[label] = gas;
          const name = await sendAndName(f, f.zap.connect(f.alice)[fn](...args, { ...ov()[0], gasLimit: gas }));
          expect(name, `${label} at the estimate ${gas}`).to.equal('Zapped');
        }
        console.log(`      OrRefund estimates (mock pool): ${Object.entries(est).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        expect((await f.vault.locks(users[1].address)).amount).to.equal(2n * net(eth - eth / 200n));
        await expectClean(f);
      });

      it('impossible minOut: the estimate is a genuine refund and sending at exactly the estimate refunds', async function () {
        const f = await fixture({ feeBps: 50 });
        // Off the 00:00 UTC boundary: a new lock made exactly at 00:00 schedules one day less than one made a
        // second later, so an estimate taken at 00:00:00 can be ~70k short a second later (why bridges add headroom).
        // Also off the vault's 10-minute end buckets: a lock whose end falls on a multiple of 600 s writes zero to
        // the bucket's boostedR/boostedR2 slots (end % 600 == 0), ~40k cheaper than one a second later. With
        // allowBlocksWithSameTimestamp the estimate can run at exactly that second, so use 01:05:00, not 01:00:00.
        await mineAt((await now()) + 3600n + 300n);
        const eth = WAD / 1000n;
        const args = [f.bob.address, 30, 10n ** 30n, NO_LIMIT, ANY_END, 50, MAX];
        const gas = await f.zap.connect(f.alice).zapETHOrRefund.estimateGas(...args, { value: eth });
        const bal = await ethers.provider.getBalance(f.bob.address);
        await expect(f.zap.connect(f.alice).zapETHOrRefund(...args, { value: eth, gasLimit: gas }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, sel(f, 'InsufficientOutput'));
        expect(await ethers.provider.getBalance(f.bob.address)).to.equal(bal + eth);
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        const wargs = [f.bob.address, eth, 30, 10n ** 30n, NO_LIMIT, ANY_END, 50, MAX];
        const wgas = await f.zap.connect(f.alice).zapWETHOrRefund.estimateGas(...wargs);
        await expect(f.zap.connect(f.alice).zapWETHOrRefund(...wargs, { gasLimit: wgas }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, await f.weth.getAddress(), eth, sel(f, 'InsufficientOutput'));
        await expectClean(f);
      });

      it('out of gas deep inside the pool (an expensive hook four calls below the hop) is InsufficientGas too; the estimate still locks', async function () {
        const f = await fixture();
        // Off the 00:00 UTC boundary: a new lock made exactly at 00:00 schedules one day less than one made a
        // second later, so an estimate taken at 00:00:00 can be ~70k short a second later (why bridges add headroom).
        // Also off the vault's 10-minute end buckets: a lock whose end falls on a multiple of 600 s writes zero to
        // the bucket's boostedR/boostedR2 slots (end % 600 == 0), ~40k cheaper than one a second later. With
        // allowBlocksWithSameTimestamp the estimate can run at exactly that second, so use 01:05:00, not 01:00:00.
        await mineAt((await now()) + 3600n + 300n);
        const hog = await (await ethers.getContractFactory('GasHog')).deploy();
        // ~40 fresh SSTOREs (~0.9M gas) inside the swap, and the pool reverts if the "hook" fails (v4 WrappedError).
        await f.pm.setReenter(await hog.getAddress(), hog.interface.encodeFunctionData('burn', [40]));
        await f.pm.setReenterMustSucceed(true);
        const eth = WAD / 1000n;
        const call = (g) => f.zap.connect(f.alice).zapETHOrRefund.staticCall(f.bob.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth, gasLimit: g });
        const gas = await f.zap.connect(f.alice).zapETHOrRefund.estimateGas(f.bob.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth });
        const seq = await sweepOutcomes(f, call, 300_000n, gas + 500_000n, 10_000n);
        expect(expectMonotone(seq, 'deep OOG')).to.equal('lock');
        expect(await sendAndName(f, f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth, gasLimit: gas })))
          .to.equal('Zapped');
        await expectClean(f);
      });

      it('a genuine pool/hook failure still refunds (reason = the pool error), at any sufficient gas', async function () {
        const f = await fixture();
        const rej = await (await ethers.getContractFactory('EthRejecter')).deploy();
        await f.pm.setReenter(await rej.getAddress(), '0x'); // the "hook" reverts
        await f.pm.setReenterMustSucceed(true);
        const eth = WAD / 1000n;
        const call = (g) => f.zap.connect(f.alice).zapETHOrRefund.staticCall(f.bob.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth, gasLimit: g });
        expect(expectMonotone(await sweepOutcomes(f, call, 260_000n, 1_500_000n, 20_000n), 'hook revert')).to.equal('refund');
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 30, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, f.pm.interface.getError('HookCallFailed').selector);
        await expectClean(f);
      });
    });

    describe('M-C (AMM-1, EF-2): caller price limit minSqrtPriceX96', function () {
      // Mock pool: 0.001 ETH moves sqrtPrice down by 1%.
      async function priced(opts) {
        const f = await fixture(opts);
        const p0 = await f.pm.sqrtPriceX96();
        await f.pm.setSqrtDropPerWei(p0 / 100n / (WAD / 1000n));
        return { f, p0, pct: (x) => (p0 * BigInt(x)) / 1000n }; // pct(985) = 98.5% of the start price
      }

      it('limit not hit: locks, and the pool price ends above the limit', async function () {
        const { f, pct } = await priced();
        const eth = WAD / 1000n;
        expect(await f.zap.checkBeneficiary(f.bob.address, 10, MIN_LOCK, pct(985), ANY_END)).to.equal(true);
        await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, pct(985), ANY_END, ANY_FEE, MAX, { value: eth })).to.emit(f.zap, 'Zapped');
        expect(await f.zap.sqrtPriceX96()).to.be.greaterThan(pct(985));
        expect(await f.zap.sqrtPriceX96()).to.be.lessThan(pct(991));
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(net(eth));
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        const lim = (await f.zap.sqrtPriceX96()) * 985n / 1000n;
        await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.carol.address, eth, 10, MIN_LOCK, lim, ANY_END, ANY_FEE, MAX)).to.emit(f.zap, 'Zapped');
        await expectClean(f);
      });

      it('limit hit mid-swap: strict zaps revert PriceLimitReached, OrRefund zaps refund everything (no partial fill, no fee)', async function () {
        const { f, p0, pct } = await priced({ feeBps: 50 });
        const eth = WAD / 1000n;
        const lim = pct(995); // the 1% move would cross it half way
        await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, lim, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'PriceLimitReached').withArgs(lim, lim);
        await f.weth.connect(f.alice).deposit({ value: eth });
        await f.weth.connect(f.alice).approve(f.zapAddr, MAX);
        await expect(f.zap.connect(f.alice).zapWETH(f.bob.address, eth, 10, MIN_LOCK, lim, ANY_END, ANY_FEE, MAX))
          .to.be.revertedWithCustomError(f.zap, 'PriceLimitReached');
        const feeBefore = [await ethers.provider.getBalance(f.feeTo.address), await f.weth.balanceOf(f.feeTo.address)];
        const bal = await ethers.provider.getBalance(f.bob.address);
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, MIN_LOCK, lim, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, sel(f, 'PriceLimitReached'))
          .and.not.to.emit(f.zap, 'FeePaid');
        expect(await ethers.provider.getBalance(f.bob.address)).to.equal(bal + eth);
        await expect(f.zap.connect(f.alice).zapWETHOrRefund(f.bob.address, eth, 10, MIN_LOCK, lim, ANY_END, ANY_FEE, MAX))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, await f.weth.getAddress(), eth, sel(f, 'PriceLimitReached'));
        expect([await ethers.provider.getBalance(f.feeTo.address), await f.weth.balanceOf(f.feeTo.address)]).to.deep.equal(feeBefore);
        expect(await f.pm.sqrtPriceX96()).to.equal(p0); // everything rolled back
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(0n);
        await expectClean(f);
      });

      it('price already pushed past the limit (front-run): fails before the fee and the swap; checkBeneficiary reports it', async function () {
        const { f, p0, pct } = await priced();
        const eth = WAD / 1000n;
        const lim = pct(985);
        await f.pm.setSqrtPrice(pct(980)); // an attacker sold ETH first
        await f.pm.setPartialFill(true); // a swap would revert UnexpectedSwapDelta: the pre-check fires first
        await expect(f.zap.checkBeneficiary(f.bob.address, 10, MIN_LOCK, lim, ANY_END))
          .to.be.revertedWithCustomError(f.zap, 'PriceLimitReached').withArgs(pct(980), lim);
        await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, lim, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'PriceLimitReached').withArgs(pct(980), lim);
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.bob.address, 10, MIN_LOCK, lim, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Refunded').withArgs(f.alice.address, f.bob.address, ethers.ZeroAddress, eth, sel(f, 'PriceLimitReached'));
        // Exactly at the limit is "reached" too (v4 would revert PriceLimitAlreadyExceeded).
        await f.pm.setSqrtPrice(lim);
        await expect(f.zap.checkBeneficiary(f.bob.address, 10, MIN_LOCK, lim, ANY_END)).to.be.revertedWithCustomError(f.zap, 'PriceLimitReached');
        // With the price back and a full fill it locks.
        await f.pm.setSqrtPrice(p0);
        await f.pm.setPartialFill(false);
        await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, lim, ANY_END, ANY_FEE, MAX, { value: eth })).to.emit(f.zap, 'Zapped');
        await expectClean(f);
      });

      it('rejects limits outside (MIN_SQRT_PRICE, MAX_SQRT_PRICE); a partial fill above the limit is still UnexpectedSwapDelta', async function () {
        const { f, pct } = await priced();
        const eth = WAD / 1000n;
        for (const bad of [1n, MIN_SQRT_PRICE, MAX_SQRT_PRICE, 2n ** 160n - 1n]) {
          await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, bad, ANY_END, ANY_FEE, MAX, { value: eth }))
            .to.be.revertedWithCustomError(f.zap, 'InvalidPriceLimit').withArgs(bad);
          await expect(f.zap.checkBeneficiary(f.bob.address, 10, MIN_LOCK, bad, ANY_END)).to.be.revertedWithCustomError(f.zap, 'InvalidPriceLimit');
        }
        // MIN_SQRT_PRICE + 1 is valid (it is what "no limit" uses).
        expect(await f.zap.checkBeneficiary(f.bob.address, 10, MIN_LOCK, MIN_SQRT_PRICE + 1n, ANY_END)).to.equal(true);
        await f.pm.setPartialFill(true);
        await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, pct(900), ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.be.revertedWithCustomError(f.zap, 'UnexpectedSwapDelta');
        await expectClean(f);
      });
    });

    describe('DOS-1: PULP pushed in during the swap', function () {
      it('a 1-wei push mid-swap no longer blocks zaps: exactly pulpOut is locked, the surplus is a sweepable stray', async function () {
        const f = await fixture({ withRecipient: true });
        const pulpAddr = await f.pulp.getAddress();
        // The pool (standing in for the hook or its fee recipient) sends the zap 1 wei of PULP inside the swap.
        await f.pm.setReenter(pulpAddr, f.pulp.interface.encodeFunctionData('transfer', [f.zapAddr, 1n]));
        const eth = WAD / 1000n;
        await expect(f.zap.zapETH(f.bob.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Zapped').withArgs(f.owner.address, f.bob.address, ethers.ZeroAddress, eth, 0n, net(eth), true, (v) => v > 0n);
        expect(await f.pm.reenterSucceeded()).to.equal(true);
        expect((await f.vault.locks(f.bob.address)).amount).to.equal(net(eth));
        expect(await f.pulp.balanceOf(f.zapAddr)).to.equal(1n);
        await expect(f.zap.connect(f.alice).zapETHOrRefund(f.carol.address, 10, MIN_LOCK, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }))
          .to.emit(f.zap, 'Zapped').and.not.to.emit(f.zap, 'Refunded');
        expect((await f.vault.locks(f.carol.address)).amount).to.equal(net(eth));
        expect(await f.pulp.balanceOf(f.zapAddr)).to.equal(2n);
        await expect(f.zap.sweep(pulpAddr)).to.emit(f.zap, 'Swept').withArgs(pulpAddr, f.feeTo.address, 2n);
        expect(await f.pulp.allowance(f.zapAddr, f.vaultAddr)).to.equal(0n);
        await expectClean(f);
      });
    });
  });
});
