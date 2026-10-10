const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const DAY = 86_400n;
const WAD = 10n ** 18n;
const DURATIONS = [10n, 20n, 30n];
const SEEDS = [0x1a2b3c4d, 0x5eed1234, 0x9e3779b9, 0xdecafbad];
const EXTRA_SEEDS = Number(process.env.PULP_MODEL_EXTRA_SEEDS || 0);
const ACTIONS = Number(process.env.PULP_MODEL_ACTIONS || 80);
if (!Number.isInteger(EXTRA_SEEDS) || EXTRA_SEEDS < 0 || EXTRA_SEEDS > 128 ||
    !Number.isInteger(ACTIONS) || ACTIONS < 80 || ACTIONS > 1000) {
  throw new Error('Model test bounds: 0..128 extra seeds, 80..1000 randomized actions.');
}
for (let i = 0; i < EXTRA_SEEDS; ++i) SEEDS.push((Math.imul(i + 1, 2654435761) ^ 0xc0decafe) >>> 0);

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);
const dayOf = (timestamp) => timestamp / DAY;

// LCG; draws use the HIGH bits. Low LCG bits have tiny periods (bit k repeats every 2^(k+1)),
// so `state % bound` with an even bound can lock the run into a short cycle of no-op actions.
function random(seed) {
  let state = seed >>> 0;
  return (bound) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((state / 2 ** 32) * bound);
  };
}

