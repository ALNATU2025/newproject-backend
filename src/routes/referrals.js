// Refer & earn: code, stats, bonus breakdown and people referred.
const express = require('express');
const { User } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, ok } = require('../utils/helpers');
const { toNaira } = require('../utils/money');
const { getSettings } = require('../services/settings');

const router = express.Router();
router.use(requireAuth);

function tierFor(count) {
  if (count >= 50) return 'Platinum';
  if (count >= 20) return 'Gold';
  if (count >= 5) return 'Silver';
  return 'Bronze';
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const me = req.user;
    const referred = await User.find({ referredBy: me._id })
      .select('fullName createdAt firstDepositRewarded')
      .sort({ createdAt: -1 })
      .limit(100);
    const pendingCount = referred.filter((r) => !r.firstDepositRewarded).length;
    const e = me.referralEarnings || {};
    const totalEarned = (e.direct || 0) + (e.indirect || 0) + (e.welcome || 0);
    ok(res, {
      code: me.referralCode,
      totalReferrals: referred.length,
      tier: tierFor(referred.length),
      totalEarned: toNaira(totalEarned),
      pendingEarnings: toNaira(pendingCount * settings.referral.bonus),
      breakdown: {
        direct: toNaira(e.direct || 0),
        indirect: toNaira(e.indirect || 0),
        welcome: toNaira(e.welcome || 0),
        commission: toNaira(Math.max(0, (me.lifetimeCommission || 0) - totalEarned)),
      },
      bonus: toNaira(settings.referral.bonus),
      indirectBonus: toNaira(settings.referral.indirectBonus),
      minFirstDeposit: toNaira(settings.referral.minFirstDeposit),
      referrals: referred.map((r) => ({
        name: r.fullName,
        joinedAt: r.createdAt,
        active: r.firstDepositRewarded,
        earned: r.firstDepositRewarded ? toNaira(settings.referral.bonus) : 0,
      })),
    });
  }),
);

module.exports = router;
