// Incoming payment notifications from the funding provider.
// Each provider's parseWebhook() checks the signature and returns a
// normalised event; crediting is idempotent on providerReference.
const express = require('express');
const { User, Transaction } = require('../models');
const { asyncHandler, ok } = require('../utils/helpers');
const { paymentProvider } = require('../providers/payment');
const { creditDeposit } = require('../services/funding');
const { raiseAlert } = require('../services/alerts');

const router = express.Router();

router.post(
  '/payment',
  asyncHandler(async (req, res) => {
    const event = paymentProvider().parseWebhook(req);
    if (event.event !== 'transfer.received') return ok(res, { ignored: true });

    // A one-time account payment (matched by our reference)…
    if (event.reference) {
      const pending = await Transaction.findOne({ reference: event.reference, type: 'wallet_funding' });
      if (pending && pending.status !== 'pending') {
        return ok(res, { credited: false, alreadyProcessed: true, reference: pending.reference });
      }
      if (pending) {
        const r = await creditDeposit({
          userId: pending.user,
          amount: event.amount,
          method: 'one_time',
          providerReference: event.providerReference,
          pendingTxn: pending,
        });
        return ok(res, { credited: !r.duplicate, reference: r.transaction.reference });
      }
    }
    // …or a transfer into a user's dedicated account.
    if (event.accountNumber) {
      const user = await User.findOne({ 'dedicatedAccount.accountNumber': event.accountNumber }).select('_id');
      if (user) {
        const r = await creditDeposit({
          userId: user._id,
          amount: event.amount,
          method: 'bank_transfer',
          providerReference: event.providerReference,
          description: 'Wallet top-up · Bank transfer',
        });
        return ok(res, { credited: !r.duplicate, reference: r.transaction.reference });
      }
    }
    await raiseAlert({
      type: 'wallet',
      severity: 'warning',
      title: 'Unmatched payment',
      body: `A payment of ₦${(event.amount / 100).toFixed(2)} (${event.providerReference}) didn't match any user.`,
    });
    return ok(res, { credited: false });
  }),
);

module.exports = router;
