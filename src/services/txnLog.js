// Writes every transaction to the server logs (Render → Logs), one line
// each: when it is created and whenever its status changes. Failed ones
// say why. Search the logs for "[TXN]" (all), "[TXN] FAILED" (failures) or
// a reference / customer name.
//
//   [TXN] SUCCESS | debit ₦1,000.00 | Airtime MTN 0803***4567 | Foday Sesay (0803***4567, NG) | ref DP-AB12 | vtpass
//   [TXN] FAILED  | debit ₦5,000.00 | Electricity 4512***901 | Aminata Kamara (076***123, SL) | ref DP-CD34 | reason: Invalid meter number | refunded
//
// PINs, passwords, tokens and card numbers are never logged; phone and
// account numbers are partly hidden. LOG_TRANSACTIONS=off turns it off.
const { formatMoney } = require('../utils/money');

const LABEL = { success: 'SUCCESS', failed: 'FAILED', pending: 'PENDING', processing: 'PROCESSING', reversed: 'REVERSED', refunded: 'REFUNDED', disputed: 'DISPUTED' };

const enabled = () => {
  const v = String(process.env.LOG_TRANSACTIONS || '').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0') return false;
  return process.env.NODE_ENV !== 'test' || v === 'on';
};

/** "08031234567" → "0803***4567"; short values stay as they are. */
function mask(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return s;
  const keepEnd = digits.length > 9 ? 4 : 3;
  return `${s.slice(0, 4)}***${s.slice(-keepEnd)}`;
}

const clean = (v, max = 160) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/** One readable line for a transaction (exported for tests). */
function format(t, user, { status } = {}) {
  const st = status || t.status;
  const meta = t.metadata || {};
  const currency = t.currency || (user && user.country === 'SL' ? 'SLE' : 'NGN');
  const who = user
    ? `${clean(user.fullName, 60) || 'No name'} (${mask(user.phone) || 'no phone'}, ${user.country || '?'})`
    : `user ${t.user}`;
  const what = [clean(t.description || t.type, 80), t.recipient ? mask(t.recipient) : ''].filter(Boolean).join(' ');
  const parts = [
    `[TXN] ${(LABEL[st] || String(st).toUpperCase()).padEnd(7)}`,
    `${t.direction} ${formatMoney(t.amount || 0, currency)}${t.wallet === 'commission' ? ' (earnings wallet)' : ''}`,
    what,
    who,
    `ref ${t.reference}`,
  ];
  if (t.provider) parts.push(t.provider);
  if (st === 'failed' || st === 'reversed') {
    const why = meta.failureReason || meta.reason || meta.providerMessage || meta.error;
    parts.push(`reason: ${clean(why) || 'not recorded'}`);
    if (t.refunded) parts.push('refunded');
  }
  if (st === 'refunded' && meta.refundReason) parts.push(`reason: ${clean(meta.refundReason)}`);
  return parts.join(' | ');
}

/** Logs a transaction (never throws). */
async function logTransaction(t, opts = {}) {
  if (!t || !enabled()) return;
  try {
    // eslint-disable-next-line global-require
    const User = require('mongoose').model('User');
    const user = t.user ? await User.findById(t.user).select('fullName phone country').lean() : null;
    const line = format(t, user, opts);
    const st = opts.status || t.status;
    if (st === 'failed' || st === 'reversed') console.warn(line);
    else console.log(line);
  } catch (e) {
    console.warn('[TXN] could not log', t && t.reference, e.message);
  }
}

module.exports = { logTransaction, format, mask };
