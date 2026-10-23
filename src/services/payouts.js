// Transfers to bank accounts and mobile money wallets in other countries
// (and at home), sent through Cashwyre.
//
//   quote → the customer sees what it costs in their own currency
//   send  → PIN, wallet debit, Cashwyre payout (pending)
//   settle→ webhook or status check: success, or failed with a refund
//
// Webhooks aren't signed, so a webhook is never trusted on its own: the
// payout's status is always confirmed with Cashwyre first.
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { Transaction } = require('../models');
const { COUNTRIES } = require('../models/constants');
const cashwyre = require('../providers/cashwyre');
const { AppError, badRequest, conflict, unavailable } = require('../utils/errors');
const { makeReference } = require('../utils/helpers');
const { currencyOf, formatMoney } = require('../utils/money');
const wallet = require('./wallet');
const { verifyPin } = require('./pin');
const { notify } = require('./notify');
const { raiseAlert } = require('./alerts');
const { getSettings } = require('./settings');
const { assertServiceOpen, assertCanTransact, assertWithinLimits } = require('./limits');
const { refundTransaction } = require('./ledger');
const { usdRate } = require('./fx');

const ACCOUNT_TYPES = { bank: 'bank', mobile_money: 'wallet' };
const QUOTE_TTL = '10m';
const DUPLICATE_WINDOW_MS = 60 * 1000;

const serviceFor = (user) => (user.country === 'SL' ? 'sl_payout' : 'payout');

// Countries Cashwyre pays out to (from their documentation), used when
// their country list can't be read.
const KNOWN = {
  NG: ['Nigeria', 'NGN'], SL: ['Sierra Leone', 'SLE'], GH: ['Ghana', 'GHS'], KE: ['Kenya', 'KES'],
  UG: ['Uganda', 'UGX'], RW: ['Rwanda', 'RWF'], TZ: ['Tanzania', 'TZS'], ZA: ['South Africa', 'ZAR'],
  ZM: ['Zambia', 'ZMW'], ZW: ['Zimbabwe', 'USD'], BW: ['Botswana', 'BWP'], MW: ['Malawi', 'MWK'],
  MA: ['Morocco', 'MAD'], SN: ['Senegal', 'XOF'], CI: ["Côte d'Ivoire", 'XOF'], BJ: ['Benin', 'XOF'],
  ML: ['Mali', 'XOF'], BF: ['Burkina Faso', 'XOF'], GN: ['Guinea', 'GNF'], CM: ['Cameroon', 'XAF'],
  GA: ['Gabon', 'XAF'], CD: ['DR Congo', 'CDF'],
};

// ── Caches (bank lists change rarely) ──────────────────────

const COUNTRY_TTL = 6 * 60 * 60 * 1000;
const BANK_TTL = 60 * 60 * 1000;
let countryCache = null;
let countryCachedAt = 0;
const bankCache = new Map();

async function bankList(country, type) {
  const key = `${country}:${type}`;
  const hit = bankCache.get(key);
  if (hit && Date.now() - hit.at < BANK_TTL) return hit.list;
  const list = await cashwyre.banks(country, ACCOUNT_TYPES[type]);
  bankCache.set(key, { at: Date.now(), list });
  return list;
}

async function safeCount(country, type) {
  try {
    return (await bankList(country, type)).length;
  } catch {
    return null; // unknown
  }
}

/**
 * Countries money can be sent to, each with whether bank accounts and/or
 * mobile money wallets are supported (checked with Cashwyre's bank list).
 */
async function payoutCountries({ fresh = false } = {}) {
  if (!fresh && countryCache && Date.now() - countryCachedAt < COUNTRY_TTL) return countryCache;
  let list;
  try {
    list = (await cashwyre.countries())
      .filter((c) => c.canPayout && c.code)
      .map((c) => ({ code: c.code, name: c.name || (KNOWN[c.code] || [c.code])[0], currency: c.currencies[0] || (KNOWN[c.code] || [])[1] }));
  } catch (e) {
    if (e instanceof AppError && e.code === 'PROVIDER_NOT_CONFIGURED') throw e;
    list = [];
  }
  if (!list.length) list = Object.entries(KNOWN).map(([code, [name, currency]]) => ({ code, name, currency }));
  list = list.filter((c) => c.currency);

  const out = [];
  for (let i = 0; i < list.length; i += 6) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await Promise.all(
      list.slice(i, i + 6).map(async (c) => {
        const [banks, wallets] = await Promise.all([safeCount(c.code, 'bank'), safeCount(c.code, 'mobile_money')]);
        return {
          ...c,
          flag: (COUNTRIES[c.code] && COUNTRIES[c.code].flag) || null,
          bank: banks === null ? null : banks > 0,
          mobileMoney: wallets === null ? null : wallets > 0,
        };
      }),
    );
    out.push(...rows);
  }
  const usable = out.filter((c) => c.bank !== false || c.mobileMoney !== false);
  usable.sort((a, b) => a.name.localeCompare(b.name));
  countryCache = usable;
  countryCachedAt = Date.now();
  return usable;
}

function clearPayoutCache() {
  countryCache = null;
  bankCache.clear();
}

