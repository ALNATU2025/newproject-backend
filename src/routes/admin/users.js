// Manage users: list, view, edit, approve, (de)activate, wallet credit/debit,
// PIN unlock/reset and history.
const express = require('express');
const { User, Transaction, AuditLog } = require('../../models');
const { requirePermission } = require('../../middleware/auth');
const { validate, z, fields } = require('../../middleware/validate');
const { asyncHandler, ok, pageParams, escapeRegex, makeReference } = require('../../utils/helpers');
const { toKobo, toNaira, currencyOf } = require('../../utils/money');
const { notFound, badRequest, forbidden } = require('../../utils/errors');
const wallet = require('../../services/wallet');
const { creditDeposit } = require('../../services/funding');
const pinService = require('../../services/pin');
const { audit } = require('../../services/alerts');
const { notify } = require('../../services/notify');
const { fmt } = require('../../services/limits');
const serialize = require('../../serializers');
const { normalizePhone, PHONE_HINT } = require('../../utils/phone');

const router = express.Router();
const idParam = validate({ params: z.object({ id: fields.objectId }) });

async function loadUser(id) {
  const u = await User.findById(id);
  if (!u) throw notFound('User not found.');
  return u;
}

router.get(
  '/',
  requirePermission('users:read'),
  validate({
    query: z.object({
      q: z.string().trim().max(60).optional(),
      filter: z.enum(['all', 'active', 'inactive', 'admins', 'pending', 'low_balance', 'online', 'dormant']).default('all'),
      sort: z.enum(['newest', 'last_seen']).default('newest'),
      country: z.enum(['NG', 'SL']).optional(),
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { q, filter } = req.query;
    const { page, limit, skip } = pageParams(req.query, 30);
    const where = {};
    if (filter === 'active') where.isActive = true;
    if (filter === 'inactive') where.isActive = false;
    if (filter === 'admins') where.role = { $ne: 'user' };
    if (filter === 'pending') where.isApproved = false;
    if (filter === 'low_balance') where.balance = { $lt: 500000 };
    // Seen in the last 15 minutes / not seen for 30 days.
    if (filter === 'online') where.lastSeenAt = { $gte: new Date(Date.now() - 15 * 60 * 1000) };
    if (filter === 'dormant') where.$and = [{ $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: new Date(Date.now() - 30 * 86400000) } }] }];
    if (req.query.country === 'SL') where.country = 'SL';
    if (req.query.country === 'NG') where.country = { $ne: 'SL' };
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      where.$or = [{ fullName: rx }, { email: rx }, { phone: rx }];
      if (/^[a-f\d]{24}$/i.test(q)) where.$or.push({ _id: q });
    }
    const [items, total, all, active, admins, pending, sums] = await Promise.all([
      User.find(where).sort(req.query.sort === 'last_seen' ? { lastSeenAt: -1, createdAt: -1 } : { createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(where),
      User.countDocuments({}),
      User.countDocuments({ isActive: true }),
      User.countDocuments({ role: { $ne: 'user' } }),
      User.countDocuments({ isApproved: false }),
      User.aggregate([
        { $group: { _id: { $ifNull: ['$country', 'NG'] }, balance: { $sum: '$balance' }, commission: { $sum: '$commissionBalance' }, users: { $sum: 1 } } },
      ]),
    ]);
    ok(res, {
      items: items.map((u) => serialize.user(u, { admin: true })),
      total,
      page,
      hasMore: skip + items.length < total,
      counts: { all, active, inactive: all - active, admins, pending },
      // Naira totals (Nigeria) plus a separate Leone total for Sierra Leone.
      totals: (() => {
        const ng = sums.find((r) => r._id !== 'SL') || {};
        const sl = sums.find((r) => r._id === 'SL') || {};
        return {
          walletBalance: toNaira(ng.balance || 0),
          commissionBalance: toNaira(ng.commission || 0),
          sl: { users: sl.users || 0, walletBalance: toNaira(sl.balance || 0), commissionBalance: toNaira(sl.commission || 0) },
        };
      })(),
    });
  }),
);

