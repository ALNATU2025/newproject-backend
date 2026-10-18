// Development helpers. Mounted only when NODE_ENV is not production and the
// simulator payment provider is in use.
const express = require('express');
const { User, Transaction } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { toKobo } = require('../utils/money');
const { notFound } = require('../utils/errors');
const { creditDeposit } = require('../services/funding');

const router = express.Router();

/**
 * Pretend a bank transfer arrived for the logged-in user.
 * Body: { amount, reference? }  — reference completes a one-time account.
 */
router.post(
  '/simulate-transfer',
  requireAuth,
  validate({ body: z.object({ amount: fields.amount, reference: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    let pending = null;
    if (req.body.reference) {
      pending = await Transaction.findOne({ reference: req.body.reference, user: req.user._id, status: 'pending' });
      if (!pending) throw notFound('No pending top-up with that reference.');
    }
    const { transaction } = await creditDeposit({
      userId: req.user._id,
      amount: toKobo(req.body.amount),
      method: pending ? 'one_time' : 'bank_transfer',
      providerReference: `DEV${Date.now()}`,
      pendingTxn: pending,
      description: 'Wallet top-up · Bank transfer (simulated)',
    });
    const me = await User.findById(req.user._id);
    ok(res, { transaction: transaction.reference, balance: me.balance / 100 });
  }),
);

module.exports = router;
