# deployments/

The deploy scripts write one JSON record per deployment here:

- `<chainId>-<vault>.json` from `npm run deploy:vault` (has a `vault` field). `npm run deploy:zap` offers the newest
  vault record for the chain as the vault address, and `npm run deploy:vault -- --check-handover <vault>` reads
  the expected owner, deployer and treasury from it.
- `<chainId>-<zap>.json` from `npm run deploy:zap` (has a `zap` field).
- `<chainId>-<address>-standard-input.json` when automatic source verification failed (for verifying by hand).

Records contain addresses, settings, transaction hashes and constructor arguments, never keys. They are
gitignored; commit the ones you want to publish on purpose.
