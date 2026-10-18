const express = require('express');
const { Dispute, Transaction } = require('../../models');
const { requirePermission } = require('../../middleware/auth');
const { validate, z, fields } = require('../../middleware/validate');
const { asyncHandler, ok } = require('../../utils/helpers');
const { toKobo } = require('../../utils/money');
const { notFound, badRequest } = require('../../utils/errors');
const { refundTransaction } = require('../../services/ledger');
const { audit } = require('../../services/alerts');
const { notify } = require('../../services/notify');
const serialize = require('../../serializers');

const router = express.Router();
router.use(requirePermission('disputes:manage'));

const POPULATE = [
  { path: 'user', select: 'fullName email phone' },
  { path: 'transaction' },
];

router.get(
  '/',
  validate({ query: z.object({ status: z.enum(['open', 'pending', 'investigating', 'resolved', 'rejected', 'all']).default('all') }) }),
  asyncHandler(async (req, res) => {
    const { status } = req.query;
    const filter = {};
    if (status === 'open') filter.status = { $in: ['pending', 'investigating'] };
    else if (status !== 'all') filter.status = status;
    const [items, open] = await Promise.all([
      Dispute.find(filter).sort({ createdAt: -1 }).limit(200).populate(POPULATE),
      Dispute.countDocuments({ status: { $in: ['pending', 'investigating'] } }),
    ]);
    ok(res, { items: items.map((d) => serialize.dispute(d, { admin: true })), open });
  }),
);

router.patch(
  '/:id',
  validate({ params: z.object({ id: fields.objectId }), body: z.object({ status: z.enum(['pending', 'investigating']) }) }),
  asyncHandler(async (req, res) => {
    const d = await Dispute.findById(req.params.id).populate(POPULATE);
    if (!d) throw notFound('Dispute not found.');
    if (['resolved', 'rejected'].includes(d.status)) throw badRequest('This dispute is already closed.');
    d.status = req.body.status;
    await d.save();
    ok(res, serialize.dispute(d, { admin: true }));
  }),
);

router.post(
  '/:id/resolve',
  validate({
    params: z.object({ id: fields.objectId }),
    body: z.object({
      action: z.enum(['approve', 'reject']),
      resolution: z.string().trim().min(3, 'Please enter resolution details').max(500),
      refundAmount: fields.amount.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const d = await Dispute.findById(req.params.id);
    if (!d) throw notFound('Dispute not found.');
    if (['resolved', 'rejected'].includes(d.status)) throw badRequest('This dispute is already closed.');
    const t = await Transaction.findById(d.transaction);
    if (!t) throw notFound('Transaction not found.');

    if (req.body.action === 'approve') {
      if (!t.refunded) {
        const amount = req.body.refundAmount !== undefined ? toKobo(req.body.refundAmount) : undefined;
        const { refund } = await refundTransaction(t, { amount, reason: req.body.resolution, actor: req.user._id });
        d.refundAmount = refund.amount;
      }
      d.status = 'resolved';
    } else {
      if (t.status === 'disputed') {
        t.status = t.statusBeforeDispute || 'success';
        t.statusBeforeDispute = null;
        await t.save();
      }
      d.status = 'rejected';
    }
    d.resolution = req.body.resolution;
    d.resolvedBy = req.user._id;
    d.resolvedAt = new Date();
    await d.save();
    await audit(req.user._id, `dispute.${req.body.action}`, {
      targetUser: d.user,
      transaction: t._id,
      details: { resolution: req.body.resolution },
    });
    await notify(d.user, {
      title: req.body.action === 'approve' ? 'Dispute resolved' : 'Dispute closed',
      body: `${t.reference}: ${req.body.resolution}`,
      kind: 'payment',
    });
    await d.populate(POPULATE);
    ok(res, serialize.dispute(d, { admin: true }));
  }),
);

module.exports = router;
