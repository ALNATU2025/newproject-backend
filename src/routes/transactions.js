// The user's own transaction history.
const express = require('express');
const { Transaction } = require('../models');
const { TXN_TYPES, TXN_STATUSES } = require('../models/constants');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok, pageParams, escapeRegex } = require('../utils/helpers');
const { notFound } = require('../utils/errors');
const serialize = require('../serializers');
const { toNaira } = require('../utils/money');

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

// ── Dashboard: money in / out, by category, over time ─────────
// Completed payments on the main wallet, in the user's own currency and
// local time (Lagos UTC+1, Freetown UTC+0).
const PERIODS = { '7d': 7, '30d': 30, '90d': 90, year: 365 };
const CATEGORY = {
  airtime: 'airtime', international: 'airtime', sl_airtime: 'airtime', sl_international: 'airtime',
  data: 'data', sl_data: 'data',
  electricity: 'electricity', sl_electricity: 'electricity',
  cable: 'cable', sl_cable: 'cable',
  education: 'education',
  insurance: 'insurance',
  transfer_out: 'transfers', payout: 'transfers',
  card_create: 'cards', card_topup: 'cards',
};
const CATEGORY_LABELS = {
  airtime: 'Airtime', data: 'Data', electricity: 'Electricity', cable: 'Cable TV', education: 'Education',
  insurance: 'Insurance', transfers: 'Transfers', cards: 'Dollar Card', other: 'Other',
};
const DAY = 86400000;

router.get(
  '/summary',
  validate({ query: z.object({ period: z.enum(Object.keys(PERIODS)).optional() }) }),
  asyncHandler(async (req, res) => {
    const period = req.query.period || '30d';
    const sl = req.user.country === 'SL';
    const offMin = sl ? 0 : 60;
    const tz = sl ? '+00:00' : '+01:00';
    const now = Date.now();
    const localToday = Math.floor((now + offMin * 60000) / DAY) * DAY; // local midnight, as UTC ms
    let from;
    if (period === 'year') {
      const d = new Date(localToday);
      from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1);
    } else {
      from = localToday - (PERIODS[period] - 1) * DAY;
    }
    from -= offMin * 60000; // back to real UTC
    const prevFrom = from - (now - from);

    const counted = { status: 'success', wallet: 'main', type: { $ne: 'refund' } };
    const [agg] = await Transaction.aggregate([
      { $match: { user: req.user._id, createdAt: { $gte: new Date(prevFrom) } } },
      {
        $facet: {
          totals: [
            { $match: { createdAt: { $gte: new Date(from) } } },
            { $group: { _id: { wallet: '$wallet', direction: '$direction', type: '$type', status: '$status' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
          ],
          previous: [
            { $match: { createdAt: { $lt: new Date(from) }, ...counted } },
            { $group: { _id: '$direction', amount: { $sum: '$amount' } } },
          ],
          daily: [
            { $match: { createdAt: { $gte: new Date(from) }, ...counted } },
            {
              $group: {
                _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } }, direction: '$direction' },
                amount: { $sum: '$amount' },
              },
            },
          ],
        },
      },
    ]);

    const counts = { total: 0, success: 0, pending: 0, failed: 0 };
    let moneyIn = 0;
    let moneyOut = 0;
    let commissionEarned = 0;
    const cats = {};
    for (const g of agg.totals) {
      const { wallet, direction, type, status } = g._id;
      if (wallet === 'main') {
        counts.total += g.count;
        if (status === 'success') counts.success += g.count;
        else if (['pending', 'processing'].includes(status)) counts.pending += g.count;
        else if (['failed', 'reversed', 'refunded'].includes(status)) counts.failed += g.count;
      }
      if (status !== 'success') continue;
      if (wallet === 'commission') {
        if (direction === 'credit' && ['commission', 'referral_bonus'].includes(type)) commissionEarned += g.amount;
        continue;
      }
      if (type === 'refund') continue;
      if (direction === 'credit') moneyIn += g.amount;
      else {
        moneyOut += g.amount;
        const key = CATEGORY[type] || 'other';
        cats[key] = cats[key] || { key, label: CATEGORY_LABELS[key], amount: 0, count: 0 };
        cats[key].amount += g.amount;
        cats[key].count += g.count;
      }
    }
    const prev = Object.fromEntries(agg.previous.map((x) => [x._id, x.amount]));

    // Buckets: days (7d, 30d), weeks (90d) or months (year).
    const byDay = {};
    for (const d of agg.daily) {
      byDay[d._id.day] = byDay[d._id.day] || { in: 0, out: 0 };
      byDay[d._id.day][d._id.direction === 'credit' ? 'in' : 'out'] += d.amount;
    }
    const localFrom = from + offMin * 60000;
    const buckets = [];
    if (period === 'year') {
      const d0 = new Date(localFrom);
      for (let i = 0; i < 12; i += 1) {
        const start = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i, 1);
        buckets.push({ start, end: Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i + 1, 1) });
      }
    } else {
      const step = period === '90d' ? 7 : 1;
      for (let t = localFrom; t <= localToday; t += step * DAY) buckets.push({ start: t, end: Math.min(t + step * DAY, localToday + DAY) });
    }
    const series = buckets.map((b) => {
      let inn = 0;
      let out = 0;
      for (let t = b.start; t < b.end; t += DAY) {
        const v = byDay[new Date(t).toISOString().slice(0, 10)];
        if (v) {
          inn += v.in;
          out += v.out;
        }
      }
      return { date: new Date(b.start).toISOString().slice(0, 10), in: toNaira(inn), out: toNaira(out) };
    });

    ok(res, {
      period,
      unit: period === 'year' ? 'month' : period === '90d' ? 'week' : 'day',
      from: new Date(from),
      to: new Date(now),
      currency: sl ? 'SLE' : 'NGN',
      moneyIn: toNaira(moneyIn),
      moneyOut: toNaira(moneyOut),
      net: toNaira(moneyIn - moneyOut),
      commissionEarned: toNaira(commissionEarned),
      previous: { moneyIn: toNaira(prev.credit || 0), moneyOut: toNaira(prev.debit || 0) },
      counts,
      categories: Object.values(cats)
        .sort((a, b) => b.amount - a.amount)
        .map((c) => ({ ...c, amount: toNaira(c.amount), share: moneyOut ? Math.round((c.amount / moneyOut) * 1000) / 10 : 0 })),
      series,
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
