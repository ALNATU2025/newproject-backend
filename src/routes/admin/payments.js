// Admin money tools: self-fund, verify a payment, manual top-up.
const express = require('express');
const { Transaction, User } = require('../../models');
const { requirePermission } = require('../../middleware/auth');
const { validate, z, fields } = require('../../middleware/validate');
const { asyncHandler, ok, startOfLagosDay } = require('../../utils/helpers');
const { toKobo, toNaira } = require('../../utils/money');
const { notFound, badRequest } = require('../../utils/errors');
const { paymentProvider } = require('../../providers/payment');
const { creditDeposit } = require('../../services/funding');
const { verifyPin } = require('../../services/pin');
const { audit } = require('../../services/alerts');
const serialize = require('../../serializers');

const router = express.Router();

// ── Self fund (Super Admin only) ───────────────────────────

router.get(
  '/self-fund',
  requirePermission('wallet:self-fund'),
  asyncHandler(async (req, res) => {
    const history = await Transaction.find({ user: req.user._id, type: 'wallet_funding', 'metadata.method': 'self_fund' })
      .sort({ createdAt: -1 })
      .limit(20);
    ok(res, { balance: toNaira(req.user.balance), history: history.map((t) => serialize.transaction(t)) });
  }),
);

router.post(
  '/self-fund',
  requirePermission('wallet:self-fund'),
  validate({ body: z.object({ amount: fields.amount.max(1_000_000, 'Amount cannot exceed ₦1,000,000'), pin: fields.pin }) }),
  asyncHandler(async (req, res) => {
    await verifyPin(req.user._id, req.body.pin);
    const amount = toKobo(req.body.amount);
    const { transaction } = await creditDeposit({
      userId: req.user._id,
      amount,
      method: 'self_fund',
      chargeFee: false,
      actor: req.user._id,
      description: 'Admin self-funding',
    });
    await audit(req.user._id, 'wallet.self_fund', { targetUser: req.user._id, transaction: transaction._id, details: { amount: req.body.amount } });
    const me = await User.findById(req.user._id);
    ok(res, { balance: toNaira(me.balance), transaction: serialize.transaction(transaction) }, 201);
  }),
);

// ── Verify payments ────────────────────────────────────────

router.get(
  '/verify/stats',
  requirePermission('payments:verify'),
  asyncHandler(async (req, res) => {
    const [row] = await Transaction.aggregate([
      { $match: { type: 'wallet_funding', status: 'success', updatedAt: { $gte: startOfLagosDay() } } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]);
    ok(res, { verifiedToday: (row && row.count) || 0, amountToday: toNaira((row && row.amount) || 0) });
  }),
);

router.post(
  '/verify',
  requirePermission('payments:verify'),
  validate({ body: z.object({ reference: z.string().trim().min(6).max(80) }) }),
  asyncHandler(async (req, res) => {
    const ref = req.body.reference;
    const t = await Transaction.findOne({
      type: 'wallet_funding',
      $or: [{ reference: ref }, { providerReference: ref }],
    }).populate('user', 'fullName email phone');
    if (!t) return ok(res, { status: 'not_found', transaction: null });
    let status = t.status;
    if (t.status === 'pending' && paymentProvider().isConfigured()) {
      const r = await paymentProvider().verifyTransfer(t.reference);
      if (r.status === 'success') {
        await creditDeposit({
          userId: t.user._id,
          amount: r.amount || t.amount,
          method: (t.metadata && t.metadata.method) || 'one_time',
          providerReference: r.providerReference || null,
          pendingTxn: t,
          actor: req.user._id,
        });
        status = 'success';
      }
    }
    await audit(req.user._id, 'payment.verify', { transaction: t._id, targetUser: t.user._id, details: { result: status } });
    const fresh = await Transaction.findById(t._id).populate('user', 'fullName email phone');
    ok(res, { status, transaction: serialize.transaction(fresh, { admin: true }) });
  }),
);

/** Credit a user when a transfer arrived but wasn't matched. */
router.post(
  '/manual',
  requirePermission('wallet:fund'),
  validate({
    body: z.object({
      user: z.string().trim().min(3, 'Enter a user ID, email or phone'),
      amount: fields.amount,
      reference: z.string().trim().max(80).optional(),
      description: z.string().trim().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const key = req.body.user.toLowerCase();
    const query = /^[a-f\d]{24}$/.test(key) ? { _id: key } : key.includes('@') ? { email: key } : { phone: key };
    const u = await User.findOne(query);
    if (!u) throw notFound('User not found.');
    if (req.body.reference && (await Transaction.exists({ providerReference: req.body.reference, status: 'success' }))) {
      throw badRequest('A payment with this reference has already been credited.', 'ALREADY_CREDITED');
    }
    const { transaction } = await creditDeposit({
      userId: u._id,
      amount: toKobo(req.body.amount),
      method: 'manual',
      providerReference: req.body.reference || null,
      chargeFee: false,
      actor: req.user._id,
      note: req.body.description || null,
      description: 'Wallet top-up · Manual verification',
    });
    await audit(req.user._id, 'payment.manual', {
      targetUser: u._id,
      transaction: transaction._id,
      details: { amount: req.body.amount, reference: req.body.reference || null },
    });
    ok(res, { user: serialize.userBrief(u), transaction: serialize.transaction(transaction) }, 201);
  }),
);

module.exports = router;
