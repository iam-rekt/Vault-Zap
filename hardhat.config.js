require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

// Pin the compiler to the local solcjs 0.8.28 from node_modules: builds never download a compiler.
// This config defines only the in-process `hardhat` network. It never loads .env files, private keys or a wallet.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _hre, runSuper) => {
  if (solcVersion !== '0.8.28') return runSuper();
  return {
    compilerPath: require.resolve('solc/soljson.js'),
    isSolcJs: true,
    version: solcVersion,
    longVersion: require('solc').version(),
  };
});

// Fork mode is opt-in (npm run test:fork): FORK=1, optional FORK_RPC (default: the public Robinhood Chain RPC)
// and FORK_BLOCK. Read-only: a local copy of Robinhood Chain mainnet state; only reads are sent to the RPC.
const FORK = process.env.FORK === '1';
const FORK_RPC = process.env.FORK_RPC || 'https://rpc.mainnet.chain.robinhood.com';

const hardhatNetwork = {
  allowBlocksWithSameTimestamp: true,
  hardfork: 'cancun',
  // Robinhood Chain (4663, an Arbitrum Orbit L2) is unknown to Hardhat; replay its history under Cancun rules.
  chains: { 4663: { hardforkHistory: { cancun: 0 } } },
};
if (FORK) {
  hardhatNetwork.chainId = 4663;
  hardhatNetwork.forking = { url: FORK_RPC, ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}) };
}

module.exports = {
  solidity: {
    version: '0.8.28',
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' },
  },
  defaultNetwork: 'hardhat',
  networks: { hardhat: hardhatNetwork },
  mocha: { timeout: FORK ? 600_000 : 300_000 },
};
