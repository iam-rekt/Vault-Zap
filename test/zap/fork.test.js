// Fork test against Robinhood Chain mainnet (4663). Opt-in: `npm run test:fork` (FORK=1).
// Deploys a fresh PulpVeVault + PulpZap on the fork (nothing is broadcast), zaps a small amount of ETH through
// the real Uniswap v4 PoolManager, pool and tax hook with a 50 bps zap fee, and checks that the fee reached the
// recipient and that the PULP locked equals the v4 Quoter's quote for (amountIn - fee). Every zap passes the
// caller bounds a frontend would (maxUnlockTime, maxFeeBps) and goes through sync(native) + settle on the real
// PoolManager. Also: OrRefund gas edge cases against the real WETH proxy, and sweeping ETH pushed in via WETH.withdrawTo.
// Audit 2026-10-10: eth_estimateGas on the OrRefund call itself lands on the lock (M-B); a front-run that pushes
// the real pool past the caller's minSqrtPriceX96 makes the victim's zap revert/refund (M-C).
// Pin the state with FORK_BLOCK=<n> for repeatable numbers (the public RPC may rate-limit; just re-run).
const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const A = {
  pulp: '0xBc2283d12B1f2f46c1613AE672E95C55b69Ca414',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  hooks: '0x4Bc7Ba3a253d048Dc36C17Ac3f4E6484dAD120CC',
};
const POOL_ID = '0xdd086a556aa997e79d16cde88a6fcda21f615737df3d331ca1af74642e99dc09';
const WAD = 10n ** 18n;
const DAY = 86400n;
const FEE_BPS = 50n; // default deploy intent
const ANY_END = ethers.MaxUint256; // no unlock-time bound (tests that are not about it)
const ANY_FEE = 200; // any fee up to the cap
const NO_LIMIT = 0n; // minSqrtPriceX96: no caller price limit
const MAX = ethers.MaxUint256;

