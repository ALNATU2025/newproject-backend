// Earnings (commission + referral bonuses) and moving them to the wallet.
const express = require('express');
const { Transaction } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok, startOfLagosDay } = require('../utils/helpers');
const { toKobo, toNaira } = require('../utils/money');
const { getSettings } = require('../services/settings');
const { withdrawCommission } = require('../services/commission');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const today = startOfLagosDay();
    const weekStart = new Date(today.getTime() - 6 * 86400000);
    const [recent, perDay] = await Promise.all([
      Transaction.find({
        user: req.user._id,
        $or: [{ wallet: 'commission' }, { type: 'commission_withdrawal' }],
      })
        .sort({ createdAt: -1 })
        .limit(30),
      Transaction.aggregate([
        {
          $match: {
            user: req.user._id,
            wallet: 'commission',
            direction: 'credit',
            status: 'success',
            createdAt: { $gte: weekStart },
          },
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+01:00' } },
            total: { $sum: '$amount' },
          },
        },
      ]),
    ]);
    const byDay = Object.fromEntries(perDay.map((d) => [d._id, d.total]));
    const week = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(weekStart.getTime() + i * 86400000 + 3600000);
      const key = day.toISOString().slice(0, 10);
      return { date: key, amount: toNaira(byDay[key] || 0) };
    });
    ok(res, {
      balance: toNaira(req.user.commissionBalance),
      lifetime: toNaira(req.user.lifetimeCommission),
      movedToWallet: toNaira(req.user.commissionWithdrawn),
      minWithdrawal: toNaira(settings.minCommissionWithdrawal),
      week,
      recent: recent.map((t) => serialize.transaction(t)),
    });
  }),
);

router.post(
  '/withdraw',
  validate({ body: z.object({ amount: fields.amount.optional() }) }),
  asyncHandler(async (req, res) => {
    const amount = req.body.amount !== undefined ? toKobo(req.body.amount) : undefined;
    const txn = await withdrawCommission(req.user, amount);
    ok(res, { transaction: serialize.transaction(txn) }, 201);
  }),
);

module.exports = router;
