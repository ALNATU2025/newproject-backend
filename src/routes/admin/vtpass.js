// VTpass portal (Admin → Provider settings → VTpass portal): every payment
// Dalabapay sent through VTpass, with totals, success rate, the commission
// VTpass pays Dalabapay (reported by VTpass, or the configured rate,
// default 1.8%), the commission passed on to customers, charts, top failure
// reasons and the live VTpass wallet balance.
//
//   GET   /api/admin/vtpass/summary?period=today|week|month|year|all
//   GET   /api/admin/vtpass/transactions?status&service&q&from&to&page&limit
//   GET   /api/admin/vtpass/transactions.csv (same filters)
//   PATCH /api/admin/vtpass/settings { commissionRate }
const express = require('express');
const { Transaction, User } = require('../../models');
const { requirePermission } = require('../../middleware/auth');
const { validate, z } = require('../../middleware/validate');
const { asyncHandler, ok, periodStart, escapeRegex, pageParams } = require('../../utils/helpers');
const { toNaira } = require('../../utils/money');
const { getSettings, updateSettings } = require('../../services/settings');
const { audit } = require('../../services/alerts');
const { billProvider } = require('../../providers/bill');

const router = express.Router();
const TZ = '+01:00'; // Lagos

const SERVICE_LABEL = {
  cable: 'Cable TV',
  international: 'International airtime',
  airtime: 'Airtime',
  data: 'Data',
  electricity: 'Electricity',
  education: 'Education',
  insurance: 'Insurance',
};

const rateOf = (s) => (typeof s.vtpassCommissionRate === 'number' ? s.vtpassCommissionRate : 1.8);

// VTpass reports its commission in naira on each payment; as kobo, or null.
const reportedKobo = {
  $let: {
    vars: { c: { $convert: { input: '$metadata.providerRaw.commission', to: 'double', onError: null, onNull: null } } },
    in: { $cond: [{ $gt: ['$$c', 0] }, { $multiply: ['$$c', 100] }, null] },
  },
};

/** Commission earned on one payment (kobo): VTpass's figure, else amount × rate. */
const earnedKobo = (rate) => ({ $ifNull: [reportedKobo, { $multiply: ['$amount', rate / 100] }] });

function baseFilter(q = {}) {
  const f = { provider: 'vtpass' };
  if (q.status === 'pending') f.status = { $in: ['pending', 'processing'] };
  else if (q.status) f.status = q.status;
  if (q.service) f.type = q.service;
  if (q.from || q.to) {
    f.createdAt = {};
    if (q.from) f.createdAt.$gte = new Date(`${q.from}T00:00:00+01:00`);
    if (q.to) f.createdAt.$lte = new Date(`${q.to}T23:59:59.999+01:00`);
  }
  return f;
}

async function withSearch(filter, q) {
  if (!q) return filter;
  const rx = new RegExp(escapeRegex(q), 'i');
  const ids = await User.find({ $or: [{ fullName: rx }, { email: rx }, { phone: rx }] }).distinct('_id');
  return {
    ...filter,
    $or: [{ reference: rx }, { recipient: rx }, { providerReference: rx }, { 'metadata.providerRaw.transactionId': rx }, { user: { $in: ids } }],
  };
}

