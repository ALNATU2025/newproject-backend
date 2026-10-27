// Bank-transfer top-ups (Nigeria) waiting for an admin: list, confirm,
// cancel. Confirm credits the exact amount at once.
const express = require('express');
const { Transaction } = require('../../models');
const { requirePermission } = require('../../middleware/auth');
const { validate, z, fields } = require('../../middleware/validate');
const { asyncHandler, ok } = require('../../utils/helpers');
const { audit } = require('../../services/alerts');
const bankFunding = require('../../services/bankFunding');

const router = express.Router();

router.get(
  '/bank',
  requirePermission('transactions:read'),
  asyncHandler(async (req, res) => {
    const list = await Transaction.find({ type: 'wallet_funding', status: 'pending', 'metadata.method': bankFunding.METHOD })
      .sort({ 'metadata.sentAt': -1, createdAt: -1 })
      .limit(100)
      .populate('user', 'fullName phone email');
    ok(res, {
      topUps: list.map((t) => ({
        ...bankFunding.view(t),
        user: t.user ? { id: String(t.user._id), fullName: t.user.fullName, phone: t.user.phone, email: t.user.email } : null,
      })),
    });
  }),
);

router.get(
  '/bank/:id',
  requirePermission('transactions:read'),
  validate({ params: z.object({ id: fields.objectId }) }),
  asyncHandler(async (req, res) => {
    const t = await Transaction.findOne({ _id: req.params.id, type: 'wallet_funding', 'metadata.method': bankFunding.METHOD }).populate('user', 'fullName phone email');
    if (!t) return ok(res, { topUp: null });
    return ok(res, {
      topUp: { ...bankFunding.view(t), user: t.user ? { id: String(t.user._id), fullName: t.user.fullName, phone: t.user.phone, email: t.user.email } : null },
    });
  }),
);

for (const action of ['confirm', 'cancel']) {
  router.post(
    `/bank/:id/${action}`,
    requirePermission('transactions:status'),
    validate({ params: z.object({ id: fields.objectId }), body: z.object({ note: z.string().trim().max(200).optional() }) }),
    asyncHandler(async (req, res) => {
      const r = await bankFunding.decide(req.params.id, action, { actor: req.user._id, note: req.body.note || null });
      if (r.result !== 'already') {
        await audit(req.user._id, `funding.bank.${action}`, { transaction: req.params.id, details: { amount: r.topUp.amount } });
      }
      ok(res, r);
    }),
  );
}

module.exports = router;
