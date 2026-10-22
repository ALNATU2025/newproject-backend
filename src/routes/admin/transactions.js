// All transactions: list, export, detail, status changes, refunds, requery.
const express = require('express');
const { Transaction, User } = require('../../models');
const { TXN_STATUSES, BILL_SERVICES } = require('../../models/constants');
const { requirePermission } = require('../../middleware/auth');
const { validate, z, fields } = require('../../middleware/validate');
const { asyncHandler, ok, pageParams, escapeRegex } = require('../../utils/helpers');
const { toKobo, toNaira } = require('../../utils/money');
const { notFound, badRequest, unavailable } = require('../../utils/errors');
const { requeryTransaction } = require('../../services/requery');
const { refundTransaction } = require('../../services/ledger');
const { creditDeposit } = require('../../services/funding');
const { payPurchaseCommission } = require('../../services/commission');
const { getSettings } = require('../../services/settings');
const { audit, raiseAlert } = require('../../services/alerts');
const { notify } = require('../../services/notify');
const { fmt } = require('../../services/limits');
const serialize = require('../../serializers');

const router = express.Router();
const idParam = validate({ params: z.object({ id: fields.objectId }) });
const POPULATE = [
  { path: 'user', select: 'fullName email phone country' },
  { path: 'actor', select: 'fullName email phone' },
  { path: 'counterparty', select: 'fullName email phone' },
];

