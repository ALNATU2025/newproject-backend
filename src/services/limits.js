// Service switches, maintenance mode, approval and spending limits.
const { Transaction } = require('../models');
const { SERVICE_LABELS } = require('../models/constants');
const { unavailable, forbidden, badRequest } = require('../utils/errors');
const { startOfLagosDay } = require('../utils/helpers');
const { toNaira } = require('../utils/money');

const fmt = (kobo) => `₦${toNaira(kobo).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function assertServiceOpen(service, settings) {
  if (settings.maintenance) {
    throw unavailable(settings.maintenanceMessage || 'We\'re doing maintenance. Please try again soon.', 'MAINTENANCE');
  }
  if (settings.services && settings.services[service] === false) {
    throw unavailable(`${SERVICE_LABELS[service] || 'This service'} is unavailable right now.`, 'SERVICE_DISABLED');
  }
}

function assertCanTransact(user, settings) {
  if (settings.requireApproval && !user.isApproved) {
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
  if (service === 'transfer') match.type = 'transfer_out';
  else match.service = service;
  const [row] = await Transaction.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return row ? row.total : 0;
}

async function assertWithinLimits(user, service, amount, settings) {
  const min = settings.minimums && settings.minimums[service];
  if (min && amount < min) {
    throw badRequest(`The minimum for ${SERVICE_LABELS[service]} is ${fmt(min)}.`, 'BELOW_MINIMUM');
  }
  const { perTxn, daily } = effectiveLimits(user, service, settings);
  if (perTxn != null && amount > perTxn) {
    throw badRequest(`The maximum per transaction is ${fmt(perTxn)}.`, 'LIMIT_PER_TRANSACTION');
  }
  if (daily != null) {
    const used = await usedToday(user._id, service);
    if (used + amount > daily) {
      const left = Math.max(0, daily - used);
      throw badRequest(
        `This goes over your daily limit of ${fmt(daily)}. You can still spend ${fmt(left)} today.`,
        'LIMIT_DAILY',
      );
    }
  }
}

module.exports = { assertServiceOpen, assertCanTransact, effectiveLimits, usedToday, assertWithinLimits, fmt };