const enabled = process.env.FORK === '1';
(enabled ? describe : describe.skip)('PulpZap on a Robinhood Chain mainnet fork', function () {
  let zap, vault, pulp, weth, quoter, user, beneficiary, distributor, feeTo, vaultTreasury, key;

  before(async function () {
    const { chainId } = await ethers.provider.getNetwork();
    expect(chainId).to.equal(4663n);
    [user, beneficiary, distributor, feeTo, vaultTreasury] = await ethers.getSigners();
    pulp = await ethers.getContractAt('IERC20', A.pulp);
    weth = await ethers.getContractAt('IERC20', A.weth);
    const now = BigInt((await ethers.provider.getBlock('latest')).timestamp);
    // The vault needs launchStart at 00:00 UTC: the next midnight after the fork's latest block.
    const launch = (now / DAY + 1n) * DAY;
    vault = await (await ethers.getContractFactory('PulpVeVault')).deploy({
      pulp: A.pulp, weth: A.weth, owner: user.address, distributor: distributor.address,
      launchStart: launch, earlyWindow: DAY, minLockAmount: WAD,
      compoundFeeBps: 0, treasury: vaultTreasury.address, // vault Config fields the zap does not use
    });
    zap = await (await ethers.getContractFactory('PulpZap')).deploy(
      A.poolManager, await vault.getAddress(), A.weth, A.hooks, 0, 60, POOL_ID, user.address, FEE_BPS, feeTo.address);
    await network.provider.send('evm_setNextBlockTimestamp', [Number(launch + 60n)]); // locking open
    await network.provider.send('evm_mine');
    key = [ethers.ZeroAddress, A.pulp, 0, 60, A.hooks];
    quoter = new ethers.Contract(A.quoter,
      ['function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256 amountOut, uint256 gasEstimate)'],
      ethers.provider);
  });

  async function clean() {
    const z = await zap.getAddress();
    expect(await ethers.provider.getBalance(z)).to.equal(0n);
    expect(await pulp.balanceOf(z)).to.equal(0n);
    expect(await weth.balanceOf(z)).to.equal(0n);
    expect(await pulp.allowance(z, await vault.getAddress())).to.equal(0n);
  }

  it('computes the real pool id (and the constructor refuses any other expected id)', async function () {
    expect(await zap.poolId()).to.equal(POOL_ID);
    const Zap = await ethers.getContractFactory('PulpZap');
    await expect(Zap.deploy(A.poolManager, await vault.getAddress(), A.weth, A.hooks, 0, 10, POOL_ID, user.address, FEE_BPS, feeTo.address))
      .to.be.revertedWithCustomError(Zap, 'PoolIdMismatch');
    // sqrtPriceX96() reads slot0 through extsload: it must be a sane PULP-per-ETH price (1e4 .. 1e9).
    const sp = await zap.sqrtPriceX96();
    const pulpPerEth = Number(sp) ** 2 / 2 ** 192;
    console.log(`      sqrtPriceX96 ${sp} -> ${Math.round(pulpPerEth).toLocaleString('en-US')} PULP per ETH (before tax)`);
    expect(pulpPerEth).to.be.within(1e4, 1e9);
  });

  it('zapETH: 0.001 ETH, 50 bps fee to the recipient, rest through the real pool + hook; matches the v4 Quoter', async function () {
    const eth = WAD / 1000n;
    const [fee, netIn] = await zap.quoteFee(eth);
    expect(fee).to.equal((eth * FEE_BPS) / 10_000n);
    const feeBefore = await ethers.provider.getBalance(feeTo.address);
    const [quoted] = await quoter.quoteExactInputSingle.staticCall([key, true, netIn, '0x']);
    const minOut = (quoted * 99n) / 100n;
    const t = BigInt((await ethers.provider.getBlock('latest')).timestamp);
    const dl = t + 600n;
    const maxUnlock = t + 30n * DAY + 3600n; // frontend: now + days + slack
    const tx = await zap.connect(user).zapETH(beneficiary.address, 30, minOut, NO_LIMIT, maxUnlock, Number(FEE_BPS), dl, { value: eth });
    const r = await tx.wait();
    const ev = r.logs.map((l) => { try { return zap.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Zapped');
    const out = ev.args.pulpLocked;
    const lock = await vault.locks(beneficiary.address);
    console.log(`      fee: ${ethers.formatEther(fee)} ETH, quoter(amountIn - fee): ${ethers.formatUnits(quoted)} PULP, actual locked: ${ethers.formatUnits(out)} PULP, gas used: ${r.gasUsed}`);
    expect(ev.args.feeAmount).to.equal(fee);
    expect(await ethers.provider.getBalance(feeTo.address)).to.equal(feeBefore + fee);
    expect(lock.amount).to.equal(out);
    expect(out).to.equal(quoted); // same block state, same exact-input swap
    expect(await vault.totalLocked()).to.equal(out);
    expect(await pulp.balanceOf(await vault.getAddress())).to.equal(out);
    await clean();
  });

  it('zapWETH: real WETH9 unwrap + swap, added to the existing lock', async function () {
    const amt = WAD / 2000n;
    const wethDep = new ethers.Contract(A.weth, ['function deposit() payable', 'function approve(address,uint256) returns (bool)'], user);
    await (await wethDep.deposit({ value: amt })).wait();
    await (await wethDep.approve(await zap.getAddress(), amt)).wait();
    const before = (await vault.locks(beneficiary.address)).amount;
    const [fee, netIn] = await zap.quoteFee(amt);
    const feeBefore = await weth.balanceOf(feeTo.address);
    const [quoted] = await quoter.quoteExactInputSingle.staticCall([key, true, netIn, '0x']);
    const { end } = await vault.locks(beneficiary.address); // top-up: the displayed end is the bound
    await (await zap.connect(user).zapWETH(beneficiary.address, amt, 0, quoted, NO_LIMIT, end, Number(FEE_BPS), ethers.MaxUint256)).wait();
    expect((await vault.locks(beneficiary.address)).amount).to.equal(before + quoted);
    expect(await weth.balanceOf(feeTo.address)).to.equal(feeBefore + fee);
    await clean();
  });

  it('zapETHOrRefund: impossible minOut refunds all the ETH to the beneficiary, no fee charged', async function () {
    const eth = WAD / 1000n;
    const bal = await ethers.provider.getBalance(beneficiary.address);
    const feeBefore = await ethers.provider.getBalance(feeTo.address);
    await (await zap.connect(user).zapETHOrRefund(beneficiary.address, 10, 10n ** 40n, NO_LIMIT, ANY_END, ANY_FEE, ethers.MaxUint256, { value: eth })).wait();
    expect(await ethers.provider.getBalance(beneficiary.address)).to.equal(bal + eth);
    expect(await ethers.provider.getBalance(feeTo.address)).to.equal(feeBefore);
    await clean();
  });

  // Outcome of an OrRefund staticCall: 'gas' (InsufficientGas), 'refund' or 'lock'. Anything else throws.
  async function outcome(p) {
    try { return (await p).locked ? 'lock' : 'refund'; } catch (e) {
      const parsed = e.data && e.data !== '0x' ? zap.interface.parseError(e.data) : null;
      if (!parsed || parsed.name !== 'InsufficientGas') throw e;
      return 'gas';
    }
  }
  async function sent(txp) {
    const r = await (await txp).wait();
    const ev = r.logs.map((l) => { try { return zap.interface.parseLog(l); } catch { return null; } }).find((e) => e && (e.name === 'Zapped' || e.name === 'Refunded'));
    return { r, ev };
  }

  it('M-B: OrRefund gas with the real WETH: too little gas reverts InsufficientGas (no refund), a genuine failure refunds a gas burner in WETH', async function () {
    const burner = await (await ethers.getContractFactory('GasBurner')).deploy();
    const b = await burner.getAddress();
    const eth = WAD / 1000n;
    const need = await zap.zapETHOrRefund.estimateGas(b, 30, WAD, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth });
    // Sweep gas limits: below the lock's need every call reverts InsufficientGas, above it every call locks.
    const seq = [];
    for (let g = 100_000n; g <= need + 300_000n; g += 50_000n) {
      seq.push(await outcome(zap.zapETHOrRefund.staticCall(b, 30, WAD, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth, gasLimit: g })));
    }
    console.log(`      OrRefund estimate ${need}; sweep ${seq.join(',')}`);
    const first = seq.indexOf('lock');
    expect(first).to.be.greaterThan(0);
    expect(seq.slice(0, first).every((o) => o === 'gas')).to.equal(true);
    expect(seq.slice(first).every((o) => o === 'lock')).to.equal(true);
    // A real low-gas fill reverts; nothing moves.
    await expect(zap.zapETHOrRefund(b, 30, WAD, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth, gasLimit: need / 2n }))
      .to.be.revertedWithCustomError(zap, 'InsufficientGas');
    // A genuine failure (impossible minOut): the burner refuses ETH within the cap, real WETH arrives.
    const { r, ev } = await sent(zap.zapETHOrRefund(b, 30, 10n ** 40n, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: eth }));
    expect(ev.name).to.equal('Refunded');
    expect(ev.args.token).to.equal(A.weth);
    expect(ev.args.reason).to.equal(zap.interface.getError('InsufficientOutput').selector);
    expect(await weth.balanceOf(b)).to.equal(eth);
    console.log(`      genuine refund to a gas burner (real WETH): gas used ${r.gasUsed}`);
    await clean();
  });

  // The documented rule (BRIDGES.md, README): the estimate + 10%. An exact estimate can fall ~40k short, because the
  // vault's gas depends on where the lock's end falls in its 10-minute bucket; too little gas reverts InsufficientGas,
  // never refunds (covered by the gas-sweep test above).
  it('M-B: eth_estimateGas on the OrRefund call -> send at the estimate + 10% -> Zapped (new 10/30-day, top-up, WETH); impossible minOut -> Refunded', async function () {
    const s = await ethers.getSigners();
    const eth = WAD / 1000n;
    const [, netIn] = await zap.quoteFee(eth);
    const [q] = await quoter.quoteExactInputSingle.staticCall([key, true, netIn, '0x']);
    const minOut = (q * 98n) / 100n;
    const out = [];
    const run = async (label, fn, args, ov) => {
      const est = await zap[fn].estimateGas(...args, ov);
      const { r, ev } = await sent(zap[fn](...args, { ...ov, gasLimit: (est * 11n) / 10n }));
      out.push(`${label}: estimate ${est}, used ${r.gasUsed} -> ${ev.name}`);
      return ev.name;
    };
    expect(await run('ETH new 10-day', 'zapETHOrRefund', [s[4].address, 10, minOut, NO_LIMIT, ANY_END, Number(FEE_BPS), MAX], { value: eth })).to.equal('Zapped');
    expect(await run('ETH new 30-day', 'zapETHOrRefund', [s[5].address, 30, minOut, NO_LIMIT, ANY_END, Number(FEE_BPS), MAX], { value: eth })).to.equal('Zapped');
    expect(await run('ETH top-up', 'zapETHOrRefund', [s[5].address, 0, (minOut * 95n) / 100n, NO_LIMIT, ANY_END, Number(FEE_BPS), MAX], { value: eth })).to.equal('Zapped');
    const wethDep = new ethers.Contract(A.weth, ['function deposit() payable', 'function approve(address,uint256) returns (bool)'], user);
    await (await wethDep.deposit({ value: 2n * eth })).wait();
    await (await wethDep.approve(await zap.getAddress(), MAX)).wait();
    expect(await run('WETH new 30-day', 'zapWETHOrRefund', [s[6].address, eth, 30, (minOut * 95n) / 100n, NO_LIMIT, ANY_END, Number(FEE_BPS), MAX], {})).to.equal('Zapped');
    expect(await run('WETH top-up', 'zapWETHOrRefund', [s[6].address, eth, 0, (minOut * 95n) / 100n, NO_LIMIT, ANY_END, Number(FEE_BPS), MAX], {})).to.equal('Zapped');
    expect(await run('ETH impossible minOut', 'zapETHOrRefund', [s[7].address, 30, 10n ** 40n, NO_LIMIT, ANY_END, Number(FEE_BPS), MAX], { value: eth })).to.equal('Refunded');
    console.log(`      ${out.join('\n      ')}`);
    await clean();
  });

  it('M-C: a front-run that pushes the real pool past the victim\'s minSqrtPriceX96 makes the victim revert (strict) or refund (OrRefund)', async function () {
    const s = await ethers.getSigners();
    const victim = s[8], attacker = s[9];
    const v = WAD / 100n; // victim sells 0.01 ETH
    const p0 = await zap.sqrtPriceX96();
    // The victim's own price move (simulated, then rolled back), and a limit 10% of that move beyond it.
    let snap = await network.provider.send('evm_snapshot');
    await (await zap.connect(victim).zapETH(victim.address, 30, WAD, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: v })).wait();
    const p1 = await zap.sqrtPriceX96();
    await network.provider.send('evm_revert', [snap]);
    expect(p1).to.be.lessThan(p0);
    const limit = p1 - (p0 - p1) / 10n;
    console.log(`      sqrtPrice ${p0} -> ${p1} after 0.01 ETH (${(Number(p0 - p1) * 100 / Number(p0)).toFixed(3)}% move); limit ${limit}`);

    // No front-run: the limit is not hit and the zap locks.
    snap = await network.provider.send('evm_snapshot');
    await expect(zap.connect(victim).zapETH(victim.address, 30, WAD, limit, ANY_END, ANY_FEE, MAX, { value: v })).to.emit(zap, 'Zapped');
    await network.provider.send('evm_revert', [snap]);

    // Front-run 1: the attacker sells 0.2 ETH first; the price is already past the limit before the victim's swap.
    snap = await network.provider.send('evm_snapshot');
    await (await zap.connect(attacker).zapETH(attacker.address, 10, WAD, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: WAD / 5n })).wait();
    const pa = await zap.sqrtPriceX96();
    expect(pa).to.be.lessThan(limit);
    await expect(zap.connect(victim).zapETH(victim.address, 30, WAD, limit, ANY_END, ANY_FEE, MAX, { value: v }))
      .to.be.revertedWithCustomError(zap, 'PriceLimitReached').withArgs(pa, limit);
    const bal = await ethers.provider.getBalance(victim.address);
    const { r, ev } = await sent(zap.connect(attacker).zapETHOrRefund(victim.address, 30, WAD, limit, ANY_END, ANY_FEE, MAX, { value: v }));
    expect(ev.name).to.equal('Refunded');
    expect(ev.args.reason).to.equal(zap.interface.getError('PriceLimitReached').selector);
    expect(await ethers.provider.getBalance(victim.address)).to.equal(bal + v);
    console.log(`      front-run 0.2 ETH: price ${pa} < limit -> strict PriceLimitReached, OrRefund refunded (gas ${r.gasUsed})`);
    await network.provider.send('evm_revert', [snap]);

    // Front-run 2: a smaller sell (0.005 ETH) leaves the price above the limit, but the victim's swap would cross
    // it: the real v4 swap stops at the limit (partial fill) and the zap reverts/refunds instead of keeping it.
    snap = await network.provider.send('evm_snapshot');
    await (await zap.connect(attacker).zapETH(attacker.address, 10, WAD, NO_LIMIT, ANY_END, ANY_FEE, MAX, { value: v / 2n })).wait();
    const pb = await zap.sqrtPriceX96();
    expect(pb).to.be.greaterThan(limit);
    await expect(zap.connect(victim).zapETH(victim.address, 30, WAD, limit, ANY_END, ANY_FEE, MAX, { value: v }))
      .to.be.revertedWithCustomError(zap, 'PriceLimitReached').withArgs(limit, limit);
    const { ev: ev2 } = await sent(zap.connect(attacker).zapETHOrRefund(victim.address, 30, WAD, limit, ANY_END, ANY_FEE, MAX, { value: v }));
    expect(ev2.name).to.equal('Refunded');
    expect(ev2.args.reason).to.equal(zap.interface.getError('PriceLimitReached').selector);
    expect(await zap.sqrtPriceX96()).to.equal(pb); // the partial swap was rolled back
    console.log(`      front-run 0.005 ETH: price ${pb} > limit, victim's swap would cross it -> PriceLimitReached(limit), refunded`);
    await network.provider.send('evm_revert', [snap]);
    await clean();
  });

  it('anyone can push ETH in through the real WETH withdrawTo; the owner sweeps it to the fee recipient', async function () {
    const amt = WAD / 10_000n;
    const w = new ethers.Contract(A.weth, ['function deposit() payable', 'function withdrawTo(address,uint256)'], beneficiary);
    await (await w.deposit({ value: amt })).wait();
    await (await w.withdrawTo(await zap.getAddress(), amt)).wait();
    expect(await ethers.provider.getBalance(await zap.getAddress())).to.equal(amt);
    const before = await ethers.provider.getBalance(feeTo.address);
    await (await zap.connect(user).sweep(ethers.ZeroAddress)).wait();
    expect(await ethers.provider.getBalance(feeTo.address)).to.equal(before + amt);
    await clean();
  });
});
