// Sierra Leone account levels (tiers). Each tier has a daily spending limit
// and a maximum wallet balance, in Leones:
//   Tier 1  after sign-up (once an admin approves the account)
//   Tier 2  ID document (NIN, national ID, passport, voter's card)
//   Tier 3  bank account
//   Tier 4  business licence
// Upgrades are requested by the customer and approved by an admin.
// Limits are editable in Admin → Settings (slTiers).
const { Transaction, User } = require('../models');
const { badRequest } = require('../utils/errors');
const { startOfLagosDay } = require('../utils/helpers');
const { formatMoney } = require('../utils/money');
const { raiseAlert } = require('./alerts');

const TIERS = [1, 2, 3, 4];

const TIER_INFO = {
  1: { name: 'Tier 1', requirement: 'Sign up and get approved' },
  2: { name: 'Tier 2', requirement: 'Add your NIN or another ID document' },
  3: { name: 'Tier 3', requirement: 'Connect your bank account' },
  4: { name: 'Tier 4', requirement: 'Add your business licence' },
};

const isSl = (user) => user && user.country === 'SL';
const tierOf = (user) => Math.min(4, Math.max(1, Number(user.tier) || 1));
const le = (minor) => formatMoney(minor, 'SLE');

function tierLimits(settings, tier) {
  const t = (settings.slTiers || {})[String(tier)] || {};
  return { daily: t.daily ?? null, maxBalance: t.maxBalance ?? null };
}

/** Leones spent today across every service (pending and successful). */
async function spentToday(userId) {
  const [row] = await Transaction.aggregate([
    {
      $match: {
        user: userId,
        direction: 'debit',
        wallet: { $ne: 'commission' },
        status: { $in: ['pending', 'success', 'disputed'] },
        createdAt: { $gte: startOfLagosDay() },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row ? row.total : 0;
}

/** Repeated blocked attempts look like probing: tell the admins once a day. */
async function noteBlocked(user, what) {
  try {
    const key = `tierBlocks.${new Date().toISOString().slice(0, 10)}`;
    const u = await User.findOneAndUpdate({ _id: user._id }, { $inc: { [key]: 1 } }, { new: true, projection: { tierBlocks: 1 } });
    const count = u && u.tierBlocks ? u.tierBlocks[new Date().toISOString().slice(0, 10)] : 0;
    if (count === 3) {
      await raiseAlert({
        type: 'suspicious',
        severity: 'warning',
        title: 'Repeated limit attempts',
        body: `${user.fullName} has been blocked by their Tier ${tierOf(user)} limit 3 times today (${what}).`,
        user: user._id,
      });
    }
  } catch {
    // never block the request on this
  }
}

/** Throws when [amount] (cents) would go over today's limit for the tier. */
async function assertDailyLimit(user, amount, settings) {
  if (!isSl(user)) return;
  const tier = tierOf(user);
  const { daily } = tierLimits(settings, tier);
  if (daily == null) return;
  const used = await spentToday(user._id);
  if (used + amount > daily) {
    await noteBlocked(user, 'daily limit');
    const left = Math.max(0, daily - used);
    throw badRequest(
      `Your Tier ${tier} daily limit is ${le(daily)}. You can still spend ${le(left)} today. Upgrade your account level for higher limits.`,
      'TIER_DAILY_LIMIT',
    );
  }
}

/**
 * Throws when receiving [amount] would take a Sierra Leone wallet over its
 * tier's maximum balance. [who] is used in the message ("your" / a name).
 */
async function assertCanReceive(userOrId, amount, settings, { who = 'your' } = {}) {
  const user = userOrId && userOrId.balance !== undefined && userOrId.country
    ? userOrId
    : await User.findById(userOrId).select('fullName country tier balance');
  if (!isSl(user)) return;
  const tier = tierOf(user);
  const { maxBalance } = tierLimits(settings, tier);
  if (maxBalance == null) return;
  if ((user.balance || 0) + amount > maxBalance) {
    await noteBlocked(user, 'balance limit');
    const room = Math.max(0, maxBalance - (user.balance || 0));
    throw badRequest(
      who === 'your'
        ? `Your Tier ${tier} wallet can hold up to ${le(maxBalance)}. You can add ${le(room)} more. Upgrade your account level to hold more.`
        : `${who}'s wallet can't receive this much right now (account level limit). Try a smaller amount.`,
      'TIER_BALANCE_LIMIT',
    );
  }
}

/** What the app shows on the Account level screen. */
function describe(user, settings) {
  const tier = tierOf(user);
  return {
    tier,
    approved: Boolean(user.isApproved),
    tiers: TIERS.map((t) => {
      const l = tierLimits(settings, t);
      return {
        tier: t,
        ...TIER_INFO[t],
        daily: l.daily == null ? null : l.daily / 100,
        maxBalance: l.maxBalance == null ? null : l.maxBalance / 100,
        reached: t <= tier,
      };
    }),
  };
}

module.exports = { TIERS, TIER_INFO, tierOf, tierLimits, spentToday, assertDailyLimit, assertCanReceive, describe, isSl };