const listQuery = z.object({
  status: z.enum(TXN_STATUSES).optional(),
  service: z.string().optional(), // a transaction type, e.g. airtime, wallet_funding, transfer_out
  q: z.string().trim().max(80).optional(),
  sort: z.enum(['newest', 'oldest', 'highest', 'lowest']).default('newest'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  highest: { amount: -1 },
  lowest: { amount: 1 },
};

function buildFilter({ status, service, q, from, to }) {
  const f = { wallet: 'main' };
  if (status) f.status = status;
  if (service) f.type = service;
  if (from || to) {
    f.createdAt = {};
    if (from) f.createdAt.$gte = from;
    if (to) f.createdAt.$lte = new Date(to.getTime() + 86399999);
  }
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    f.$or = [{ reference: rx }, { description: rx }, { recipient: rx }, { providerReference: rx }];
  }
  return f;
}

/** Search by user name/email/phone too (resolved to user ids). */
async function withUserSearch(filter, q) {
  if (!q) return filter;
  const rx = new RegExp(escapeRegex(q), 'i');
  const ids = await User.find({ $or: [{ fullName: rx }, { email: rx }, { phone: rx }] }).distinct('_id');
  if (ids.length) filter.$or.push({ user: { $in: ids } });
  return filter;
}

router.get(
  '/',
  requirePermission('transactions:read'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const filter = await withUserSearch(buildFilter(req.query), req.query.q);
    const { page, limit, skip } = pageParams(req.query, 30);
    const [items, total, sum, statusCounts] = await Promise.all([
      Transaction.find(filter).sort(SORTS[req.query.sort]).skip(skip).limit(limit).populate(POPULATE),
      Transaction.countDocuments(filter),
      Transaction.aggregate([{ $match: filter }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
      Transaction.aggregate([{ $match: { wallet: 'main' } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    ok(res, {
      items: items.map((t) => serialize.transaction(t, { admin: true })),
      total,
      totalAmount: toNaira((sum[0] && sum[0].amount) || 0),
      counts: Object.fromEntries(statusCounts.map((s) => [s._id, s.n])),
      page,
      hasMore: skip + items.length < total,
    });
  }),
);

router.get(
  '/export.csv',
  requirePermission('transactions:export'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const filter = await withUserSearch(buildFilter(req.query), req.query.q);
    const items = await Transaction.find(filter).sort(SORTS[req.query.sort]).limit(10000).populate(POPULATE);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['Date,Reference,User,Email,Type,Description,Recipient,Status,Direction,Amount (NGN),Fee (NGN)'];
    for (const t of items) {
      lines.push(
        [
          t.createdAt.toISOString(),
          t.reference,
          t.user ? t.user.fullName : '',
          t.user ? t.user.email : '',
          t.type,
          t.description,
          t.recipient,
          t.status,
          t.direction,
          toNaira(t.amount).toFixed(2),
          toNaira(t.fee || 0).toFixed(2),
        ]
          .map(esc)
          .join(','),
      );
    }
    await audit(req.user._id, 'transactions.export', { details: { count: items.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dalabapay-transactions-${Date.now()}.csv"`);
    res.send(lines.join('\n'));
  }),
);

/** Bill payments waiting for a refund decision (pending or disputed). */
router.get(
  '/refund-queue',
  requirePermission('refunds:process'),
  asyncHandler(async (req, res) => {
    const [queue, refunded] = await Promise.all([
      Transaction.find({ type: { $in: BILL_SERVICES }, status: { $in: ['pending', 'disputed'] }, refunded: false })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate(POPULATE),
      Transaction.find({ refunded: true, type: { $in: BILL_SERVICES } })
        .sort({ updatedAt: -1 })
        .limit(50)
        .populate(POPULATE),
    ]);
    ok(res, {
      queue: queue.map((t) => serialize.transaction(t, { admin: true })),
      refunded: refunded.map((t) => serialize.transaction(t, { admin: true })),
    });
  }),
);

router.get(
  '/:id',
  requirePermission('transactions:read'),
  idParam,
  asyncHandler(async (req, res) => {
    const t = await Transaction.findById(req.params.id).populate(POPULATE);
    if (!t) throw notFound('Transaction not found.');
    ok(res, serialize.transaction(t, { admin: true }));
  }),
);

/**
 * Change a transaction's status. Money moves only where it must:
 *   payment → failed/refunded : refunds the user (once)
 *   payment pending → success : marks delivered and pays commission
 *   funding pending → success : credits the wallet
 */
router.patch(
  '/:id/status',
  requirePermission('transactions:status'),
  idParam,
  validate({ body: z.object({ status: z.enum(TXN_STATUSES), note: z.string().trim().max(300).optional() }) }),
  asyncHandler(async (req, res) => {
    const t = await Transaction.findById(req.params.id);
    if (!t) throw notFound('Transaction not found.');
    const { status: next, note } = req.body;
    const prev = t.status;
    if (next === prev) throw badRequest(`This transaction is already ${prev}.`, 'NO_CHANGE');
    if (t.refunded || prev === 'refunded') {
      throw badRequest('This payment was already refunded, so its status can\'t change.', 'ALREADY_REFUNDED');
    }

    const isFunding = t.type === 'wallet_funding';
    const isPayment = t.direction === 'debit' && t.wallet === 'main';

    if (isFunding) {
      if (prev !== 'pending') throw badRequest('Only pending top-ups can be changed. Use Credit / Debit Wallet instead.');
      if (next === 'success') {
        await creditDeposit({ userId: t.user, amount: t.amount, method: (t.metadata && t.metadata.method) || 'assisted', pendingTxn: t, chargeFee: false, actor: req.user._id, note });
      } else if (next === 'failed') {
        t.status = 'failed';
        t.adminNote = note || null;
        t.actor = req.user._id;
        await t.save();
        await notify(t.user, { title: 'Top-up not completed', body: `Your top-up request ${t.reference} was not completed.${note ? ` ${note}` : ''}`, kind: 'wallet' });
      } else {
        throw badRequest('A pending top-up can only become successful or failed.');
      }
    } else if (isPayment) {
      if (next === 'failed' || next === 'refunded') {
        await refundTransaction(t, { reason: note || `Marked ${next} by admin`, actor: req.user._id, status: next });
      } else if (next === 'success') {
        if (prev === 'failed') throw badRequest('A failed payment can\'t be marked successful.');
        t.status = 'success';
        t.statusBeforeDispute = null;
        t.adminNote = note || t.adminNote;
        t.actor = req.user._id;
        await t.save();
        if (prev === 'pending' && BILL_SERVICES.includes(t.type) && !t.commission) {
          await payPurchaseCommission(t, await getSettings());
          await notify(t.user, { title: 'Payment successful', body: `${t.description} · ${fmt(t.amount, t.currency)} was successful.`, kind: 'payment' });
        }
      } else if (next === 'disputed') {
        t.statusBeforeDispute = prev;
        t.status = 'disputed';
        t.adminNote = note || t.adminNote;
        t.actor = req.user._id;
        await t.save();
      } else if (next === 'pending') {
        if (prev !== 'disputed') throw badRequest('Only disputed payments can go back to pending.');
        t.status = 'pending';
        t.adminNote = note || t.adminNote;
        t.actor = req.user._id;
        await t.save();
      }
    } else {
      throw badRequest('This kind of transaction can\'t change status. Use Credit / Debit Wallet instead.');
    }

    await audit(req.user._id, 'transaction.status', {
      targetUser: t.user,
      transaction: t._id,
      details: { from: prev, to: next, note: note || null },
    });
    await raiseAlert({
      type: 'status',
      title: 'Status changed',
      body: `${t.reference} marked ${next} by ${req.user.fullName}.`,
      transaction: t._id,
      user: t.user,
    });
    const fresh = await Transaction.findById(t._id).populate(POPULATE);
    ok(res, serialize.transaction(fresh, { admin: true }));
  }),
);

router.post(
  '/:id/refund',
  requirePermission('refunds:process'),
  idParam,
  validate({ body: z.object({ amount: fields.amount.optional(), reason: z.string().trim().max(300).optional() }) }),
  asyncHandler(async (req, res) => {
    const t = await Transaction.findById(req.params.id);
    if (!t) throw notFound('Transaction not found.');
    const amount = req.body.amount !== undefined ? toKobo(req.body.amount) : undefined;
    const { refund } = await refundTransaction(t, { amount, reason: req.body.reason, actor: req.user._id });
    await audit(req.user._id, 'transaction.refund', {
      targetUser: t.user,
      transaction: t._id,
      details: { amount: toNaira(refund.amount), reason: req.body.reason || null },
    });
    const fresh = await Transaction.findById(t._id).populate(POPULATE);
    ok(res, { transaction: serialize.transaction(fresh, { admin: true }), refund: serialize.transaction(refund, { admin: true }) });
  }),
);

/** Ask the provider again about a pending payment. */
router.post(
  '/:id/requery',
  requirePermission('transactions:status'),
  idParam,
  asyncHandler(async (req, res) => {
    const t = await Transaction.findById(req.params.id);
    if (!t) throw notFound('Transaction not found.');
    if (t.status !== 'pending' || !BILL_SERVICES.includes(t.type)) {
      throw badRequest('Only pending bill payments can be checked with the provider.');
    }
    let r;
    try {
      r = await requeryTransaction(t, { actor: req.user._id });
    } catch (e) {
      throw unavailable(`Couldn't reach the provider: ${e.message}`, 'PROVIDER_UNAVAILABLE');
    }
    await audit(req.user._id, 'transaction.requery', { transaction: t._id, targetUser: t.user, details: { result: r.result } });
    const fresh = await Transaction.findById(t._id).populate(POPULATE);
    ok(res, { result: r.result, message: r.message || null, transaction: serialize.transaction(fresh, { admin: true }) });
  }),
);

module.exports = router;
