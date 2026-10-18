const express = require('express');
const { Transaction, User } = require('../../models');
const { BILL_SERVICES } = require('../../models/constants');
const { requirePermission } = require('../../middleware/auth');
const { validate, z } = require('../../middleware/validate');
const { asyncHandler, ok, periodStart, startOfLagosDay } = require('../../utils/helpers');
const { toNaira } = require('../../utils/money');
const serialize = require('../../serializers');

const router = express.Router();

const periodSchema = z.object({ period: z.enum(['today', 'week', 'month', 'year', 'all']).default('today') });

async function purchaseTotals(from, to) {
  const [row] = await Transaction.aggregate([
    {
      $match: {
        type: { $in: BILL_SERVICES },
        status: 'success',
        createdAt: { $gte: from, $lt: to },
      },
    },
    {
      $group: {
        _id: null,
        volume: { $sum: '$amount' },
        revenue: { $sum: '$platformRevenue' },
        commission: { $sum: '$commission' },
        count: { $sum: 1 },
      },
    },
  ]);
  return row || { volume: 0, revenue: 0, commission: 0, count: 0 };
}

/** Last 7 days (oldest first) of a daily sum. */
async function last7Days(model, match, sumField) {
  const start = new Date(startOfLagosDay().getTime() - 6 * 86400000);
  const rows = await model.aggregate([
    { $match: { ...match, createdAt: { $gte: start } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+01:00' } },
        total: sumField ? { $sum: `$${sumField}` } : { $sum: 1 },
      },
    },
  ]);
  const map = Object.fromEntries(rows.map((r) => [r._id, r.total]));
  return Array.from({ length: 7 }, (_, i) => {
    const key = new Date(start.getTime() + i * 86400000 + 3600000).toISOString().slice(0, 10);
    return { date: key, value: map[key] || 0 };
  });
}

function change(now, before) {
  if (!before) return now ? 100 : 0;
  return Math.round(((now - before) / before) * 1000) / 10;
}

router.get(
  '/',
  requirePermission('dashboard:read'),
  validate({ query: periodSchema }),
  asyncHandler(async (req, res) => {
    const { period } = req.query;
    const now = new Date();
    const from = periodStart(period, now);
    const span = now.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - span);

    const [cur, prev, totalUsers, newUsers, prevNewUsers, txCount, pending, volume7d, users7d, recent] =
      await Promise.all([
        purchaseTotals(from, now),
        purchaseTotals(prevFrom, from),
        User.countDocuments({}),
        User.countDocuments({ createdAt: { $gte: from } }),
        User.countDocuments({ createdAt: { $gte: prevFrom, $lt: from } }),
        Transaction.countDocuments({ wallet: 'main', createdAt: { $gte: from } }),
        Transaction.countDocuments({ status: 'pending' }),
        last7Days(Transaction, { type: { $in: BILL_SERVICES }, status: 'success' }, 'amount'),
        last7Days(User, {}, null),
        Transaction.find({ wallet: 'main' }).sort({ createdAt: -1 }).limit(8).populate('user', 'fullName email phone'),
      ]);

    ok(res, {
      period,
      admin: { fullName: req.user.fullName, role: req.user.role },
      revenue: toNaira(cur.revenue),
      revenueChange: change(cur.revenue, prev.revenue),
      volume: toNaira(cur.volume),
      volumeChange: change(cur.volume, prev.volume),
      totalUsers,
      newUsers,
      newUsersChange: change(newUsers, prevNewUsers),
      transactions: txCount,
      pending,
      volume7d: volume7d.map((d) => ({ date: d.date, value: toNaira(d.value) })),
      users7d,
      recentTransactions: recent.map((t) => serialize.transaction(t, { admin: true })),
    });
  }),
);

module.exports = router;