async function findCountry(code) {
  const c = (await payoutCountries()).find((x) => x.code === code);
  if (!c) throw badRequest('Money can\'t be sent to this country.', 'COUNTRY_NOT_SUPPORTED');
  return c;
}

async function findBank(country, type, bankCode) {
  const bank = (await bankList(country, type)).find((b) => b.code === bankCode);
  if (!bank) {
    throw badRequest(type === 'bank' ? 'Choose a valid bank.' : 'Choose a valid mobile money provider.', 'INVALID_BANK');
  }
  return bank;
}

// ── Pricing ────────────────────────────────────────────────

const roundUp = (major) => Math.ceil(Number(major) * 100 - 1e-6);

async function checks(user, charge) {
  const settings = await getSettings();
  const service = serviceFor(user);
  assertServiceOpen(service, settings);
  assertCanTransact(user, settings);
  if (!cashwyre.configured()) {
    throw unavailable('Transfers are not connected yet. Please try again later.', 'PROVIDER_NOT_CONFIGURED');
  }
  if (charge !== undefined) await assertWithinLimits(user, service, charge, settings);
  return settings;
}

/**
 * Works out what a transfer costs the sender. [amount] is what the
 * recipient gets, in the recipient country's currency (major units).
 */
async function quote(user, { country, accountType, bankCode, accountNumber, accountName, amount, narration }) {
  const settings = await checks(user);
  const dest = await findCountry(country);
  if (accountType === 'bank' && dest.bank === false) throw badRequest(`Bank transfers to ${dest.name} aren't available.`, 'METHOD_NOT_SUPPORTED');
  if (accountType === 'mobile_money' && dest.mobileMoney === false) {
    throw badRequest(`Mobile money transfers to ${dest.name} aren't available.`, 'METHOD_NOT_SUPPORTED');
  }
  const bank = await findBank(country, accountType, bankCode);
  const fee = await cashwyre.payoutFee({ currency: dest.currency, amount, accountNumber });

  const userCur = currencyOf(user.country);
  const pricing = settings.cashwyre || {};
  let base; // in the sender's currency (major units)
  let rate = null; // sender's currency per 1 unit of the recipient's
  if (userCur === dest.currency) {
    base = fee.totalDebitLocal > 0 ? fee.totalDebitLocal : amount + fee.feeLocal;
  } else {
    if (!(fee.totalDebitUsd > 0)) throw unavailable('We couldn\'t price this transfer right now. Please try again.', 'FX_UNAVAILABLE');
    const perUsd = await usdRate(userCur, 'sell');
    base = fee.totalDebitUsd * perUsd * (1 + (pricing.fxMarginPercent || 0) / 100);
    rate = base / amount;
  }
  const charge = roundUp(base * (1 + (pricing.payoutFeePercent || 0) / 100));
  await assertWithinLimits(user, serviceFor(user), charge, settings);

  const fees = Math.max(0, charge - (userCur === dest.currency ? roundUp(amount) : 0));
  const q = {
    country: dest.code,
    countryName: dest.name,
    currency: dest.currency,
    accountType,
    bankCode: bank.code,
    bankName: bank.name,
    accountNumber,
    accountName,
    narration: narration || null,
    amount,
    charge,
    chargeCurrency: userCur,
    rate,
  };
  const token = jwt.sign({ sub: String(user._id), q }, env.jwtSecret, { expiresIn: QUOTE_TTL, audience: 'payout-quote' });
  return {
    quoteToken: token,
    ...q,
    charge: charge / 100,
    fee: userCur === dest.currency ? fees / 100 : null,
    expiresInSeconds: 600,
    summary: `${dest.currency} ${amount.toFixed(2)} to ${accountName} (${bank.name}) costs ${formatMoney(charge, userCur)}`,
  };
}

function readQuote(user, token) {
  try {
    const p = jwt.verify(token, env.jwtSecret, { audience: 'payout-quote' });
    if (p.sub !== String(user._id)) throw new Error('not yours');
    return p.q;
  } catch (e) {
    if (e.name === 'TokenExpiredError') throw badRequest('This quote has expired. Please review the transfer again.', 'QUOTE_EXPIRED');
    throw badRequest('This quote is not valid. Please review the transfer again.', 'QUOTE_INVALID');
  }
}

// ── Sending ────────────────────────────────────────────────

