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
      if (process.env.NODE_ENV !== 'test') console.warn(`[sweeper] ${t.reference} (${t.type}) check failed: ${e.message}`);
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

// ── VTpass (bill provider) wallet watcher ─────────────────────
// Checked every 30 minutes; while it is below Admin → Settings → low
// balance threshold, admins are alerted (push + Hawa) at most every 6 hours.
const BALANCE_EVERY_MS = 30 * 60 * 1000;
const BALANCE_REPEAT_MS = 6 * 60 * 60 * 1000;
const balanceWatch = { checkedAt: 0, alertedAt: 0 };

async function checkProviderBalance({ now = Date.now(), force = false } = {}) {
  if (!force && now - balanceWatch.checkedAt < BALANCE_EVERY_MS) return null;
  balanceWatch.checkedAt = now;
  // eslint-disable-next-line global-require
  const s = await require('./settings').getSettings();
  if (!s.lowBalanceAlerts) return null;
  // eslint-disable-next-line global-require
  const bp = require('../providers/bill').billProvider();
  const bal = await bp.balance();
  if (bal === null || bal === undefined) return null;
  if (bal >= s.lowBalanceThreshold) {
    balanceWatch.alertedAt = 0; // topped up: alert again next time it drops
    return { balance: bal, low: false };
  }
  if (now - balanceWatch.alertedAt >= BALANCE_REPEAT_MS) {
    balanceWatch.alertedAt = now;
    const naira = (k) => `₦${Math.round(k / 100).toLocaleString('en-NG')}`;
    await raiseAlert({
      type: 'provider',
      severity: 'critical',
      title: 'VTpass wallet is low',
      body: `The VTpass wallet has ${naira(bal)}, below your ${naira(s.lowBalanceThreshold)} alert level. Top it up on vtpass.com so payments don't fail.`,
      data: { balance: bal / 100 },
    });
  }
  return { balance: bal, low: true };
}

function startPendingSweeper() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce();
      await checkProviderBalance().catch((e) => console.warn('[balance watch]', e.message));
    } catch (e) {
      console.error('Pending sweeper:', e.message);
    } finally {
      running = false;
    }
  }, EVERY_MS);
  timer.unref();
  return timer;
}

module.exports = { sweepOnce, startPendingSweeper, checkProviderBalance, balanceWatch };