// ── Dashboard ──────────────────────────────────────────────
router.get(
  '/summary',
  requirePermission('commission:read'),
  validate({ query: z.object({ period: z.enum(['today', 'week', 'month', 'year', 'all']).default('month') }) }),
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    const rate = rateOf(s);
    const { period } = req.query;
    const from = periodStart(period);
    const match = { provider: 'vtpass', createdAt: { $gte: from } };
    const ok_ = { ...match, status: 'success' };
    const monthly = period === 'year' || period === 'all';
    const bucket = { $dateToString: { format: monthly ? '%Y-%m' : '%Y-%m-%d', date: '$createdAt', timezone: TZ } };

    const bp = billProvider();
    const [statusRows, totals, byService, series, reasons, balance] = await Promise.all([
      Transaction.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
      Transaction.aggregate([
        { $match: ok_ },
        {
          $group: {
            _id: null,
            volume: { $sum: '$amount' },
            earned: { $sum: earnedKobo(rate) },
            reported: { $sum: { $ifNull: [reportedKobo, 0] } },
            reportedCount: { $sum: { $cond: [{ $ne: [reportedKobo, null] }, 1, 0] } },
            paidToUsers: { $sum: { $ifNull: ['$commission', 0] } },
            count: { $sum: 1 },
          },
        },
      ]),
      Transaction.aggregate([
        { $match: match },
        {
          $group: {
            _id: { type: '$type', name: { $ifNull: ['$metadata.provider', null] } },
            count: { $sum: 1 },
            success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            volume: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, '$amount', 0] } },
            earned: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, earnedKobo(rate), 0] } },
          },
        },
        { $sort: { volume: -1 } },
      ]),
      Transaction.aggregate([
        { $match: match },
        {
          $group: {
            _id: bucket,
            volume: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, '$amount', 0] } },
            earned: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, earnedKobo(rate), 0] } },
            success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'reversed']] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Transaction.aggregate([
        { $match: { ...match, status: { $in: ['failed', 'reversed'] } } },
        {
          $group: {
            _id: { $ifNull: ['$metadata.failureReason', { $ifNull: ['$metadata.providerMessage', 'Not recorded'] }] },
            count: { $sum: 1 },
            last: { $max: '$createdAt' },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 6 },
      ]),
      bp.name === 'vtpass' ? bp.balance().catch(() => null) : Promise.resolve(null),
    ]);

    const counts = { total: 0, success: 0, failed: 0, pending: 0, refunded: 0 };
    for (const r of statusRows) {
      counts.total += r.count;
      if (r._id === 'success') counts.success += r.count;
      else if (r._id === 'failed' || r._id === 'reversed') counts.failed += r.count;
      else if (r._id === 'pending' || r._id === 'processing') counts.pending += r.count;
      else if (r._id === 'refunded') counts.refunded += r.count;
    }
    const t = totals[0] || { volume: 0, earned: 0, reported: 0, reportedCount: 0, paidToUsers: 0, count: 0 };
    const decided = counts.success + counts.failed;

    ok(res, {
      period,
      from,
      currency: 'NGN',
      commissionRate: rate,
      provider: { name: bp.name, environment: bp.environment, configured: bp.isConfigured() },
      balance: balance === null || balance === undefined ? null : toNaira(balance),
      lowBalance: balance !== null && balance !== undefined && balance < s.lowBalanceThreshold,
      lowBalanceThreshold: toNaira(s.lowBalanceThreshold),
      counts,
      successRate: decided ? Math.round((counts.success / decided) * 1000) / 10 : null,
      volume: toNaira(t.volume),
      commission: {
        earned: toNaira(Math.round(t.earned)), // VTpass → Dalabapay
        reportedByVtpass: toNaira(Math.round(t.reported)),
        reportedCount: t.reportedCount,
        estimatedCount: t.count - t.reportedCount,
        paidToUsers: toNaira(t.paidToUsers), // Dalabapay → customers
        net: toNaira(Math.round(t.earned - t.paidToUsers)),
      },
      averagePayment: t.count ? toNaira(Math.round(t.volume / t.count)) : 0,
      byService: byService.map((r) => ({
        service: r._id.type,
        provider: r._id.name,
        label: r._id.name ? `${r._id.name}` : SERVICE_LABEL[r._id.type] || r._id.type,
        group: SERVICE_LABEL[r._id.type] || r._id.type,
        count: r.count,
        success: r.success,
        volume: toNaira(r.volume),
        earned: toNaira(Math.round(r.earned)),
      })),
      series: series.map((r) => ({ date: r._id, volume: toNaira(r.volume), earned: toNaira(Math.round(r.earned)), success: r.success, failed: r.failed })),
      seriesUnit: monthly ? 'month' : 'day',
      topFailures: reasons.map((r) => ({ reason: r._id, count: r.count, last: r.last })),
    });
  }),
);

