// Refunds and the other balance movements shared by users and admins.
const { Transaction, User } = require('../models');
const { conflict, badRequest } = require('../utils/errors');
const { makeReference } = require('../utils/helpers');
const wallet = require('./wallet');
const { notify } = require('./notify');
const { fmt } = require('./limits');

/**
 * Returns money for a debit transaction to the user's main wallet, marks it
 * refunded and takes back any commission paid on it. `amount` (kobo)
 * defaults to the full amount. Safe against double refunds.
 */
async function refundTransaction(txn, { amount, reason, actor = null, status = 'refunded' } = {}) {
  if (txn.direction !== 'debit') throw badRequest('Only payments can be refunded.');
  const refundAmount = amount === undefined ? txn.amount : amount;
  if (refundAmount <= 0 || refundAmount > txn.amount) {
    throw badRequest('Refund amount must be between ₦0 and the payment amount.');
  }
  // Claim the refund atomically so two admins can't refund twice.
  const claimed = await Transaction.findOneAndUpdate(
    { _id: txn._id, refunded: false },
    { $set: { refunded: true, status } },
    { new: true },
  );
  if (!claimed) throw conflict('This payment has already been refunded.', 'ALREADY_REFUNDED');

  const { before, after } = await wallet.credit(txn.user, refundAmount);

  // Take back commission paid on this purchase (never below zero).
  if (txn.commission > 0) {
    await User.updateOne({ _id: txn.user }, [
      {
        $set: {
          commissionBalance: { $max: [0, { $subtract: ['$commissionBalance', txn.commission] }] },
          lifetimeCommission: { $max: [0, { $subtract: ['$lifetimeCommission', txn.commission] }] },
        },
      },
    ]);
  }

  const refund = await Transaction.create({
    user: txn.user,
    reference: makeReference('RF'),
    type: 'refund',
    direction: 'credit',
    amount: refundAmount,
    status: 'success',
    description: `Refund · ${txn.description || txn.reference}`,
    balanceBefore: before,
    balanceAfter: after,
    relatedTransaction: txn._id,
    actor,
    adminNote: reason || null,
    service: txn.service,
  });
  await notify(txn.user, {
    title: 'Refund received',
    body: `${fmt(refundAmount, txn.currency)} has been returned to your wallet for ${txn.description || txn.reference}.`,
    kind: 'wallet',
    data: { transactionId: String(refund._id) },
  });
  return { original: claimed, refund };
}

module.exports = { refundTransaction };
