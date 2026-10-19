// Settles a pending bill payment by asking its provider again. Used by the
// admin "Check with provider" button and the automatic pending sweeper.
const { Transaction } = require('../models');
const { BILL_SERVICES } = require('../models/constants');
const { billProvider } = require('../providers/bill');
const { getSettings } = require('./settings');
const { payPurchaseCommission } = require('./commission');
const { refundTransaction } = require('./ledger');
const { notify } = require('./notify');
const { fmt } = require('./limits');

/**
 * @returns {{ result: 'success'|'failed'|'pending', message: string|null }}
 * Throws when the provider can't be reached (the payment stays pending).
 */
async function requeryTransaction(t, { actor = null } = {}) {
  if (t.status !== 'pending' || !BILL_SERVICES.includes(t.type)) {
    return { result: t.status, message: 'Not a pending bill payment.' };
  }
  const r = await billProvider().requery(t.reference, { service: t.type, provider: t.provider });
  // Another request may have settled it meanwhile: only act if still pending.
  if (r.status === 'success') {
    const claimed = await Transaction.findOneAndUpdate(
      { _id: t._id, status: 'pending' },
      {
        $set: {
          status: 'success',
          providerReference: r.providerReference || t.providerReference,
          ...(r.data && r.data.providerRaw ? { 'metadata.providerRaw': r.data.providerRaw } : {}),
        },
      },
      { new: true },
    );
    if (claimed) {
      await payPurchaseCommission(claimed, await getSettings());
      await notify(claimed.user, {
        title: 'Payment successful',
        body: `${claimed.description} · ${fmt(claimed.amount)} was successful.`,
        kind: 'payment',
        data: { transactionId: String(claimed._id) },
      });
    }
  } else if (r.status === 'failed') {
    const fresh = await Transaction.findById(t._id);
    if (fresh && fresh.status === 'pending' && !fresh.refunded) {
      fresh.metadata = { ...(fresh.metadata || {}), failureReason: r.message || 'Failed at provider' };
      await fresh.save();
      await refundTransaction(fresh, { reason: r.message || 'Failed at provider', actor, status: 'failed' });
      await notify(fresh.user, {
        title: 'Payment failed',
        body: `${fresh.description} · ${fmt(fresh.amount)} failed. Your wallet has been refunded.`,
        kind: 'payment',
        data: { transactionId: String(fresh._id) },
      });
    }
  }
  return { result: r.status, message: r.message || null };
}

module.exports = { requeryTransaction };
