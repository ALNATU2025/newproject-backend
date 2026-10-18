// The user's own transaction history.
const express = require('express');
const { Transaction } = require('../models');
const { TXN_TYPES, TXN_STATUSES } = require('../models/constants');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok, pageParams, escapeRegex } = require('../utils/helpers');
const { notFound } = require('../utils/errors');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);

const listQuery = z.object({
  status: z.enum(TXN_STATUSES).optional(),
  type: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter((t) => TXN_TYPES.includes(t)) : undefined)),
  wallet: z.enum(['main', 'commission', 'all']).optional(),
  q: z.string().trim().max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { status, type, wallet = 'main', q, from, to } = req.query;
    const { page, limit, skip } = pageParams(req.query);
    const filter = { user: req.user._id };
    if (wallet !== 'all') filter.wallet = wallet;
    if (status) filter.status = status;
    if (type && type.length) filter.type = { $in: type };
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = from;
      if (to) filter.createdAt.$lte = new Date(to.getTime() + 86399999);
    }
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ description: rx }, { reference: rx }, { recipient: rx }];
    }
    const [items, total] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Transaction.countDocuments(filter),
    ]);
    ok(res, {
      items: items.map((t) => serialize.transaction(t)),
      page,
      limit,
      total,
      hasMore: skip + items.length < total,
    });
  }),
);

router.get(
  '/:id',
  validate({ params: z.object({ id: fields.objectId }) }),
  asyncHandler(async (req, res) => {
    const txn = await Transaction.findOne({ _id: req.params.id, user: req.user._id });
    if (!txn) throw notFound('Transaction not found.');
    ok(res, serialize.transaction(txn));
  }),
);

module.exports = router;