router.get(
  '/:id',
  requirePermission('users:read'),
  idParam,
  asyncHandler(async (req, res) => {
    const u = await loadUser(req.params.id);
    const [transactions, last] = await Promise.all([
      Transaction.countDocuments({ user: u._id }),
      Transaction.findOne({ user: u._id, type: { $nin: ['admin_credit', 'admin_debit', 'refund', 'commission', 'referral_bonus'] } }).sort({ createdAt: -1 }).select('createdAt description'),
    ]);
    ok(res, {
      ...serialize.user(u, { admin: true }),
      transactions,
      lastTransactionAt: (last && last.createdAt) || u.lastTransactionAt || null,
      lastTransaction: last ? last.description : null,
    });
  }),
);

router.patch(
  '/:id',
  requirePermission('users:write'),
  idParam,
  validate({
    body: z.object({
      fullName: fields.name.optional(),
      email: fields.email.optional(),
      phone: fields.accountPhone.optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const u = await loadUser(req.params.id);
    if (String(u._id) === String(req.user._id) && req.body.isActive === false) {
      throw badRequest('You cannot deactivate your own account.', 'SELF_ACTION');
    }
    if (u.role === 'super' && req.user.role !== 'super') {
      throw forbidden('Only a Super Admin can edit another Super Admin.');
    }
    if (req.body.phone && !normalizePhone(req.body.phone, u.country || 'NG')) {
      throw badRequest(PHONE_HINT[u.country || 'NG'], 'VALIDATION_ERROR');
    }
    const before = { fullName: u.fullName, email: u.email, phone: u.phone, isActive: u.isActive };
    Object.assign(u, req.body);
    if (req.body.isActive === false) u.tokenVersion = (u.tokenVersion || 0) + 1; // log them out
    await u.save();
    await audit(req.user._id, 'user.update', { targetUser: u._id, details: { before, after: req.body } });
    ok(res, serialize.user(u, { admin: true }));
  }),
);

router.post(
  '/:id/approve',
  requirePermission('users:approve'),
  idParam,
  asyncHandler(async (req, res) => {
    const u = await loadUser(req.params.id);
    u.isApproved = true;
    u.approvalNote = null;
    if (u.country === 'SL' && !u.tier) u.tier = 1;
    await u.save();
    await audit(req.user._id, 'user.approve', { targetUser: u._id });
    await notify(u._id, {
      title: 'Account approved',
      body: u.country === 'SL'
        ? 'Your account is approved at Tier 1. You can now make payments. Upgrade your account level for higher limits.'
        : 'Your account is approved. You can now make payments.',
      kind: 'security',
    });
    ok(res, serialize.user(u, { admin: true }));
  }),
);

/** Turn down a new account (it stays unable to transact). */
router.post(
  '/:id/reject',
  requirePermission('users:approve'),
  idParam,
  validate({ body: z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) }) }),
  asyncHandler(async (req, res) => {
    const u = await loadUser(req.params.id);
    u.isApproved = false;
    u.approvalNote = req.body.reason;
    await u.save();
    await audit(req.user._id, 'user.reject', { targetUser: u._id, details: { reason: req.body.reason } });
    await notify(u._id, {
      title: 'Account not approved',
      body: `We couldn't approve your account: ${req.body.reason}. Contact support if you think this is a mistake.`,
      kind: 'security',
    });
    ok(res, serialize.user(u, { admin: true }));
  }),
);

const REASONS = [
  'Manual Deposit',
  'Bonus / Goodwill',
  'Correcting undercharged amount',
  'Correcting overcharged amount',
  'Fraud / Suspicious Activity',
  'Custom Reason',
];

