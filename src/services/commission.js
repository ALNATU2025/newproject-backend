// Commission paid to users on purchases, and moving earnings to the wallet.
const { Transaction, User } = require('../models');
const { SERVICE_LABELS } = require('../models/constants');
const { makeReference } = require('../utils/helpers');
const { percentOf } = require('../utils/money');
const { badRequest } = require('../utils/errors');
const wallet = require('./wallet');
const { notify } = require('./notify');
const { getSettings } = require('./settings');
const { fmt } = require('./limits');

function ratesFor(service, settings) {
  return (settings.commissionRates && settings.commissionRates[service]) || { user: 0, platform: 0 };
}

/** The % paid to this user: their own Cable TV rate if an admin set one. */
async function userRateFor(txn, rates) {
  if (txn.service !== 'cable') return rates.user;
  const u = await User.findById(txn.user).select('cableCommission').lean();
  const own = u && u.cableCommission;
  return typeof own === 'number' && own >= 0 ? own : rates.user;
}

/** Credits commission for a successful purchase and records revenue. */
async function payPurchaseCommission(txn, settings) {
  const rates = ratesFor(txn.service, settings);
  const commission = percentOf(txn.amount, await userRateFor(txn, rates));
  const platformRevenue = percentOf(txn.amount, rates.platform);
  txn.commission = commission;
  txn.platformRevenue = platformRevenue;
  await txn.save();
  if (commission <= 0) return;
  const { before, after } = await wallet.credit(txn.user, commission, {
    wallet: 'commission',
    extraInc: { lifetimeCommission: commission },
  });
  await Transaction.create({
    user: txn.user,
    reference: makeReference('CM'),
    type: 'commission',
    wallet: 'commission',
    direction: 'credit',
    amount: commission,
    status: 'success',
    service: txn.service,
    description: `${SERVICE_LABELS[txn.service] || 'Purchase'} commission`,
    balanceBefore: before,
    balanceAfter: after,
    relatedTransaction: txn._id,
  });
}

/** Moves earnings into the main wallet. `amount` (kobo) defaults to all. */
async function withdrawCommission(user, amount) {
  const settings = await getSettings();
  const available = user.commissionBalance || 0;
  const value = amount === undefined || amount === null ? available : amount;
  const sl = user.country === 'SL';
  const cur = sl ? 'SLE' : 'NGN';
  const min = sl ? settings.slMinCommissionWithdrawal : settings.minCommissionWithdrawal;
  if (value < min) {
    throw badRequest(`You can move earnings once you have ${fmt(min, cur)} or more.`, 'BELOW_MINIMUM');
  }
  if (value > available) throw badRequest('You don\'t have that much in earnings.', 'INSUFFICIENT_EARNINGS');

  // eslint-disable-next-line global-require
  await require('./tiers').assertCanReceive(user._id, value, settings);
  await wallet.debit(user._id, value, { wallet: 'commission' });
  const { before, after } = await wallet.credit(user._id, value, {
    extraInc: { commissionWithdrawn: value },
  });
  const txn = await Transaction.create({
    user: user._id,
    reference: makeReference('CW'),
    type: 'commission_withdrawal',
    direction: 'credit',
    amount: value,
    status: 'success',
    description: 'Earnings moved to wallet',
    balanceBefore: before,
    balanceAfter: after,
  });
  await notify(user._id, {
    title: 'Earnings moved',
    body: `${fmt(value, cur)} has been moved from your earnings to your wallet.`,
    kind: 'commission',
  });
  return txn;
}

module.exports = { ratesFor, payPurchaseCommission, withdrawCommission };
