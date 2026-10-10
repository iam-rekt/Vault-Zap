const { ethers, network } = require('hardhat');

const DAY = 86400n;
const WAD = 10n ** 18n;
const PULP = 1000n * WAD;
const MAX = ethers.MaxUint256;
async function mineAt(t) {
  await network.provider.send('evm_setNextBlockTimestamp', [Number(t)]);
  await network.provider.send('evm_mine');
}
async function txAt(t, fn) {
  await network.provider.send('evm_setNextBlockTimestamp', [Number(t)]);
  return fn();
}
async function fixture(options = {}) {
  await network.provider.send('hardhat_reset');
  const [owner, distributor, alice, bob, carol, stranger, treasury] = await ethers.getSigners();
  const Token = await ethers.getContractFactory(options.tokenKind || 'MockERC20');
  const pulp = await Token.deploy('PULP', 'PULP', options.decimals ?? 18);
  const weth = await (await ethers.getContractFactory('MockWETH')).deploy();
  const block = await ethers.provider.getBlock('latest');
  const launch = (BigInt(block.timestamp) / DAY + BigInt(options.launchInDays ?? 2)) * DAY;
  const config = {
    pulp: await pulp.getAddress(), weth: options.nativeDisabled ? ethers.ZeroAddress : await weth.getAddress(),
    owner: owner.address, distributor: distributor.address, launchStart: launch,
    earlyWindow: options.earlyWindow ?? DAY, minLockAmount: options.minLockAmount ?? PULP,
    compoundFeeBps: options.compoundFeeBps ?? 0, treasury: options.treasury ?? treasury.address,
  };
  const vault = await (await ethers.getContractFactory('PulpVeVault')).deploy(config);
  await vault.waitForDeployment();
  for (const signer of [owner, distributor, alice, bob, carol, stranger]) {
    await pulp.mint(signer.address, 10n ** 30n);
    await pulp.connect(signer).approve(await vault.getAddress(), MAX);
  }
  return { owner, distributor, alice, bob, carol, stranger, treasury, pulp, weth, vault, launch, config };
}
async function addReward(f, name = 'REWARD', decimals = 18, kind = 'MockERC20') {
  const token = await (await ethers.getContractFactory(kind)).deploy(name, name, decimals);
  await f.vault.addRewardToken(await token.getAddress());
  await token.mint(f.distributor.address, 10n ** 30n);
  await token.connect(f.distributor).approve(await f.vault.getAddress(), MAX);
  return token;
}
// Mines to the first second a pending treasury may accept (TREASURY_DELAY after the proposal and after the
// last release).
async function passTreasuryDelay(vault) {
  const proposed = await vault.treasuryProposedAt(), released = await vault.lastReleasedAt();
  const at = (proposed > released ? proposed : released) + (await vault.TREASURY_DELAY());
  if (BigInt((await ethers.provider.getBlock('latest')).timestamp) < at) await mineAt(at);
}
function area(boost, end, from, to) {
  if (to > end) to = end;
  if (from >= to) return 0n;
  return boost * ((end - from) ** 2n - (end - to) ** 2n);
}
module.exports = { ethers, network, DAY, WAD, PULP, MAX, mineAt, txAt, fixture, addReward, area, passTreasuryDelay };