router.post(
  '/:id/wallet',
  requirePermission('wallet:fund'),
  idParam,
  validate({
    body: z.object({
      action: z.enum(['credit', 'debit']),
      amount: fields.amount,
      reason: z.string().trim().min(2).max(100),
      note: z.string().trim().max(300).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const u = await loadUser(req.params.id);
    const amount = toKobo(req.body.amount);
    const { action, reason, note } = req.body;
    let txn;
    if (action === 'credit' && reason === 'Manual Deposit') {
      // Counts as a real deposit (referral bonus, no fee).
      ({ transaction: txn } = await creditDeposit({
        userId: u._id,
        amount,
        method: 'manual',
        chargeFee: false,
        actor: req.user._id,
        note: note || reason,
        description: 'Wallet top-up · Manual deposit',
      }));
    } else {
      const moved = action === 'credit' ? await wallet.credit(u._id, amount) : await wallet.debit(u._id, amount);
      txn = await Transaction.create({
        user: u._id,
        reference: makeReference(action === 'credit' ? 'AC' : 'AD'),
        type: action === 'credit' ? 'admin_credit' : 'admin_debit',
        direction: action,
        amount,
        status: 'success',
        description: action === 'credit' ? `Credit · ${reason}` : `Debit · ${reason}`,
        balanceBefore: moved.before,
        balanceAfter: moved.after,
        actor: req.user._id,
        adminNote: note || reason,
      });
      await notify(u._id, {
        title: action === 'credit' ? 'Wallet credited' : 'Wallet debited',
        body: `${fmt(amount, currencyOf(u.country))} was ${action === 'credit' ? 'added to' : 'taken from'} your wallet (${reason}).`,
        kind: 'wallet',
      });
    }
    await audit(req.user._id, `wallet.${action}`, {
      targetUser: u._id,
      transaction: txn._id,
      details: { amount: toNaira(amount), reason, note: note || null },
    });
    const fresh = await User.findById(u._id);
    ok(res, { user: serialize.user(fresh, { admin: true }), transaction: serialize.transaction(txn, { admin: true }) });
  }),
);

router.post(
  '/:id/pin/unlock',
  requirePermission('users:pin'),
  idParam,
  asyncHandler(async (req, res) => {
    const u = await loadUser(req.params.id);
    await pinService.unlockPin(u._id);
    await audit(req.user._id, 'pin.unlock', { targetUser: u._id });
    ok(res, serialize.user(await User.findById(u._id), { admin: true }));
  }),
);

router.post(
  '/:id/pin/reset',
  requirePermission('users:pin'),
  idParam,
  asyncHandler(async (req, res) => {
    const u = await loadUser(req.params.id);
    await pinService.clearPin(u._id);
    await audit(req.user._id, 'pin.reset', { targetUser: u._id });
    await notify(u._id, {
      title: 'PIN reset by support',
      body: 'Your payment PIN was reset. Please create a new PIN before your next payment.',
      kind: 'security',
    });
    ok(res, serialize.user(await User.findById(u._id), { admin: true }));
  }),
);

router.get(
  '/:id/history',
  requirePermission('users:read'),
  idParam,
  asyncHandler(async (req, res) => {
    const u = await loadUser(req.params.id);
    const [transactions, activity, sums] = await Promise.all([
      Transaction.find({ user: u._id }).sort({ createdAt: -1 }).limit(100),
      AuditLog.find({ targetUser: u._id }).sort({ createdAt: -1 }).limit(50).populate('actor', 'fullName email phone'),
      Transaction.aggregate([
        { $match: { user: u._id, wallet: 'main', status: 'success' } },
        { $group: { _id: '$direction', total: { $sum: '$amount' } } },
      ]),
    ]);
    const total = (dir) => toNaira((sums.find((s) => s._id === dir) || {}).total || 0);
    ok(res, {
      user: serialize.user(u, { admin: true }),
      credits: total('credit'),
      debits: total('debit'),
      transactions: transactions.map((t) => serialize.transaction(t, { admin: true })),
      activity: activity.map((a) => ({
        id: String(a._id),
        action: a.action,
        details: a.details,
        actor: serialize.userBrief(a.actor),
        createdAt: a.createdAt,
      })),
    });
  }),
);

router.get('/meta/reasons', requirePermission('wallet:fund'), (req, res) => ok(res, REASONS));


module.exports = router;