async function send(user, { quoteToken, pin }) {
  const q = readQuote(user, quoteToken);
  await checks(user, q.charge);
  await verifyPin(user._id, pin);

  const service = serviceFor(user);
  const recent = await Transaction.exists({
    user: user._id,
    type: 'payout',
    recipient: q.accountNumber,
    'metadata.sendAmount': q.amount,
    status: { $in: ['pending', 'success'] },
    createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
  });
  if (recent) {
    throw conflict('It looks like you just sent this exact transfer. Please wait a minute before repeating it.', 'DUPLICATE_TRANSACTION');
  }

  const reference = makeReference('PO');
  const method = q.accountType === 'bank' ? 'bank' : 'mobile money';
  const description = `Transfer to ${q.accountName} · ${q.bankName}`;
  const { before, after } = await wallet.debit(user._id, q.charge);
  let txn;
  try {
    txn = await Transaction.create({
      user: user._id,
      reference,
      type: 'payout',
      direction: 'debit',
      amount: q.charge,
      status: 'pending',
      service,
      recipient: q.accountNumber,
      description,
      provider: 'cashwyre',
      balanceBefore: before,
      balanceAfter: after,
      metadata: {
        country: q.country,
        countryName: q.countryName,
        sendCurrency: q.currency,
        sendAmount: q.amount,
        method,
        accountType: q.accountType,
        bankCode: q.bankCode,
        bankName: q.bankName,
        accountName: q.accountName,
        accountNumber: q.accountNumber,
        rate: q.rate,
        narration: q.narration,
      },
    });
  } catch (e) {
    await wallet.credit(user._id, q.charge);
    throw e;
  }

  const cur = txn.currency;
  try {
    const r = await cashwyre.initiatePayout({
      reference,
      bankCode: q.bankCode,
      accountName: q.accountName,
      accountNumber: q.accountNumber,
      currency: q.currency,
      country: q.country,
      amount: q.amount,
      narration: (q.narration || `Dalabapay transfer ${reference}`).slice(0, 100),
      debitWalletCurrency: q.currency === cur ? '' : env.cashwyre.crossBorderWallet,
    });
    txn.providerReference = r.transactionReference;
    await txn.save();
  } catch (e) {
    if (e instanceof AppError) {
      txn.metadata = { ...txn.metadata, failureReason: e.message };
      await txn.save();
      await refundTransaction(txn, { reason: e.message, status: 'failed' });
      throw badRequest(`The transfer was declined: ${e.message}. Your wallet has been refunded.`, 'TRANSFER_DECLINED');
    }
    await raiseAlert({
      type: 'provider',
      severity: 'warning',
      title: 'Cashwyre did not respond',
      body: `${reference} (${description}, ${formatMoney(q.charge, cur)}) is pending: ${e.message}`,
      user: user._id,
      transaction: txn._id,
    });
  }
  await notify(user._id, {
    title: 'Transfer on its way',
    body: `${q.currency} ${q.amount.toFixed(2)} to ${q.accountName} (${q.bankName}) is being processed.`,
    kind: 'payment',
    data: { transactionId: String(txn._id) },
  });
  return Transaction.findById(txn._id);
}

// ── Settling ───────────────────────────────────────────────

/** Moves a pending payout to success, or failed with a refund. */
async function settle(txn, state, message, { actor = null } = {}) {
  if (state === 'success') {
    const claimed = await Transaction.findOneAndUpdate(
      { _id: txn._id, status: 'pending' },
      { $set: { status: 'success', 'metadata.providerMessage': message || null } },
      { new: true },
    );
    if (claimed) {
      await notify(claimed.user, {
        title: 'Transfer successful',
        body: `${claimed.metadata.sendCurrency} ${Number(claimed.metadata.sendAmount).toFixed(2)} reached ${claimed.metadata.accountName}.`,
        kind: 'payment',
        data: { transactionId: String(claimed._id) },
      });
    }
  } else if (state === 'failed') {
    const fresh = await Transaction.findById(txn._id);
    if (fresh && fresh.status === 'pending' && !fresh.refunded) {
      fresh.metadata = { ...(fresh.metadata || {}), failureReason: message || 'Failed at provider' };
      await fresh.save();
      await refundTransaction(fresh, { reason: message || 'Transfer failed', actor, status: 'failed' });
      await notify(fresh.user, {
        title: 'Transfer failed',
        body: `Your transfer to ${fresh.metadata.accountName} failed. ${formatMoney(fresh.amount, fresh.currency)} has been returned to your wallet.`,
        kind: 'payment',
        data: { transactionId: String(fresh._id) },
      });
    }
  }
}

/** Asks Cashwyre about a pending payout and settles it. */
async function checkPayout(txn, { actor = null } = {}) {
  if (txn.status !== 'pending' || txn.type !== 'payout') return { result: txn.status, message: 'Not a pending transfer.' };
  const r = await cashwyre.payoutStatus({ reference: txn.reference, transactionReference: txn.providerReference });
  await settle(txn, r.status, r.message, { actor });
  return { result: r.status, message: r.message };
}

/** Webhook payout.success / payout.failed: confirmed with Cashwyre first. */
async function onPayoutEvent(eventData) {
  const ref = cashwyre.pick(eventData, 'reference');
  const txRef = cashwyre.pick(eventData, 'transactionReference');
  const txn = await Transaction.findOne({
    type: 'payout',
    $or: [{ reference: ref || '__none__' }, ...(txRef ? [{ providerReference: txRef }] : [])],
  });
  if (!txn) return { matched: false };
  if (!txn.providerReference && txRef) {
    txn.providerReference = txRef;
    await txn.save();
  }
  const r = await checkPayout(txn);
  return { matched: true, result: r.result };
}

module.exports = {
  ACCOUNT_TYPES,
  payoutCountries,
  clearPayoutCache,
  bankList,
  findCountry,
  quote,
  send,
  settle,
  checkPayout,
  onPayoutEvent,
  serviceFor,
};