// ── Transactions ───────────────────────────────────────────
const listQuery = z.object({
  status: z.enum(['success', 'failed', 'pending', 'reversed', 'refunded', 'disputed']).optional(),
  service: z.string().max(40).optional(),
  q: z.string().trim().max(100).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function row(t, rate) {
  const raw = (t.metadata && t.metadata.providerRaw) || {};
  const rep = Number(raw.commission);
  const reported = Number.isFinite(rep) && rep > 0;
  const u = t.user && typeof t.user === 'object' ? t.user : null;
  return {
    id: String(t._id),
    reference: t.reference,
    createdAt: t.createdAt,
    service: t.type,
    serviceLabel: (t.metadata && t.metadata.provider) || SERVICE_LABEL[t.type] || t.type,
    description: t.description,
    recipient: t.recipient,
    amount: toNaira(t.amount),
    status: t.status,
    refunded: Boolean(t.refunded),
    user: u ? { id: String(u._id), fullName: u.fullName, phone: u.phone, country: u.country } : null,
    vtpass: {
      transactionId: raw.transactionId || t.providerReference || null,
      code: raw.code || null,
      status: raw.status || null,
      amount: raw.amount ?? null,
    },
    commission: t.status === 'success' ? (reported ? rep : Math.round(toNaira(t.amount) * rate) / 100) : 0,
    commissionReported: t.status === 'success' && reported,
    userCommission: toNaira(t.commission || 0),
    failureReason: (t.metadata && (t.metadata.failureReason || (t.status !== 'success' ? t.metadata.providerMessage : null))) || null,
  };
}

router.get(
  '/transactions',
  requirePermission('transactions:read'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const rate = rateOf(await getSettings());
    const filter = await withSearch(baseFilter(req.query), req.query.q);
    const { page, limit, skip } = pageParams(req.query, 25, 100);
    const [items, total, sums] = await Promise.all([
      Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'fullName phone country').lean(),
      Transaction.countDocuments(filter),
      Transaction.aggregate([
        { $match: filter },
        { $group: { _id: null, volume: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, '$amount', 0] } }, earned: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, earnedKobo(rate), 0] } } } },
      ]),
    ]);
    const s0 = sums[0] || { volume: 0, earned: 0 };
    ok(res, {
      items: items.map((t) => row(t, rate)),
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      totals: { volume: toNaira(s0.volume), commission: toNaira(Math.round(s0.earned)) },
      commissionRate: rate,
    });
  }),
);

router.get(
  '/transactions.csv',
  requirePermission('transactions:export'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const rate = rateOf(await getSettings());
    const filter = await withSearch(baseFilter(req.query), req.query.q);
    const list = await Transaction.find(filter).sort({ createdAt: -1 }).limit(20000).populate('user', 'fullName phone country').lean();
    const esc = (v) => {
      const x = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(x) || /^[=+\-@]/.test(x) ? `"${x.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : x;
    };
    const head = ['Date (Lagos)', 'Reference', 'VTpass ID', 'Customer', 'Phone', 'Country', 'Service', 'Recipient', 'Amount (NGN)', 'Status', 'Refunded', 'VTpass code', 'Commission (NGN)', 'Commission source', 'Paid to customer (NGN)', 'Failure reason'];
    const lines = [head.join(',')];
    for (const t of list) {
      const r = row(t, rate);
      const d = new Date(new Date(r.createdAt).getTime() + 3600000).toISOString().replace('T', ' ').slice(0, 19);
      lines.push([d, r.reference, r.vtpass.transactionId, r.user && r.user.fullName, r.user && r.user.phone, r.user && r.user.country, r.serviceLabel, r.recipient, r.amount, r.status, r.refunded ? 'yes' : 'no', r.vtpass.code, r.commission, r.commissionReported ? 'VTpass' : r.status === 'success' ? `${rate}% estimate` : '', r.userCommission, r.failureReason].map(esc).join(','));
    }
    await audit(req.user._id, 'vtpass.export', { details: { rows: list.length, filter: req.query } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vtpass-transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`﻿${lines.join('\n')}`);
  }),
);

// ── Settings ───────────────────────────────────────────────
router.patch(
  '/settings',
  requirePermission('commission:write'),
  validate({ body: z.object({ commissionRate: z.number().min(0).max(20) }) }),
  asyncHandler(async (req, res) => {
    const rate = Math.round(req.body.commissionRate * 100) / 100;
    await updateSettings({ vtpassCommissionRate: rate });
    await audit(req.user._id, 'vtpass.commission_rate', { details: { rate } });
    ok(res, { commissionRate: rate });
  }),
);

module.exports = router;
