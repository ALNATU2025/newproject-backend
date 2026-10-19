// App-wide settings stored in one Mongo document, merged over defaults and
// cached for a few seconds. Money values are kobo.
const { Setting } = require('../models');
const { SERVICES, BILL_SERVICES } = require('../models/constants');

const NAIRA = 100;

const DEFAULTS = {
  services: Object.fromEntries(SERVICES.map((s) => [s, true])),
  maintenance: false,
  maintenanceMessage: 'Some services are paused for maintenance. Please check back soon.',
  requireApproval: false,

  // % of the purchase amount: `user` is paid to the customer as commission,
  // `platform` is Dalabapay's margin (revenue).
  commissionRates: {
    airtime: { user: 2, platform: 1 },
    data: { user: 2.5, platform: 1.5 },
    electricity: { user: 0.5, platform: 0.5 },
    cable: { user: 1, platform: 0.5 },
    education: { user: 1.5, platform: 1 },
    insurance: { user: 2, platform: 2 },
    international: { user: 1, platform: 2 },
  },

  // Default limits per service (kobo; null = unlimited)
  limits: {
    airtime: { perTxn: 50_000 * NAIRA, daily: 200_000 * NAIRA },
    data: { perTxn: 50_000 * NAIRA, daily: 200_000 * NAIRA },
    electricity: { perTxn: 500_000 * NAIRA, daily: 1_000_000 * NAIRA },
    cable: { perTxn: 200_000 * NAIRA, daily: 500_000 * NAIRA },
    education: { perTxn: 100_000 * NAIRA, daily: 300_000 * NAIRA },
    insurance: { perTxn: 100_000 * NAIRA, daily: 300_000 * NAIRA },
    international: { perTxn: 50_000 * NAIRA, daily: 150_000 * NAIRA },
    transfer: { perTxn: 500_000 * NAIRA, daily: 2_000_000 * NAIRA },
  },

  // Minimum amounts per service (kobo)
  minimums: {
    airtime: 50 * NAIRA,
    data: 50 * NAIRA,
    electricity: 2_000 * NAIRA,
    cable: 50 * NAIRA, // TV plans have fixed prices; StarTimes daily is ₦90
    education: 500 * NAIRA,
    insurance: 500 * NAIRA,
    international: 100 * NAIRA,
    transfer: 100 * NAIRA,
  },

  minCommissionWithdrawal: 500 * NAIRA,
  fundingFeePercent: 1.5,
  minFunding: 100 * NAIRA,
  maxFunding: 1_000_000 * NAIRA,
  transferFee: 0,

  referral: {
    bonus: 200 * NAIRA, // to referrer and the new user
    indirectBonus: 20 * NAIRA, // to the referrer's referrer
    minFirstDeposit: 5_000 * NAIRA,
  },

  lowBalanceAlerts: true,
  lowBalanceThreshold: 50_000 * NAIRA,
};

let cache = null;
let cachedAt = 0;
const TTL_MS = 5000;

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  const doc = await Setting.findOne({ key: 'global' }).lean();
  cache = deepMerge(DEFAULTS, (doc && doc.value) || {});
  cachedAt = Date.now();
  return cache;
}

/** Deep-merges `patch` into the stored settings. */
async function updateSettings(patch) {
  const doc = await Setting.findOne({ key: 'global' });
  const current = (doc && doc.value) || {};
  const next = deepMerge(current, patch);
  await Setting.updateOne({ key: 'global' }, { $set: { value: next } }, { upsert: true });
  cache = null;
  return getSettings({ fresh: true });
}

function clearSettingsCache() {
  cache = null;
}

module.exports = { DEFAULTS, getSettings, updateSettings, clearSettingsCache, BILL_SERVICES };
