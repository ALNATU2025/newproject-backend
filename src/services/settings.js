// App-wide settings stored in one Mongo document, merged over defaults and
// cached for a few seconds. Money values are kobo.
const { Setting } = require('../models');
const { SERVICES, BILL_SERVICES } = require('../models/constants');

const NAIRA = 100;
const LEONE = 100; // cents

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
    // Sierra Leone: set your margins in Admin → Service Commission.
    sl_airtime: { user: 0, platform: 0 },
    sl_data: { user: 0, platform: 0 },
    sl_electricity: { user: 0, platform: 0 },
    sl_cable: { user: 0, platform: 0 },
    sl_international: { user: 0, platform: 0 },
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
    // Sierra Leone, in Leones (cents)
    sl_airtime: { perTxn: 2_000 * LEONE, daily: 10_000 * LEONE },
    sl_data: { perTxn: 2_000 * LEONE, daily: 10_000 * LEONE },
    sl_electricity: { perTxn: 20_000 * LEONE, daily: 50_000 * LEONE },
    sl_cable: { perTxn: 10_000 * LEONE, daily: 30_000 * LEONE },
    sl_international: { perTxn: 2_000 * LEONE, daily: 10_000 * LEONE },
    sl_transfer: { perTxn: 20_000 * LEONE, daily: 100_000 * LEONE },
    // Cashwyre transfers and dollar cards (Sierra Leone, Leones)
    sl_payout: { perTxn: 20_000 * LEONE, daily: 100_000 * LEONE },
    sl_card: { perTxn: 20_000 * LEONE, daily: 100_000 * LEONE },
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
    sl_airtime: 1 * LEONE,
    sl_data: 1 * LEONE,
    sl_electricity: 20 * LEONE,
    sl_cable: 10 * LEONE,
    sl_international: 1 * LEONE,
    sl_transfer: 5 * LEONE,
    sl_payout: 10 * LEONE,
    sl_card: 0,
  },

  // Cashwyre pricing. Your margin is added on top of Cashwyre's own fee
  // and rate. Edit in Admin → Settings.
  cashwyre: {
    payoutFeePercent: 1, // % of what Cashwyre charges you for a transfer
    fxMarginPercent: 2, // extra % when converting between currencies
    cardFeePercent: 1, // % on card creation / top-up
    cardWithdrawMarginPercent: 2, // % kept when moving card money back to the wallet
    minCardUsd: 5,
    maxCardUsd: 2_000,
    maxCardsPerUser: 2,
  },

  minCommissionWithdrawal: 500 * NAIRA,
  slMinCommissionWithdrawal: 10 * LEONE,
  fundingFeePercent: 1.5,
  minFunding: 100 * NAIRA,
  maxFunding: 1_000_000 * NAIRA,
  transferFee: 0,

  referral: {
    bonus: 200 * NAIRA, // to referrer and the new user
    indirectBonus: 20 * NAIRA, // to the referrer's referrer
    minFirstDeposit: 5_000 * NAIRA,
  },

  // Sierra Leone referral bonuses (Leones, cents). Off until you set them.
  slReferral: {
    bonus: 0,
    indirectBonus: 0,
    minFirstDeposit: 100 * LEONE,
  },

  // How Sierra Leone users add money: they pay one of these accounts, then
  // tap "I've paid" and an admin credits the wallet. Edit in Admin → Settings.
  slFunding: {
    minAmount: 10 * LEONE,
    maxAmount: 100_000 * LEONE,
    methods: [
      { id: 'orange', name: 'Orange Money', account: '', accountName: '' },
      { id: 'afrimoney', name: 'Afrimoney', account: '', accountName: '' },
      { id: 'bank', name: 'Bank transfer', account: '', accountName: '', bankName: '' },
    ],
    instructions: 'Send the money, then tap "I\'ve paid" with the transaction ID. We credit your wallet as soon as we confirm it.',
  },

  // Sierra Leone account levels (Leones, cents; null = no limit). Tier 4
  // (business licence) has no limits. Editable in Admin → Settings.
  slTiers: {
    1: { daily: 100 * LEONE, maxBalance: 500 * LEONE },
    2: { daily: 1_000 * LEONE, maxBalance: 5_000 * LEONE },
    3: { daily: 5_000 * LEONE, maxBalance: 10_000 * LEONE },
    4: { daily: null, maxBalance: null },
  },

  // What admins hear about by push and webhook (alerts always go out).
  adminNotify: {
    transactions: true, // every credit and debit
  },

  // Sierra Leone international airtime: VTpass charges your Naira wallet,
  // the customer pays Leones. Rate = Le per ₦1 (null = from Cashwyre's
  // dollar rates), plus your margin. Edit in Admin → Sierra Leone.
  slInternational: {
    rateLePerNaira: null,
    marginPercent: 3,
  },

  // DStv ExtraView (Nigeria): our packages replace VTpass's (see
  // routes/services.js). Fee in kobo, added to the bouquet's price.
  dstvExtraView: {
    enabled: true,
    fee: 6_000 * NAIRA,
  },

  // Nigeria "Add money": the person pays this account, taps "I have sent
  // it", and an admin confirms (from the push or the webhook links) to
  // credit the wallet. Edit in Admin → Settings (ngBankFunding).
  ngBankFunding: {
    enabled: true,
    accountNumber: '3002991121',
    accountName: 'Dalabapay Digital Service',
    bankName: 'Kuda Bank',
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
