// Users report a problem with one of their payments.
const express = require('express');
const { Dispute, Transaction } = require('../models');
const { DISPUTE_TYPES } = require('../models/constants');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { notFound, badRequest, conflict } = require('../utils/errors');
const { raiseAlert } = require('../services/alerts');
const { fmt } = require('../services/limits');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await Dispute.find({ user: req.user._id }).sort({ createdAt: -1 }).populate('transaction');
    const open = items.filter((d) => ['pending', 'investigating'].includes(d.status)).length;
    const resolved = items.filter((d) => d.status === 'resolved').length;
    ok(res, { items: items.map((d) => serialize.dispute(d)), total: items.length, open, resolved });
  }),
);

/** Payments the user can dispute (recent debits without an open dispute). */
router.get(
  '/eligible',
  asyncHandler(async (req, res) => {
    const openIds = await Dispute.find({ user: req.user._id, status: { $in: ['pending', 'investigating'] } }).distinct(
      'transaction',
    );
    const items = await Transaction.find({
      user: req.user._id,
      direction: 'debit',
      wallet: 'main',
      refunded: false,
      _id: { $nin: openIds },
      createdAt: { $gte: new Date(Date.now() - 90 * 86400000) },
    })
      .sort({ createdAt: -1 })
      .limit(30);
    ok(res, items.map((t) => serialize.transaction(t)));
  }),
);

router.post(
  '/',
  validate({
    body: z.object({
      transactionId: fields.objectId,
      type: z.enum(DISPUTE_TYPES),
      reason: z.string().trim().min(3, 'Please enter a reason').max(200),
      description: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const txn = await Transaction.findOne({ _id: req.body.transactionId, user: req.user._id });
    if (!txn) throw notFound('Transaction not found.');
    if (txn.direction !== 'debit') throw badRequest('Only payments can be disputed.');
    if (txn.refunded) throw badRequest('This payment has already been refunded.', 'ALREADY_REFUNDED');
    const open = await Dispute.exists({ transaction: txn._id, status: { $in: ['pending', 'investigating'] } });
    if (open) {
      throw conflict('You already have an open dispute for this transaction. Please wait for it to be resolved.', 'DISPUTE_EXISTS');
    }
    const dispute = await Dispute.create({
      user: req.user._id,
      transaction: txn._id,
      type: req.body.type,
      reason: req.body.reason,
      description: req.body.description || '',
    });
    if (txn.status !== 'disputed') {
      txn.statusBeforeDispute = txn.status;
      txn.status = 'disputed';
      await txn.save();
    }
    await raiseAlert({
      type: 'dispute',
      severity: 'warning',
      title: 'New dispute',
      body: `${req.user.fullName} disputed ${txn.reference} (${fmt(txn.amount)}): ${req.body.reason}`,
      user: req.user._id,
      transaction: txn._id,
    });
    await dispute.populate('transaction');
    ok(res, serialize.dispute(dispute), 201);
  }),
);

router.get(
  '/:id',
  validate({ params: z.object({ id: fields.objectId }) }),
  asyncHandler(async (req, res) => {
    const d = await Dispute.findOne({ _id: req.params.id, user: req.user._id }).populate('transaction');
    if (!d) throw notFound('Dispute not found.');
    ok(res, serialize.dispute(d));
  }),
);

module.exports = router;
