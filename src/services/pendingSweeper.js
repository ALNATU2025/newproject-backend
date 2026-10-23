// Every few minutes, re-checks pending bill payments with their provider so
// customers aren't left waiting for an admin. Payments still pending after
// 30 minutes raise an alert once.
const { Transaction } = require('../models');
const { BILL_SERVICES } = require('../models/constants');
const { requeryTransaction } = require('./requery');
const { raiseAlert } = require('./alerts');

const EVERY_MS = 3 * 60 * 1000;
const MIN_AGE_MS = 2 * 60 * 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const ALERT_AFTER_MS = 30 * 60 * 1000;

async function sweepOnce({ now = Date.now(), limit = 25 } = {}) {
  const pending = await Transaction.find({
    status: 'pending',
    type: { $in: [...BILL_SERVICES, 'payout'] },
    provider: { $nin: [null, 'none'] },
    createdAt: { $lte: new Date(now - MIN_AGE_MS), $gte: new Date(now - MAX_AGE_MS) },
  })
    .sort({ createdAt: 1 })
    .limit(limit);
  const results = [];
  for (const t of pending) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await requeryTransaction(t);
      results.push(r.result);
      if (r.result === 'pending' && now - t.createdAt.getTime() > ALERT_AFTER_MS && !(t.metadata && t.metadata.stuckAlerted)) {
        // eslint-disable-next-line no-await-in-loop
        await Transaction.updateOne({ _id: t._id }, { $set: { 'metadata.stuckAlerted': true } });
        // eslint-disable-next-line no-await-in-loop
        await raiseAlert({
          type: 'provider',
          severity: 'warning',
          title: 'Payment still pending',
          body: `${t.reference} (${t.description}) has been pending for over 30 minutes.`,
          user: t.user,
          transaction: t._id,
        });
      }
    } catch (e) {
      results.push('error');
    }
  }
  try {
    // eslint-disable-next-line global-require
    await require('./cards').sweepCards({ now });
  } catch (e) {
    results.push('error');
  }
  return results;
}

function startPendingSweeper() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce();
    } catch (e) {
      console.error('Pending sweeper:', e.message);
    } finally {
      running = false;
    }
  }, EVERY_MS);
  timer.unref();
  return timer;
}

module.exports = { sweepOnce, startPendingSweeper };
