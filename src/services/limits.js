// Service switches, maintenance mode, approval and spending limits.
const { Transaction } = require('../models');
const { SERVICE_LABELS } = require('../models/constants');
const { unavailable, forbidden, badRequest } = require('../utils/errors');
const { startOfLagosDay } = require('../utils/helpers');
const { formatMoney, currencyOfService } = require('../utils/money');
const { TRANSFER_SERVICES } = require('../models/constants');

/** "₦1,500.00" or "Le 25.00" (pass the currency; Naira by default). */
const fmt = (minor, currency = 'NGN') => formatMoney(minor, currency || 'NGN');

function assertServiceOpen(service, settings) {
  if (settings.maintenance) {
    throw unavailable(settings.maintenanceMessage || 'We\'re doing maintenance. Please try again soon.', 'MAINTENANCE');
  }
  if (settings.services && settings.services[service] === false) {
    throw unavailable(`${SERVICE_LABELS[service] || 'This service'} is unavailable right now.`, 'SERVICE_DISABLED');
  }
}

function assertCanTransact(user, settings) {
  // Sierra Leone accounts always wait for an admin's approval.
  if ((settings.requireApproval || user.country === 'SL') && !user.isApproved) {
    throw forbidden(
      'Your account is under review. Payments unlock once it\'s approved — usually within a few minutes.',
      'ACCOUNT_PENDING_APPROVAL',
    );
  }
}

function effectiveLimits(user, service, settings) {
  const def = (settings.limits && settings.limits[service]) || { perTxn: null, daily: null };
  const own = user.limits && typeof user.limits.get === 'function' ? user.limits.get(service) : null;
  if (!own) return { perTxn: def.perTxn ?? null, daily: def.daily ?? null, custom: false };
  return {
    perTxn: own.perTxn !== undefined ? own.perTxn : def.perTxn,
    daily: own.daily !== undefined ? own.daily : def.daily,
    custom: true,
  };
}

/** Total spent today on a service (pending and successful count). */
async function usedToday(userId, service) {
  const match = {
    user: userId,
    direction: 'debit',
    status: { $in: ['pending', 'success', 'disputed'] },
    createdAt: { $gte: startOfLagosDay() },
  };
  if (TRANSFER_SERVICES.includes(service)) match.type = 'transfer_out';
  else match.service = service;
  const [row] = await Transaction.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row ? row.total : 0;
}

async function assertWithinLimits(user, service, amount, settings) {
  // eslint-disable-next-line global-require
  await require('./tiers').assertDailyLimit(user, amount, settings);
  const cur = currencyOfService(service);
  const min = settings.minimums && settings.minimums[service];
  if (min && amount < min) {
    throw badRequest(`The minimum for ${SERVICE_LABELS[service]} is ${fmt(min, cur)}.`, 'BELOW_MINIMUM');
  }
  const { perTxn, daily } = effectiveLimits(user, service, settings);
  if (perTxn != null && amount > perTxn) {
    throw badRequest(`The maximum per transaction is ${fmt(perTxn, cur)}.`, 'LIMIT_PER_TRANSACTION');
  }
  if (daily != null) {
    const used = await usedToday(user._id, service);
    if (used + amount > daily) {
      const left = Math.max(0, daily - used);
      throw badRequest(
        `This goes over your daily limit of ${fmt(daily, cur)}. You can still spend ${fmt(left, cur)} today.`,
        'LIMIT_DAILY',
      );
    }
  }
}

module.exports = { assertServiceOpen, assertCanTransact, effectiveLimits, usedToday, assertWithinLimits, fmt };