// Each interval is a historical snapshot. Changes replace only the future
// interval with new frozen objects; assertions integrate these independently.
// Two reward tokens: an unrelated ERC20 ('rwd') and PULP itself ('pulp'), so that
// compounding (PULP rewards -> principal) is modelled. `wallet` is each user's PULP.
// Compounding pays a fee (floor(page * feeBps / 10_000)) to a separate recipient; the owner changes
// the rate at random during the run, between zero and the 2% cap.
// Late in every run the owner turns on the one-way emergency exit: from then on any lock can withdraw, and
// no area changes any more. Rewards stop at the switch second: days before the exit day pay by full-day area;
// the exit day pays floor(budget * elapsed / DAY), split by the area each lock accrued before the switch
// (computed here from the segments, independently of the contract's end index); later days pay nobody. The
// unearned part of the exit day is released at the switch; later days' and zero-area days' budgets can be
// released (they leave `reserved`) and then swept to the treasury with recoverExcess. After the switch each
// user's total entitlement (settled + still claimable) is frozen: nobody's withdrawal can move anyone
// else's. Compounding passes a maximum fee, sometimes one below the current rate. Claims sometimes go to
// another user with claimTo.
// A third reward token ('aux') goes through the whole registry lifecycle at random: removal (dropped when nothing
// is owed, otherwise retired), re-adding, and expiry CLAIM_DEADLINE (120 days) after retirement, which moves
// everything still owed to the released total (sweepable) and closes its books for good. The owner also proposes
// treasury changes at random (three candidate addresses); acceptance is predicted from the model: 8 days after
// the proposal and after the last release, and only when no token with books has a budget on a day not yet
// earned. Every sweep and compound fee is checked against whichever treasury was current.
const TOKENS = ['rwd', 'pulp', 'aux'];
const CLAIM_DEADLINE = 120n * DAY;
const TREASURY_DELAY = 8n * DAY;
const FEE_RATES = [0n, 1n, 37n, 100n, 200n];
function makeModel(launch, window, users, startingPulp, feeBps) {
  const positions = users.map(() => ({ amount: 0n, boosted: 0n, end: 0n }));
  const segments = users.map(() => []);
  const histories = users.map(() => new Set());
  const perToken = (make) => Object.fromEntries(TOKENS.map((t) => [t, make()]));
  const cursors = perToken(() => users.map(() => 0));
  const received = perToken(() => users.map(() => 0n));
  // Everything settled for the user: claims, and compounded pages (fee included).
  const credited = perToken(() => users.map(() => 0n));
  const budgets = perToken(() => new Map());
  const notified = perToken(() => 0n);
  const paid = perToken(() => 0n);
  const wallet = users.map(() => startingPulp);
  const fee = { bps: feeBps, collected: 0n };
  const exit = { on: false, epoch: 0n, ts: 0n, total: 0n };
  const released = perToken(() => 0n);
  const recovered = perToken(() => 0n);
  // Registry lifecycle: 'active', 'retired' (removed, still owed), 'dropped' (removed, nothing owed), 'expired'.
  const status = perToken(() => 'active');
  const retiredAt = perToken(() => 0n);
  const books = (token) => status[token] === 'active' || status[token] === 'retired';
  const owed = (token) => notified[token] - paid[token] - released[token];
  // Treasury handover state, and what each address received (compound fees and sweeps) while it was the treasury.
  const treasury = { current: null, pending: null, proposedAt: 0n, lastReleasedAt: 0n };
  const payouts = new Map(); // address -> { fees, rwd, pulp, aux }
  const payee = (addr) => {
    if (!payouts.has(addr)) payouts.set(addr, { fees: 0n, ...perToken(() => 0n) });
    return payouts.get(addr);
  };
  const launchDay = (launch + DAY - 1n) / DAY;

  const multiplier = (t) => t <= launch ? 2n * WAD
    : t - launch >= window ? WAD
      : WAD + WAD * (window - (t - launch)) / window;

  function append(user, start, end, boost) {
    segments[user].push(Object.freeze({ start, stop: end, end, boost }));
    for (let epoch = dayOf(start); epoch <= dayOf(end - 1n); epoch++) histories[user].add(epoch);
  }

  function area(user, epoch) {
    const dayStart = epoch * DAY;
    const dayEnd = dayStart + DAY;
    return segments[user].reduce((sum, s) => {
      const a = max(dayStart, s.start);
      const b = min(dayEnd, s.stop);
      if (a >= b) return sum;
      // Primitive of 2 * boost * (end - t): boost * (end - t)^2.
      return sum + s.boost * ((s.end - a) ** 2n - (s.end - b) ** 2n);
    }, 0n);
  }

  const totalArea = (epoch) => users.reduce((sum, _, user) => sum + area(user, epoch), 0n);

  // Area accrued on the day of `x` before `x`.
  function areaBefore(user, x) {
    const dayStart = dayOf(x) * DAY;
    return segments[user].reduce((sum, s) => {
      const a = max(dayStart, s.start);
      const b = min(x, s.stop);
      if (a >= b) return sum;
      return sum + s.boost * ((s.end - a) ** 2n - (s.end - b) ** 2n);
    }, 0n);
  }
  const history = (user) => [...histories[user]].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const budget = (token, epoch) => budgets[token].get(epoch) || 0n;

  // First day that is not payable: today (still open) or, after the switch, the day after the exit day.
  const payableStop = (today) => (exit.on ? exit.epoch + 1n : today);
  // A day's budget nobody can ever be paid: after the exit day, the exit day if nobody accrued before the
  // switch, or a zero-area day before it.
  const unpayable = (epoch) => exit.on && (epoch > exit.epoch ||
    (epoch === exit.epoch ? exit.total === 0n : totalArea(epoch) === 0n));
  // Numerator and denominator of a day's split.
  const split = (user, epoch) => (exit.on && epoch === exit.epoch
    ? [areaBefore(user, exit.ts), exit.total] : [area(user, epoch), totalArea(epoch)]);

  function quote(token, user, today, limit) {
    const epochs = history(user);
    const stop = payableStop(today);
    let cursor = cursors[token][user];
    const pageEnd = Math.min(epochs.length, cursor + limit);
    let amount = 0n;
    while (cursor < pageEnd && epochs[cursor] < stop) {
      const epoch = epochs[cursor++];
      const [numerator, denominator] = split(user, epoch);
      if (numerator !== 0n) amount += budget(token, epoch) * numerator / denominator;
    }
    return { amount, cursor, caughtUp: cursor === epochs.length || epochs[cursor] >= stop };
  }

  // Settled so far plus everything still claimable on every remaining page (nothing once the books are closed).
  const entitlement = (token, user, today) =>
    credited[token][user] + (books(token) ? quote(token, user, today, Infinity).amount : 0n);

  // The contract's window: the first day that may hold an unearned budget, and the 8 days from it.
  const firstUnsettled = (today) => max(exit.on ? exit.epoch + 1n : today, launchDay);
  function scheduledDay(token, today) {
    const first = firstUnsettled(today);
    for (let epoch = first; epoch <= first + 7n; epoch++) if (budget(token, epoch) !== 0n) return epoch;
    return null;
  }

  // Shared by top-ups and compounding: new principal at today's multiplier, same expiry.
  function addPrincipal(user, amount, t) {
    const position = positions[user];
    const boost = amount * multiplier(t);
    position.amount += amount;
    position.boosted += boost;
    append(user, t, position.end, boost);
  }

  function settle(token, user, today, limit) {
    const result = quote(token, user, today, limit);
    cursors[token][user] = result.cursor;
    paid[token] += result.amount;
    credited[token][user] += result.amount;
    return result;
  }

  return {
    positions, segments, histories, cursors, received, credited, budgets, notified, paid, wallet, fee,
    exit, released, recovered, status, retiredAt, books, owed, treasury, payouts, payee, scheduledDay,
    multiplier, area, areaBefore, totalArea, history, budget, quote, unpayable, entitlement,
    // `payer` differs from `user` for lockFor / increaseAmountFor.
    lock(user, amount, duration, t, payer = user) {
      const boost = amount * multiplier(t);
      const end = t + duration * DAY;
      positions[user] = { amount, boosted: boost, end };
      wallet[payer] -= amount;
      append(user, t, end, boost);
    },
    topup(user, amount, t, payer = user) {
      wallet[payer] -= amount;
      addPrincipal(user, amount, t);
    },
    // The whole PULP page is paid on the reward books; the fee is transferred out, the rest becomes principal.
    compound(user, today, limit, t) {
      const result = settle('pulp', user, today, limit);
      const charged = result.amount * fee.bps / 10_000n;
      fee.collected += charged;
      payee(treasury.current).fees += charged;
      addPrincipal(user, result.amount - charged, t);
      return { ...result, fee: charged, net: result.amount - charged };
    },
    extend(user, duration, t) {
      const position = positions[user];
      if (t >= position.end) {
        position.boosted = position.amount * multiplier(t);
      } else {
        segments[user] = segments[user].map((s) => s.stop > t
          ? Object.freeze({ ...s, stop: t }) : s);
      }
      position.end = t + duration * DAY;
      append(user, t, position.end, position.boosted);
    },
    // Before exit only at/after expiry. After exit also early; areas are frozen at the switch either way.
    withdraw(user) {
      wallet[user] += positions[user].amount;
      positions[user] = { amount: 0n, boosted: 0n, end: 0n };
    },
    // The switch at `t`: freeze the exit-day total, keep floor(budget * elapsed / DAY) of the exit day
    // (nothing if nobody accrued area), release the rest. Returns the per-token exit-day budget before.
    enableExit(t) {
      exit.on = true;
      exit.epoch = dayOf(t);
      exit.ts = t;
      exit.total = users.reduce((sum, _, user) => sum + areaBefore(user, t), 0n);
      treasury.lastReleasedAt = t;
      const original = {};
      for (const token of TOKENS) {
        const b = budget(token, exit.epoch);
        original[token] = b;
        const earned = exit.total === 0n ? 0n : b * (t - exit.epoch * DAY) / DAY;
        budgets[token].set(exit.epoch, earned);
        released[token] += b - earned;
      }
      return original;
    },
    release(token, epoch, t) {
      const amount = budget(token, epoch);
      budgets[token].set(epoch, 0n);
      released[token] += amount;
      if (amount !== 0n) treasury.lastReleasedAt = t;
      return amount;
    },
    // removeRewardToken, after the window check: retired if anything is still owed, otherwise dropped.
    remove(token, t) {
      status[token] = owed(token) !== 0n ? 'retired' : 'dropped';
      retiredAt[token] = status[token] === 'retired' ? t : 0n;
    },
    add(token) {
      status[token] = 'active';
      retiredAt[token] = 0n;
    },
    // The claim deadline: whatever is still owed leaves the books (released), and the books close for good.
    expire(token, t) {
      const forfeited = owed(token);
      released[token] += forfeited;
      if (forfeited !== 0n) treasury.lastReleasedAt = t;
      status[token] = 'expired';
      retiredAt[token] = 0n;
      return forfeited;
    },
    sweep(token, amount) {
      recovered[token] += amount;
      payee(treasury.current)[token] += amount;
    },
    notify(token, amount, t) {
      const first = max(dayOf(t) + 1n, (launch + DAY - 1n) / DAY);
      const daily = amount / 7n;
      for (let i = 0n; i < 7n; i++) {
        const epoch = first + i;
        budgets[token].set(epoch, budget(token, epoch) + daily + (i === 6n ? amount % 7n : 0n));
      }
      notified[token] += amount;
      return first;
    },
    claim(token, user, today, limit, to = user) {
      const result = settle(token, user, today, limit);
      received[token][to] += result.amount;
      if (token === 'pulp') wallet[to] += result.amount;
      return result;
    },
  };
}

