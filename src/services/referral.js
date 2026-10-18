// Referral bonuses: when a referred user's first deposit reaches the minimum,
// the new user and their referrer each get a bonus, and the referrer's own
// referrer gets a smaller indirect bonus. Bonuses go to the earnings wallet.
const { User, Transaction } = require('../models');
const { makeReference } = require('../utils/helpers');
const wallet = require('./wallet');
const { notify } = require('./notify');
const { getSettings } = require('./settings');
const { fmt } = require('./limits');

async function payBonus(userId, amount, kind, description) {
  if (!userId || amount <= 0) return;
  const field = `referralEarnings.${kind}`;
  const { before, after } = await wallet.credit(userId, amount, {
    wallet: 'commission',
    extraInc: { lifetimeCommission: amount, [field]: amount },
  });
  await Transaction.create({
    user: userId,
    reference: makeReference('RB'),
    type: 'referral_bonus',
    wallet: 'commission',
    direction: 'credit',
    amount,
    status: 'success',
    description,
    balanceBefore: before,
    balanceAfter: after,
    metadata: { kind },
  });
  await notify(userId, {
    title: 'Referral bonus',
    body: `${fmt(amount)} ${description.toLowerCase()} has been added to your earnings.`,
    kind: 'referral',
  });
}

/** Call after money lands in a user's wallet from a deposit. */
async function onDeposit(userId, depositAmount) {
  const settings = await getSettings();
  const { bonus, indirectBonus, minFirstDeposit } = settings.referral;
  if (depositAmount < minFirstDeposit) return;

  // Only once per user, even if two deposits arrive together.
  const claimed = await User.findOneAndUpdate(
    { _id: userId, firstDepositRewarded: false },
    { $set: { firstDepositRewarded: true } },
    { new: true },
  );
  if (!claimed || !claimed.referredBy) return;

  const referrer = await User.findById(claimed.referredBy).select('fullName referredBy isActive');
  if (!referrer || !referrer.isActive) return;

  await payBonus(claimed._id, bonus, 'welcome', 'Welcome bonus');
  await payBonus(referrer._id, bonus, 'direct', `Referral bonus for ${claimed.fullName}`);
  if (referrer.referredBy) {
    await payBonus(referrer.referredBy, indirectBonus, 'indirect', 'Indirect referral bonus');
  }
}

module.exports = { onDeposit };