describe('PulpVeVault: deterministic history-model differential', function () {
  this.timeout(300_000);

  for (const seed of SEEDS) {
    it(`matches immutable-segment BigInt model, seed 0x${seed.toString(16)}`, async function () {
      const trace = [];
      const rand = random(seed);

      try {
        const [owner, distributor, ...signers] = await ethers.getSigners();
        const users = signers.slice(0, 4);
        const feeRecipient = signers[4]; // the first treasury: compound fees and every sweep
        // Treasury candidates (the first one is the deployed treasury); none of them ever holds anything else.
        const candidates = [feeRecipient, signers[5], signers[6]];
        const candidateAddresses = await Promise.all(candidates.map((c) => c.getAddress()));
        const addresses = await Promise.all(users.map((u) => u.getAddress()));
        const Token = await ethers.getContractFactory('MockERC20');
        const pulp = await Token.deploy('Pulp', 'PULP', 18);
        const reward = await Token.deploy('Reward', 'RWD', 18);
        const aux = await Token.deploy('Aux', 'AUX', 18);
        await Promise.all([pulp.waitForDeployment(), reward.waitForDeployment(), aux.waitForDeployment()]);

        const block = await ethers.provider.getBlock('latest');
        const launch = (BigInt(block.timestamp) / DAY + 1n) * DAY + DAY;
        const window = 14n * DAY;
        const Vault = await ethers.getContractFactory('PulpVeVault');
        const vault = await Vault.deploy({
          pulp: await pulp.getAddress(), weth: ethers.ZeroAddress,
          owner: await owner.getAddress(), distributor: await distributor.getAddress(),
          launchStart: launch, earlyWindow: window, minLockAmount: 1n,
          compoundFeeBps: 150, treasury: await feeRecipient.getAddress(),
        });
        await vault.waitForDeployment();
        await vault.connect(owner).addRewardToken(await reward.getAddress());
        await vault.connect(owner).addRewardToken(await pulp.getAddress());
        await vault.connect(owner).addRewardToken(await aux.getAddress());

        const startingPulp = 1_000_000n * WAD;
        for (const user of users) {
          await pulp.mint(await user.getAddress(), startingPulp);
          await pulp.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
        }
        for (const token of [reward, pulp, aux]) {
          await token.mint(await distributor.getAddress(), 1_000_000n * WAD);
          await token.connect(distributor).approve(await vault.getAddress(), ethers.MaxUint256);
        }

        const model = makeModel(launch, window, users, startingPulp, 150n);
        model.treasury.current = candidateAddresses[0];
        const rewardAddress = await reward.getAddress();
        const pulpAddress = await pulp.getAddress();
        const auxAddress = await aux.getAddress();
        const tokenAddress = { rwd: rewardAddress, pulp: pulpAddress, aux: auxAddress };
        const assetOf = { rwd: reward, pulp, aux };
        const vaultAddress = await vault.getAddress();
        let checks = 0;
        // Each user's total entitlement per token, taken at the switch.
        const entitledAtExit = Object.fromEntries(TOKENS.map((t) => [t, users.map(() => 0n)]));

        async function currentTime() {
          return BigInt((await ethers.provider.getBlock('latest')).timestamp);
        }

        async function checkArea(epoch) {
          const expected = model.totalArea(epoch);
          expect(await vault.totalEpochArea(epoch), `total area day ${epoch}`).to.equal(expected);
          for (let user = 0; user < users.length; user++) {
            expect(await vault.userEpochArea(addresses[user], epoch),
              `user ${user} area day ${epoch}`).to.equal(model.area(user, epoch));
          }
        }

        async function checkState(full = false, extraEpochs = []) {
          const now = await currentTime();
          const today = dayOf(now);
          expect(await vault.entryMultiplier(now), 'entry multiplier').to.equal(model.multiplier(now));
          let locked = 0n;
          for (let user = 0; user < users.length; user++) {
            const position = model.positions[user];
            const onchain = await vault.locks(addresses[user]);
            expect(onchain.amount, `user ${user} principal`).to.equal(position.amount);
            expect(onchain.boosted, `user ${user} boost`).to.equal(position.boosted);
            expect(onchain.end, `user ${user} end`).to.equal(position.end);
            locked += position.amount;
            const power = now >= position.end ? 0n
              : position.boosted * (position.end - now) / (30n * DAY * WAD);
            expect(await vault.powerOf(addresses[user]), `user ${user} live power`).to.equal(power);

            for (const token of TOKENS) {
              if (model.books(token)) {
                const quoted = model.quote(token, user, today, 64);
                const chainQuote = await vault.claimable(addresses[user], tokenAddress[token], 64);
                expect(chainQuote[0], `user ${user} ${token} claimable`).to.equal(quoted.amount);
                expect(chainQuote[1], `user ${user} ${token} next cursor`).to.equal(BigInt(quoted.cursor));
                expect(chainQuote[2], `user ${user} ${token} caught up`).to.equal(quoted.caughtUp);
              } else if (user === 0) {
                await expect(vault.claimable(addresses[user], tokenAddress[token], 64), `${token} has no books`)
                  .to.be.revertedWithCustomError(vault, 'NotRewardToken');
              }
              expect(await vault.claimCursor(addresses[user], tokenAddress[token]),
                `user ${user} ${token} stored cursor`).to.equal(BigInt(model.cursors[token][user]));
            }
            expect(await reward.balanceOf(addresses[user]),
              `user ${user} rewards received`).to.equal(model.received.rwd[user]);
            expect(await aux.balanceOf(addresses[user]), `user ${user} aux received`).to.equal(model.received.aux[user]);
            // Locks, top-ups (own or paid for others), withdrawals and PULP claims; never compounding.
            expect(await pulp.balanceOf(addresses[user]), `user ${user} PULP wallet`).to.equal(model.wallet[user]);
          }
          // Owed: notified, not paid, not released. Held: owed plus released budgets not yet swept.
          const owed = (token) => model.notified[token] - model.paid[token] - model.released[token];
          const held = (token) => owed(token) + model.released[token] - model.recovered[token];
          for (const token of TOKENS) {
            expect(await vault.totalNotified(tokenAddress[token]), `${token} notified`).to.equal(model.notified[token]);
            expect(await vault.totalPaid(tokenAddress[token]), `${token} paid`).to.equal(model.paid[token]);
            expect(model.paid[token] <= model.notified[token], `${token} reward conservation`).to.equal(true);
          }
          expect(await vault.totalLocked()).to.equal(locked);
          expect(await vault.compoundFeeBps(), 'fee rate').to.equal(model.fee.bps);
          // Each treasury (current or past) holds exactly the compound fees and sweeps made while it was current.
          for (const addr of candidateAddresses) {
            const got = model.payee(addr);
            expect(await pulp.balanceOf(addr), `treasury ${addr} PULP: compound fees + sweeps`).to.equal(got.fees + got.pulp);
            expect(await reward.balanceOf(addr), `treasury ${addr} rewards: sweeps`).to.equal(got.rwd);
            expect(await aux.balanceOf(addr), `treasury ${addr} aux: sweeps`).to.equal(got.aux);
          }
          expect([...model.payouts.values()].reduce((a, g) => a + g.fees, 0n), 'all compound fees').to.equal(model.fee.collected);
          expect(await vault.treasury(), 'treasury').to.equal(model.treasury.current);
          expect(await vault.pendingTreasury(), 'pending treasury').to.equal(model.treasury.pending ?? ethers.ZeroAddress);
          expect(await vault.treasuryProposedAt(), 'treasury proposed at').to.equal(model.treasury.proposedAt);
          expect(await vault.lastReleasedAt(), 'last release').to.equal(model.treasury.lastReleasedAt);
          // The registry: aux's lifecycle state, on-chain.
          expect([await vault.isRewardToken(auxAddress), await vault.isRetiredRewardToken(auxAddress),
            await vault.isExpiredRewardToken(auxAddress), await vault.retiredAt(auxAddress)], 'aux registry state')
            .to.deep.equal([model.status.aux === 'active', model.status.aux === 'retired', model.status.aux === 'expired', model.retiredAt.aux]);
          expect(await vault.getRetiredRewardTokens(), 'retired list').to.deep.equal(model.status.aux === 'retired' ? [auxAddress] : []);
          expect(await vault.emergencyExit(), 'emergency exit flag').to.equal(model.exit.on);
          expect(await vault.exitEpoch(), 'exit day').to.equal(model.exit.epoch);
          expect(await vault.exitTimestamp(), 'exit second').to.equal(model.exit.ts);
          expect(await vault.exitDayTotalArea(), 'exit-day area before the switch').to.equal(model.exit.total);
          if (model.exit.on) {
            for (let user = 0; user < users.length; user++) {
              expect(await vault.exitDayArea(addresses[user]), `user ${user} exit-day area`).to.equal(model.areaBefore(user, model.exit.ts));
            }
          }
          expect(await reward.balanceOf(vaultAddress)).to.equal(held('rwd'));
          expect(await aux.balanceOf(vaultAddress)).to.equal(held('aux'));
          for (const token of TOKENS) {
            expect(await vault.totalReleased(tokenAddress[token]), `${token} released`).to.equal(model.released[token]);
          }
          // Principal and PULP rewards share one balance; compounding moves PULP between the two, and its
          // fee leaves the vault after being paid on the reward books, so the balance still matches.
          expect(await pulp.balanceOf(vaultAddress), 'PULP balance').to.equal(locked + held('pulp'));
          // the sweep can only ever see released budgets nobody can earn: everything else here is owed
          expect(await vault.reserved(pulpAddress), 'reserved PULP').to.equal(locked + owed('pulp'));
          expect(await vault.reserved(rewardAddress), 'reserved rewards').to.equal(owed('rwd'));
          expect(await vault.reserved(auxAddress), 'reserved aux').to.equal(owed('aux'));
          // The invariant: the vault always holds at least what it owes. Equal unless released budgets
          // wait to be swept (this run sends no strays).
          for (const token of TOKENS) {
            const asset = assetOf[token];
            const balance = await asset.balanceOf(vaultAddress), owedNow = await vault.reserved(tokenAddress[token]);
            expect(balance >= owedNow, `${token} balance >= reserved`).to.equal(true);
            expect(balance - owedNow, `${token} excess is only unswept releases`)
              .to.equal(model.released[token] - model.recovered[token]);
            expect(model.paid[token] + model.released[token] <= model.notified[token], `${token} paid + released <= notified`)
              .to.equal(true);
          }
          // After the exit no claim cursor ever reaches the exit day, and every user's total entitlement
          // (settled + claimable on every page) is exactly what it was at the switch: no action after it,
          // in particular nobody else's withdrawal, can raise (or lower) it. On-chain: whenever the page
          // is caught up, settled + the chain's claimable equals that frozen total.
          if (model.exit.on) {
            for (let user = 0; user < users.length; user++) {
              const payableDays = model.history(user).filter((e) => e <= model.exit.epoch).length;
              for (const token of TOKENS) {
                expect(model.cursors[token][user] <= payableDays, `user ${user} ${token} cursor before the exit day`).to.equal(true);
                // An expiry after the switch forfeits what was left unclaimed: the one deliberate exception.
                if (model.status[token] === 'expired' || !model.books(token)) continue;
                const frozen = entitledAtExit[token][user];
                expect(model.entitlement(token, user, today), `user ${user} ${token} entitlement frozen at the switch`).to.equal(frozen);
                const chainQuote = await vault.claimable(addresses[user], tokenAddress[token], 64);
                const onchain = model.credited[token][user] + chainQuote[0];
                if (chainQuote[2]) expect(onchain, `user ${user} ${token} on-chain total entitlement`).to.equal(frozen);
                else expect(onchain <= frozen, `user ${user} ${token} on-chain entitlement within the frozen total`).to.equal(true);
              }
            }
          }

          // Withdrawal can never be blocked: every matured lock, and every lock once exit is on, withdraws.
          // (Skipped within a minute of `end`, where the simulated call's timestamp could cross it.)
          for (let user = 0; user < users.length; user++) {
            const position = model.positions[user];
            if (position.amount === 0n) {
              await expect(vault.connect(users[user]).withdraw.staticCall(), `user ${user} no lock`)
                .to.be.revertedWithCustomError(vault, 'NoLock');
            } else if (model.exit.on || now >= position.end + 60n) {
              await vault.connect(users[user]).withdraw.staticCall();
            } else if (now + 60n < position.end) {
              await expect(vault.connect(users[user]).withdraw.staticCall(), `user ${user} still locked`)
                .to.be.revertedWithCustomError(vault, 'LockActive');
            }
          }

          const epochs = new Set([today - 1n, today, today + 1n, ...extraEpochs]);
          if (full) {
            for (let epoch = dayOf(launch); epoch < today; epoch++) epochs.add(epoch);
            for (let user = 0; user < users.length; user++) {
              const history = model.history(user);
              expect(await vault.userEpochCount(addresses[user]), `user ${user} history size`)
                .to.equal(BigInt(history.length));
              for (let i = 0; i < history.length; i++) {
                expect(await vault.userEpochAt(addresses[user], i), `user ${user} history ${i}`)
                  .to.equal(history[i]);
              }
            }
            for (const token of TOKENS) {
              for (const [epoch, amount] of model.budgets[token]) {
                expect(await vault.epochRewards(tokenAddress[token], epoch), `${token} budget day ${epoch}`)
                  .to.equal(amount);
              }
              const totalBudgets = [...model.budgets[token].values()].reduce((a, b) => a + b, 0n);
              // An expired token's old budgets stay in storage, unreachable; its forfeit is in `released`.
              if (model.status[token] !== 'expired') {
                expect(totalBudgets, `${token} additive seven-day budgets`)
                  .to.equal(model.notified[token] - model.released[token]);
              }
            }
          }
          for (const epoch of epochs) if (epoch >= 0n) await checkArea(epoch);
          checks++;
        }

        async function send(label, tx, apply, extraEpochs = []) {
          const receipt = await (await tx).wait();
          const at = BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
          trace.push(`${trace.length}: t=${at} day=${dayOf(at)} ${label}`);
          const returned = apply(at);
          await checkState(trace.length % 12 === 0, extraEpochs);
          return { at, returned };
        }

        async function advance(seconds) {
          const target = await currentTime() + seconds;
          await network.provider.send('evm_setNextBlockTimestamp', [Number(target)]);
          await network.provider.send('evm_mine');
          trace.push(`${trace.length}: t=${target} day=${dayOf(target)} advance ${seconds}s`);
          await checkState(trace.length % 12 === 0);
        }

        const amount = () => (100n + BigInt(rand(900))) * WAD + BigInt(rand(10_000));
        const funding = () => (7n + BigInt(rand(10_000))) * WAD + BigInt(rand(7));

        // payer === undefined: plain lock/increaseAmount. Otherwise lockFor/increaseAmountFor
        // from `payer`, which may also be the beneficiary itself.
        async function lock(user, duration, payer) {
          const value = amount();
          const tx = payer === undefined
            ? vault.connect(users[user]).lock(value, duration)
            : vault.connect(users[payer]).lockFor(addresses[user], value, duration);
          return send(`lock${payer === undefined ? '' : `For by u${payer}`} u${user} amount=${value} days=${duration}`,
            tx, (at) => model.lock(user, value, duration, at, payer ?? user));
        }

        async function topup(user, payer) {
          const value = amount();
          const tx = payer === undefined
            ? vault.connect(users[user]).increaseAmount(value)
            : vault.connect(users[payer]).increaseAmountFor(addresses[user], value);
          return send(`topup${payer === undefined ? '' : `For by u${payer}`} u${user} amount=${value}`,
            tx, (at) => model.topup(user, value, at, payer ?? user));
        }

        async function expectRevert(label, tx, error) {
          await expect(tx, label).to.be.revertedWithCustomError(vault, error);
          trace.push(`${trace.length}: ${label} reverted ${error}`);
          await checkState();
        }

        // Predicts the outcome from the model; skips (advances) only within MARGIN of a boundary
        // (expiry, the 10-day line, midnight) where the next block's timestamp could change it.
        // Returns 'compounded', a revert name, or 'skipped'.
        const MARGIN = 600n;
        async function compound(user, limit, maxFee = 200n) {
          const now = await currentTime();
          const position = model.positions[user];
          const label = `compound u${user} limit=${limit} maxFee=${maxFee}`;
          const call = () => vault.connect(users[user]).compound(limit, maxFee);
          let expected;
          if (model.fee.bps > maxFee) expected = 'FeeAboveMax'; // checked before the lock
          else if (position.amount === 0n) expected = 'NoLock';
          else if (now >= position.end) expected = 'LockExpired';
          else if (position.end - now > MARGIN && position.end - now < 10n * DAY - MARGIN) expected = 'ExtendFirst';
          else if (position.end - now > 10n * DAY + MARGIN) {
            const quoted = model.quote('pulp', user, dayOf(now), limit);
            const net = quoted.amount - quoted.amount * model.fee.bps / 10_000n;
            if (net === 0n && dayOf(now + MARGIN) === dayOf(now)) expected = 'NothingToCompound';
            else if (net !== 0n) expected = 'compounded';
          }
          if (expected === undefined) {
            await advance(MARGIN * 2n);
            return 'skipped';
          }
          if (expected !== 'compounded') {
            await expectRevert(label, call(), expected);
            return expected;
          }
          const lockedBefore = model.positions[user].amount;
          const tx = call();
          const { returned } = await send(label, tx,
            (at) => model.compound(user, dayOf(at), limit, at));
          expect(returned.net, 'compounded something').to.be.greaterThan(0n);
          expect(returned.fee).to.equal(returned.amount * model.fee.bps / 10_000n);
          expect(model.positions[user].amount).to.equal(lockedBefore + returned.net);
          await expect(tx).to.emit(vault, 'Compounded')
            .withArgs(addresses[user], returned.net, returned.fee, BigInt(returned.cursor));
          return expected;
        }

        async function setFee() {
          const bps = FEE_RATES[rand(FEE_RATES.length)];
          await send(`setCompoundFee ${bps}`, vault.connect(owner).setCompoundFee(bps), () => { model.fee.bps = bps; });
        }

        async function extend(user, duration) {
          const oldEnd = model.positions[user].end;
          const result = await send(`extend u${user} days=${duration}`,
            vault.connect(users[user]).extend(duration),
            (at) => model.extend(user, duration, at),
            [dayOf(oldEnd), dayOf(oldEnd + DAY), dayOf(oldEnd + 30n * DAY)]);
          return result;
        }

        async function withdraw(user) {
          const before = await pulp.balanceOf(addresses[user]);
          const { end, amount: principal } = model.positions[user];
          const now = await currentTime();
          // An early (emergency) withdrawal rewrites today's and every later scheduled day: check them all.
          // Nothing touches areas after the switch; check every day the lock still had scheduled.
          const touched = [];
          for (let epoch = dayOf(now); now < end && epoch <= dayOf(end - 1n); epoch++) touched.push(epoch);
          // Everyone else's on-chain claimable page, read just before and just after: equal.
          const others = async () => {
            const pages = [];
            for (let other = 0; other < users.length; other++) {
              if (other === user) continue;
              for (const token of TOKENS.filter(model.books)) pages.push((await vault.claimable(addresses[other], tokenAddress[token], 64)).join());
            }
            return pages;
          };
          const othersBefore = await others();
          await send(`withdraw u${user}${now < end ? ' (early, exit on)' : ''}`,
            vault.connect(users[user]).withdraw(), () => model.withdraw(user), touched);
          expect(await pulp.balanceOf(addresses[user])).to.equal(before + principal);
          if (model.exit.on) expect(await others(), `others' claimable unchanged by u${user}'s withdrawal`).to.deep.equal(othersBefore);
        }

        async function enableExit() {
          let original;
          const { at } = await send('enableEmergencyExit', vault.connect(owner).enableEmergencyExit(), (t) => {
            original = model.enableExit(t);
            for (const token of TOKENS) {
              for (let user = 0; user < users.length; user++) entitledAtExit[token][user] = model.entitlement(token, user, dayOf(t));
            }
          });
          // The exit-day rule against the plain rational: each locker's exit-day payout is
          // budget * elapsed/DAY * area/total, rounded down (at most two units below it).
          const elapsed = at - model.exit.epoch * DAY;
          for (const token of TOKENS) {
            let sum = 0n;
            for (let user = 0; user < users.length; user++) {
              const mine = model.areaBefore(user, at);
              const pay = model.exit.total === 0n ? 0n : model.budget(token, model.exit.epoch) * mine / model.exit.total;
              const num = original[token] * elapsed * mine, den = DAY * (model.exit.total || 1n);
              expect(pay * den <= num && num - pay * den < 2n * den, `u${user} ${token} exit-day payout`).to.equal(true);
              sum += pay;
            }
            expect(sum <= original[token] * elapsed / DAY, `${token} exit-day payouts within the earned part`).to.equal(true);
          }
          await expectRevert('enableEmergencyExit again', vault.connect(owner).enableEmergencyExit(), 'EmergencyExitActive');
        }

        // Release an unpayable day (the exit day or later, whatever its area, or zero area) if there is one;
        // otherwise show that a day before the exit day with area cannot be released.
        async function release(token) {
          if (!model.books(token)) {
            await expectRevert(`release ${token} (no books)`, vault.releaseEmptyRewards(tokenAddress[token], model.exit.epoch + 1n), 'NotRewardToken');
            return;
          }
          const days = [...model.budgets[token]].filter(([, amount]) => amount !== 0n).map(([epoch]) => epoch);
          const empty = days.filter((epoch) => model.unpayable(epoch));
          if (empty.length) {
            const epoch = empty[rand(empty.length)];
            const { returned } = await send(`release ${token} day=${epoch}`,
              vault.releaseEmptyRewards(tokenAddress[token], epoch), (at) => model.release(token, epoch, at), [epoch]);
            expect(returned, 'released a budget').to.be.greaterThan(0n);
            await expectRevert(`release ${token} day=${epoch} again`,
              vault.releaseEmptyRewards(tokenAddress[token], epoch), 'NothingToFund');
          } else if (days.length) {
            await expectRevert(`release ${token} earned day`,
              vault.releaseEmptyRewards(tokenAddress[token], days[rand(days.length)]), 'EpochHasPower');
          } else await advance(DAY);
        }

        // One call releases every budget after the exit day. They all sit in the seven days the contract scans.
        async function releasePostExit(token) {
          if (!model.books(token)) {
            await expectRevert(`releasePostExit ${token} (no books)`, vault.releasePostExitRewards(tokenAddress[token]), 'NotRewardToken');
            return;
          }
          const after = [...model.budgets[token]].filter(([epoch, amount]) => amount !== 0n && epoch > model.exit.epoch);
          const first = max(model.exit.epoch + 1n, (launch + DAY - 1n) / DAY);
          for (const [epoch] of after) {
            expect(epoch >= first && epoch < first + 7n, `post-exit budget day ${epoch} inside the scanned window`).to.equal(true);
          }
          if (after.length === 0) {
            await expectRevert(`releasePostExit ${token} (nothing)`, vault.releasePostExitRewards(tokenAddress[token]), 'NothingToFund');
            return;
          }
          const total = after.reduce((sum, [, amount]) => sum + amount, 0n);
          expect(await vault.releasePostExitRewards.staticCall(tokenAddress[token]), 'released total').to.equal(total);
          await send(`releasePostExit ${token} ${total}`, vault.releasePostExitRewards(tokenAddress[token]),
            (at) => { for (const [epoch] of after) model.release(token, epoch, at); }, after.map(([epoch]) => epoch));
          await expectRevert(`releasePostExit ${token} again`, vault.releasePostExitRewards(tokenAddress[token]), 'NothingToFund');
        }

        // Only released budgets are excess; the owner's sweep takes exactly those, to the treasury only.
        async function recover(token) {
          const due = model.released[token] - model.recovered[token];
          const asset = assetOf[token];
          const to = model.treasury.current;
          if (due === 0n) {
            await expectRevert(`recoverExcess ${token} (nothing)`, vault.connect(owner).recoverExcess(tokenAddress[token]), 'NothingToRecover');
            return;
          }
          const before = await asset.balanceOf(to);
          // The owner or the current treasury itself; either way only to the current treasury.
          const caller = rand(2) === 0 ? owner : candidates[candidateAddresses.indexOf(to)];
          await send(`recoverExcess ${token} ${due} by ${caller === owner ? 'owner' : 'treasury'}`,
            vault.connect(caller).recoverExcess(tokenAddress[token]), () => model.sweep(token, due));
          expect(await asset.balanceOf(to), `${token} swept`).to.equal(before + due);
        }

        // Everything that would add principal, area or budget reverts once exit is on, whatever the lock state.
        async function blocked(user) {
          const calls = [
            ['lock', () => vault.connect(users[user]).lock(WAD, 30)],
            ['lockFor', () => vault.connect(users[user]).lockFor(addresses[(user + 1) % users.length], WAD, 10)],
            ['increaseAmount', () => vault.connect(users[user]).increaseAmount(WAD)],
            ['increaseAmountFor', () => vault.connect(users[user]).increaseAmountFor(addresses[(user + 1) % users.length], WAD)],
            ['compound', () => vault.connect(users[user]).compound(64, 200)],
            ['extend', () => vault.connect(users[user]).extend(30)],
            ['notify', () => vault.connect(distributor).notifyRewardAmount(rewardAddress, 7n * WAD)],
            ['recycle', () => vault.recycleEmptyRewards(rewardAddress, dayOf(launch))],
          ];
          const [name, call] = calls[rand(calls.length)];
          await expectRevert(`${name} u${user} after exit`, call(), 'EmergencyExitActive');
        }

        async function notify(token) {
          const value = funding();
          if (model.status[token] !== 'active') {
            await expectRevert(`notify ${token} (${model.status[token]})`,
              vault.connect(distributor).notifyRewardAmount(tokenAddress[token], value), 'NotRewardToken');
            return;
          }
          const { returned: first } = await send(`notify ${token} amount=${value}`,
            vault.connect(distributor).notifyRewardAmount(tokenAddress[token], value),
            (at) => model.notify(token, value, at));
          for (let epoch = first - 1n; epoch <= first + 7n; epoch++) {
            expect(await vault.epochRewards(tokenAddress[token], epoch), `${token} notify boundary day ${epoch}`)
              .to.equal(model.budget(token, epoch));
          }
        }

        // `to` !== user: claimTo, the user's own page sent to another user.
        async function claim(token, user, limit, repeatIfCaughtUp = false, to = user) {
          const asset = assetOf[token];
          if (!model.books(token)) {
            await expectRevert(`claim ${token} u${user} (no books)`, to === user
              ? vault.connect(users[user]).claim(tokenAddress[token], limit)
              : vault.connect(users[user]).claimTo(tokenAddress[token], limit, addresses[to]), 'NotRewardToken');
            return;
          }
          async function once() {
            const before = await asset.balanceOf(addresses[to]);
            const { returned } = await send(`claim${to === user ? '' : `To u${to}`} ${token} u${user} limit=${limit}`,
              to === user ? vault.connect(users[user]).claim(tokenAddress[token], limit)
                : vault.connect(users[user]).claimTo(tokenAddress[token], limit, addresses[to]),
              (at) => model.claim(token, user, dayOf(at), limit, to));
            expect(await asset.balanceOf(addresses[to])).to.equal(before + returned.amount);
            return returned;
          }
          const first = await once();
          if (repeatIfCaughtUp && first.caughtUp) {
            const second = await once();
            expect(second.amount, 'idempotent closed-day claim').to.equal(0n);
            expect(second.cursor).to.equal(first.cursor);
          }
        }

        // --- Registry lifecycle of 'aux' (remove / re-add / expire) and treasury handovers ---

        // Near midnight (before the exit) the window the contract scans can move between quote and block.
        const nearMidnight = (t) => !model.exit.on && dayOf(t + MARGIN) !== dayOf(t);

        async function removeAux() {
          const call = () => vault.connect(owner).removeRewardToken(auxAddress);
          if (model.status.aux !== 'active') return expectRevert(`remove aux (${model.status.aux})`, call(), 'NotRewardToken');
          const t = await currentTime();
          if (nearMidnight(t)) return advance(MARGIN * 2n);
          if (model.scheduledDay('aux', dayOf(t)) !== null) return expectRevert('remove aux (scheduled)', call(), 'RewardsStillScheduled');
          const retire = model.owed('aux') !== 0n;
          const tx = call();
          await send(`remove aux (${retire ? 'retired' : 'dropped'})`, tx, (at) => model.remove('aux', at));
          await expect(tx).to.emit(vault, 'RewardTokenRemoved').withArgs(auxAddress, retire);
        }

        async function addAux() {
          const call = () => vault.connect(owner).addRewardToken(auxAddress);
          if (model.status.aux === 'active') return expectRevert('add aux (active)', call(), 'RewardTokenExists');
          if (model.status.aux === 'expired') return expectRevert('add aux (expired)', call(), 'ExpiredRewardToken');
          const owedBefore = model.owed('aux');
          await send(`add aux (${model.status.aux})`, call(), () => model.add('aux'));
          expect(await vault.reserved(auxAddress), 'reactivated with its books').to.equal(owedBefore);
        }

        // Permissionless: a random user closes the books.
        async function expireAux(jump) {
          const caller = users[rand(users.length)];
          const call = () => vault.connect(caller).expireRewardToken(auxAddress);
          if (model.status.aux !== 'retired') return expectRevert(`expire aux (${model.status.aux})`, call(), 'NotRetiredRewardToken');
          const deadline = model.retiredAt.aux + CLAIM_DEADLINE;
          let t = await currentTime();
          if (jump && t < deadline + MARGIN) {
            await advance(deadline + MARGIN - t + BigInt(rand(3_600)));
            t = await currentTime();
          }
          if (t + MARGIN < deadline) return expectRevert('expire aux (too early)', call(), 'ClaimDeadlineNotReached');
          if (t < deadline + MARGIN) return advance(MARGIN * 2n);
          const forfeited = model.owed('aux');
          const tx = call();
          await send(`expire aux forfeited=${forfeited}`, tx, (at) => model.expire('aux', at));
          await expect(tx).to.emit(vault, 'RewardTokenExpired').withArgs(auxAddress, forfeited);
        }

        // Mostly the step that can succeed in the current state; sometimes one that must be refused.
        async function auxLifecycle() {
          const r = rand(20);
          const state = model.status.aux;
          if (state === 'active') {
            if (r < 16) await removeAux();
            else if (r < 18) await addAux();
            else await expireAux(false);
          } else if (state === 'retired') {
            if (r < 7) await addAux();
            else if (r < 13) await expireAux(false);
            else if (r < 17) await expireAux(true);
            else await removeAux();
          } else if (state === 'dropped') {
            if (r < 14) await addAux();
            else if (r < 17) await expireAux(false);
            else await removeAux();
          } else if (r < 7) await addAux();
          else if (r < 14) await expireAux(false);
          else await removeAux();
        }

        async function proposeTreasury() {
          const cancel = rand(6) === 0;
          const next = cancel ? ethers.ZeroAddress : candidateAddresses[rand(candidateAddresses.length)];
          await send(`proposeTreasury ${cancel ? '(cancel)' : next}`, vault.connect(owner).proposeTreasury(next), (at) => {
            model.treasury.pending = cancel ? null : next;
            model.treasury.proposedAt = cancel ? 0n : at;
          });
        }

        async function acceptTreasury() {
          const T = model.treasury;
          if (T.pending === null) {
            const who = candidates[rand(candidates.length)];
            return expectRevert('acceptTreasury (nothing pending)', vault.connect(who).acceptTreasury(), 'NotPendingTreasury');
          }
          const signer = candidates[candidateAddresses.indexOf(T.pending)];
          const call = () => vault.connect(signer).acceptTreasury();
          const t = await currentTime();
          const acceptableAt = max(T.proposedAt, T.lastReleasedAt) + TREASURY_DELAY;
          if (t + MARGIN < acceptableAt) {
            if (rand(2) === 0) return expectRevert('acceptTreasury (delay)', call(), 'TreasuryDelayNotOver');
            return advance(acceptableAt + MARGIN - t + BigInt(rand(3 * 86_400))); // wait it out, then try again later
          }
          if (t < acceptableAt + MARGIN || nearMidnight(t)) return advance(MARGIN * 2n);
          // Active tokens first, then retired ones: the order the contract scans.
          const order = TOKENS.filter((k) => model.status[k] === 'active').concat(TOKENS.filter((k) => model.status[k] === 'retired'));
          const blocking = order.map((k) => model.scheduledDay(k, dayOf(t))).find((d) => d !== null);
          if (blocking !== undefined) return expectRevert(`acceptTreasury (day ${blocking} not earned)`, call(), 'UnearnedRewardsScheduled');
          const previous = T.current;
          const tx = call();
          await send(`acceptTreasury ${T.pending}`, tx, () => {
            T.current = T.pending;
            T.pending = null;
            T.proposedAt = 0n;
          });
          await expect(tx).to.emit(vault, 'TreasuryChanged').withArgs(previous, model.treasury.current);
        }

        async function treasuryAction() {
          if (model.treasury.pending === null || rand(8) === 0) await proposeTreasury();
          else await acceptTreasury();
        }

        await network.provider.send('evm_setNextBlockTimestamp', [Number(launch)]);
        await lock(0, 10n); // Exact launch: 2e18 snapshot.
        await lock(1, 20n);
        await lock(2, 30n);
        await lock(3, 10n);
        await notify('rwd');
        await notify('pulp');
        await advance(3n * DAY);
        await topup(1); // Mid-window new principal gets a smaller bonus.
        await extend(0, 20n); // Replace future trajectory, retain past area.
        await claim('rwd', 0, 64, true);
        // PULP rewards re-locked at today's multiplier; then a third party tops up the same lock.
        expect(await compound(2, 64)).to.equal('compounded');
        expect(await compound(2, 64)).to.equal('NothingToCompound');
        await topup(2, 3);
        expect(await compound(3, 64)).to.equal('ExtendFirst'); // 7 days left on a 10-day lock.
        await advance(11n * DAY);
        await extend(1, 30n);
        await topup(1); // Past early window: new principal gets exactly 1e18.
        await notify('rwd'); // Overlapping schedules add, not overwrite.
        await notify('pulp');
        await advance(31n * DAY);
        expect(await compound(2, 64)).to.equal('LockExpired');
        await extend(2, 10n); // Expired restart reprices saved principal.
        await withdraw(3);
        expect(await compound(3, 64)).to.equal('NoLock');
        await lock(3, 30n, 0); // lockFor: user 0 pays for user 3's new lock.
        await expectRevert('release before exit', vault.releaseEmptyRewards(rewardAddress, dayOf(launch)), 'EmergencyExitOff');

        const exitAt = Math.floor(ACTIONS * 0.6) + rand(Math.floor(ACTIONS * 0.25));
        for (let action = 0; action < ACTIONS; action++) {
          const user = rand(users.length);
          const position = model.positions[user];
          const now = await currentTime();
          if (action === exitAt) {
            // Funding on the exit day itself, just before the switch: it reaches exitEpoch + 7. Nobody earns
            // it, stayers included; it is released with the exit day and everything after it.
            await notify('rwd');
            await notify('pulp');
            await enableExit();
          }
          if (model.exit.on) {
            const options = ['claim', 'advance', 'release', 'releasePostExit', 'recover', 'blocked', 'setFee', 'aux', 'aux', 'treasury', 'treasury'];
            if (position.amount !== 0n) options.push('withdraw', 'withdraw', 'withdraw');
            const chosen = options[rand(options.length)];
            if (chosen === 'withdraw') await withdraw(user);
            else if (chosen === 'claim') await claim(TOKENS[rand(3)], user, [1, 3, 64][rand(3)], true, rand(4) === 0 ? rand(users.length) : user);
            else if (chosen === 'release') await release(TOKENS[rand(3)]);
            else if (chosen === 'releasePostExit') await releasePostExit(TOKENS[rand(3)]);
            else if (chosen === 'recover') await recover(TOKENS[rand(3)]);
            else if (chosen === 'blocked') await blocked(user);
            else if (chosen === 'setFee') await setFee();
            else if (chosen === 'aux') await auxLifecycle();
            else if (chosen === 'treasury') await treasuryAction();
            else await advance((1n + BigInt(rand(4))) * DAY + BigInt(rand(7_200)));
            continue;
          }
          const options = ['notify', 'claim', 'advance', 'compound', 'setFee', 'aux', 'aux', 'treasury', 'treasury', 'recover'];
          if (position.amount === 0n) options.push('lock', 'lock', 'lockFor');
          else {
            options.push('extend', 'extend');
            if (now >= position.end) options.push('withdraw', 'withdraw');
            else if (position.end - now > 10n * DAY + 60n) options.push('topup', 'topupFor', 'compound', 'compound');
          }
          const chosen = options[rand(options.length)];
          if (chosen === 'lock') await lock(user, DURATIONS[rand(3)]);
          else if (chosen === 'lockFor') await lock(user, DURATIONS[rand(3)], rand(users.length));
          else if (chosen === 'topup') await topup(user);
          else if (chosen === 'topupFor') await topup(user, rand(users.length));
          else if (chosen === 'compound') {
            const fees = [200n, model.fee.bps, ...(model.fee.bps > 0n ? [model.fee.bps - 1n] : [])];
            await compound(user, [1, 3, 64][rand(3)], fees[rand(fees.length)]);
          }
          else if (chosen === 'extend') {
            const valid = DURATIONS.filter((d) => now + d * DAY > position.end + 60n);
            if (valid.length) await extend(user, valid[rand(valid.length)]);
            else await advance((1n + BigInt(rand(4))) * DAY + BigInt(rand(7_200)));
          } else if (chosen === 'withdraw') await withdraw(user);
          else if (chosen === 'setFee') await setFee();
          else if (chosen === 'notify') await notify(TOKENS[rand(3)]);
          else if (chosen === 'claim') await claim(TOKENS[rand(3)], user, [1, 3, 64][rand(3)], true, rand(4) === 0 ? rand(users.length) : user);
          else if (chosen === 'aux') await auxLifecycle();
          else if (chosen === 'treasury') await treasuryAction();
          else if (chosen === 'recover') await recover(TOKENS[rand(3)]);
          else await advance((1n + BigInt(rand(4))) * DAY + BigInt(rand(7_200)));
        }

        if (!model.exit.on) await enableExit();
        // Post-exit days go first, while stayers may still have area in them. Then everyone still locked
        // leaves early, and every remaining unpayable budget is released and swept.
        for (const token of TOKENS) await releasePostExit(token);
        for (let user = 0; user < users.length; user++) if (model.positions[user].amount !== 0n) await withdraw(user);
        expect(await vault.totalLocked(), 'all principal out').to.equal(0n);
        await advance(31n * DAY);
        for (const token of TOKENS) {
          for (const [epoch, amount] of [...model.budgets[token]]) {
            if (model.books(token) && amount !== 0n && model.unpayable(epoch)) {
              await send(`release ${token} day=${epoch}`, vault.releaseEmptyRewards(tokenAddress[token], epoch),
                (at) => model.release(token, epoch, at), [epoch]);
            }
          }
          await recover(token);
        }
        for (let user = 0; user < users.length; user++) {
          for (const token of TOKENS.filter(model.books)) {
            while (!model.quote(token, user, dayOf(await currentTime()), 64).caughtUp) await claim(token, user, 64);
            await claim(token, user, 64, true);
          }
        }
        await checkState(true);
        // Nothing after the exit day was paid or is still owed; what is left is rounding dust.
        for (const token of TOKENS) {
          for (const [epoch, amount] of model.budgets[token]) {
            if (epoch > model.exit.epoch) expect(amount, `${token} day ${epoch} after the exit day`).to.equal(0n);
          }
          for (let user = 0; user < users.length; user++) {
            if (model.status[token] === 'expired') {
              expect(model.credited[token][user] <= entitledAtExit[token][user], `u${user} ${token} paid within the frozen entitlement`).to.equal(true);
            } else {
              expect(model.credited[token][user], `u${user} ${token} paid exactly the frozen entitlement`).to.equal(entitledAtExit[token][user]);
            }
          }
          const asset = assetOf[token];
          expect(await asset.balanceOf(vaultAddress), `${token} only dust left`).to.equal(await vault.reserved(tokenAddress[token]));
        }
        // Finally close aux's books for good: retire it (if it still has books), wait out the claim deadline,
        // expire it and sweep the forfeit. Whatever happened to it during the run, nothing is left behind.
        if (model.status.aux === 'active') await removeAux();
        if (model.status.aux === 'retired') {
          await expireAux(true);
          while (model.status.aux === 'retired') await expireAux(false);
          await recover('aux');
        }
        await checkState(true);
        expect(await aux.balanceOf(vaultAddress), 'aux: nothing left').to.equal(await vault.reserved(auxAddress));
        expect(checks).to.be.greaterThan(80);
        const count = (re) => trace.filter((line) => re.test(line)).length;
        console.log(`      seed 0x${seed.toString(16)}: aux retired ${count(/ remove aux \(retired\)$/)},` +
          ` dropped ${count(/ remove aux \(dropped\)$/)}, re-added ${count(/ add aux \((retired|dropped)\)$/)},` +
          ` expired ${count(/ expire aux forfeited/)}, refused ${count(/(remove|add|expire) aux .*reverted/)};` +
          ` treasury accepted ${count(/ acceptTreasury 0x/)}, refused ${count(/acceptTreasury .*reverted/)}` +
          ` (${count(/not earned\) reverted/)} unearned); ${trace.length} steps`);
      } catch (error) {
        throw new Error(`Seed 0x${seed.toString(16)} failed. Exact action trace:\n${trace.join('\n')}\n${error.stack || error}`);
      }
    });
  }
});
