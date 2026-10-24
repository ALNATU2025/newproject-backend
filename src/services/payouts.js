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
const VELOCITY_WINDOW_MS = 10 * 60 * 1000;
const VELOCITY_MAX = 5; // transfers per 10 minutes

// Sierra Leone accounts only (the routes refuse other countries).
const serviceFor = () => 'sl_payout';

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
const EMPTY_TTL = 10 * 60 * 1000; // empty lists are asked again sooner
let countryCache = null;
let countryCachedAt = 0;
const bankCache = new Map();

// Ways to ask Cashwyre for the list, tried in order until one has entries
// (their API returns an empty list for some countries with the filter).
const LIST_VARIANTS = {
  bank: [['bank', 'payout'], ['bank', ''], ['Bank', '']],
  mobile_money: [['wallet', 'payout'], ['wallet', ''], ['mobile_money', ''], ['momo', '']],
};

async function bankList(country, type, { fresh = false } = {}) {
  const key = `${country}:${type}`;
  const hit = bankCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < (hit.list.length ? BANK_TTL : EMPTY_TTL)) return hit.list;
  let list = [];
  let lastError = null;
  for (const [accountType, transactionType] of LIST_VARIANTS[type] || []) {
    try {
      // eslint-disable-next-line no-await-in-loop
      list = await cashwyre.banks(country, accountType, { transactionType });
      lastError = null;
    } catch (e) {
      lastError = e;
      list = [];
    }
    if (list.length) break;
  }
  if (lastError && !list.length) throw lastError;
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
async function baseCountries({ fresh = false } = {}) {
  if (!fresh && countryCache && Date.now() - countryCachedAt < COUNTRY_TTL) return countryCache;
  // Every payout country from Cashwyre's documentation, plus any their
  // country list adds. (That list is about crypto on/off-ramp, so it isn't
  // used to remove countries; the bank / mobile money lists decide.)
  const byCode = new Map(Object.entries(KNOWN).map(([code, [name, currency]]) => [code, { code, name, currency }]));
  try {
    for (const c of await cashwyre.countries()) {
      if (!c.code || c.code === 'US') continue;
      const known = byCode.get(c.code);
      if (known) known.name = c.name || known.name;
      else if (c.canPayout && c.currencies[0]) byCode.set(c.code, { code: c.code, name: c.name || c.code, currency: c.currencies[0] });
    }
  } catch (e) {
    if (e instanceof AppError && e.code === 'PROVIDER_NOT_CONFIGURED') throw e;
  }
  const list = [...byCode.values()].filter((c) => c.currency);

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

/**
 * Countries money can be sent to, with what they support and whether the
 * wallet that pays transfers there has money (available: null = unknown).
 */
async function payoutCountries(opts) {
  const list = await baseCountries(opts);
  const currencies = [...new Set(list.map((c) => c.currency))];
  const balances = Object.fromEntries(
    await Promise.all(currencies.map(async (cur) => [cur, await businessBalance(debitWalletFor(cur, 'SLE') || cur)])),
  );
  return list.map((c) => {
    const b = balances[c.currency];
    return { ...c, wallet: debitWalletFor(c.currency, 'SLE') || c.currency, available: b === null || b === undefined ? null : b > 0 };
  });
}

/** For admins: what Cashwyre reports for every country (fresh). */
async function coverage() {
  const list = await baseCountries({ fresh: true });
  const all = new Map(Object.entries(KNOWN).map(([code, [name, currency]]) => [code, { code, name, currency }]));
  for (const c of list) all.set(c.code, { ...all.get(c.code), ...c });
  const rows = [];
  for (const c of all.values()) {
    const row = { code: c.code, name: c.name, currency: c.currency, shown: list.some((x) => x.code === c.code) };
    for (const type of ['bank', 'mobile_money']) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const l = await bankList(c.code, type);
        row[type] = { count: l.length, examples: l.slice(0, 4).map((b) => b.name) };
      } catch (e) {
        row[type] = { count: null, error: e.message };
      }
    }
    // eslint-disable-next-line no-await-in-loop
    row.walletBalance = await businessBalance(debitWalletFor(c.currency, 'SLE') || c.currency);
    row.wallet = debitWalletFor(c.currency, 'SLE') || c.currency;
    rows.push(row);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function clearPayoutCache() {
  countryCache = null;
  bankCache.clear();
  balanceCache.clear();
  lowAlertAt.clear();
}

async function findCountry(code) {
  const c = (await baseCountries()).find((x) => x.code === code);
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

// ── Which business wallet pays, and is there enough in it ──

/**
 * Wallet Cashwyre should debit ('' = the wallet in the transfer's own
 * currency). Each country's transfers come from that country's wallet
 * unless CASHWYRE_CROSS_BORDER_WALLET names one wallet for all.
 */
function debitWalletFor(destCurrency, senderCurrency) {
  if (destCurrency === senderCurrency) return '';
  return env.cashwyre.crossBorderWallet || '';
}

const BALANCE_TTL = 30 * 1000;
const balanceCache = new Map();
const lowAlertAt = new Map();

/** Balance of a business wallet, or null when Cashwyre can't say. */
async function businessBalance(currency, { fresh = false } = {}) {
  const hit = balanceCache.get(currency);
  if (!fresh && hit && Date.now() - hit.at < BALANCE_TTL) return hit.value;
  let value = null;
  try {
    value = await cashwyre.walletBalance(currency);
  } catch {
    value = null; // unknown: let Cashwyre decide
  }
  balanceCache.set(currency, { at: Date.now(), value });
  return value;
}

/**
 * Refuses (before any money moves) when the wallet that pays this transfer
 * is known to be too low, and tells the admins to fund it.
 */
async function assertBusinessFunds(dest, walletCurrency, needed) {
  if (!(needed > 0)) return;
  const balance = await businessBalance(walletCurrency, { fresh: true });
  if (balance === null || balance >= needed) return;
  const last = lowAlertAt.get(walletCurrency) || 0;
  if (Date.now() - last > 30 * 60 * 1000) {
    lowAlertAt.set(walletCurrency, Date.now());
    await raiseAlert({
      type: 'provider',
      severity: 'critical',
      title: `Fund your Cashwyre ${walletCurrency} wallet`,
      body: `A transfer to ${dest.name} needed ${walletCurrency} ${needed.toFixed(2)} but the wallet has ${walletCurrency} ${balance.toFixed(2)}. Transfers to ${dest.name} are paused until it's funded.`,
    });
  }
  throw unavailable(`Transfers to ${dest.name} aren't available right now. Please try again later.`, 'PAYOUT_WALLET_LOW');
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
/**
 * What a transfer of [amount] (recipient's currency) costs the sender, and
 * where the money goes: Cashwyre's fee and rate, Dalabapay's fee.
 */
async function price(user, dest, { amount, accountNumber = '' }, settings) {
  const fee = await cashwyre.payoutFee({ currency: dest.currency, amount, accountNumber });
  const userCur = currencyOf(user.country);
  const debitWallet = debitWalletFor(dest.currency, userCur);
  const walletCurrency = debitWallet || dest.currency;
  const totalLocal = fee.totalDebitLocal > 0 ? fee.totalDebitLocal : amount + fee.feeLocal;
  // What leaves your Cashwyre wallet: the amount plus Cashwyre's fee.
  const needed = walletCurrency === dest.currency ? totalLocal : walletCurrency === 'USD' ? fee.totalDebitUsd : 0;

  const pricing = settings.cashwyre || {};
  let cost; // Cashwyre's total, in the sender's currency
  let perUsd = null;
  let cashwyreFeeSender; // Cashwyre's fee, in the sender's currency
  if (userCur === dest.currency) {
    cost = totalLocal;
    cashwyreFeeSender = fee.feeLocal;
  } else {
    if (!(fee.totalDebitUsd > 0)) throw unavailable('We couldn\'t price this transfer right now. Please try again.', 'FX_UNAVAILABLE');
    perUsd = await usdRate(userCur, 'sell');
    cost = fee.totalDebitUsd * perUsd;
    cashwyreFeeSender = fee.feeUsd > 0 ? fee.feeUsd * perUsd : totalLocal > 0 ? (fee.feeLocal / totalLocal) * cost : 0;
  }
  const withFx = userCur === dest.currency ? cost : cost * (1 + (pricing.fxMarginPercent || 0) / 100);
  const charge = roundUp(withFx * (1 + (pricing.payoutFeePercent || 0) / 100));
  const cashwyreFee = roundUp(cashwyreFeeSender);
  const sent = roundUp(Math.max(0, cost - cashwyreFeeSender)); // the recipient's amount, in the sender's currency
  const ourFee = Math.max(0, charge - sent - cashwyreFee);
  const breakdown = {
    sendAmount: amount,
    sendCurrency: dest.currency,
    chargeCurrency: userCur,
    amountInYourCurrency: sent / 100,
    cashwyre: {
      fee: fee.feeLocal,
      feeCurrency: dest.currency,
      feeInYourCurrency: cashwyreFee / 100,
      feeUsd: fee.feeUsd || null,
      totalDebit: walletCurrency === 'USD' ? fee.totalDebitUsd : totalLocal,
      wallet: walletCurrency,
      rate: fee.fxRate || null, // units of the recipient's currency per $1
      rateInfo: fee.fxRateInfo,
    },
    dalabapayFee: ourFee / 100,
    rate: userCur === dest.currency ? null : withFx / amount, // sender's currency per 1 unit of the recipient's
    usdRate: perUsd, // sender's currency per $1
    total: charge / 100,
  };
  return { fee, charge, debitWallet, walletCurrency, needed, breakdown, userCur };
}

/** Fee preview while the customer types (no account details needed). */
async function preview(user, { country, amount, accountType }) {
  const settings = await checks(user);
  const dest = await findCountry(country);
  if (accountType === 'bank' && dest.bank === false) throw badRequest(`Bank transfers to ${dest.name} aren't available.`, 'METHOD_NOT_SUPPORTED');
  if (accountType === 'mobile_money' && dest.mobileMoney === false) {
    throw badRequest(`Mobile money transfers to ${dest.name} aren't available.`, 'METHOD_NOT_SUPPORTED');
  }
  const p = await price(user, dest, { amount }, settings);
  return p.breakdown;
}

/** The account holder's name from the bank / mobile money provider. */
async function lookupName({ country, bankCode, accountNumber }) {
  try {
    const name = await cashwyre.accountLookup({ country, bankCode, accountNumber });
    return name ? { accountName: String(name).trim(), verified: true } : { accountName: null, verified: false };
  } catch (e) {
    return { accountName: null, verified: false, message: e instanceof AppError && e.code === 'PROVIDER_DECLINED' ? e.message : null };
  }
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

  // Banks that check names: always use the name the bank returns.
  let name = accountName;
  let nameVerified = false;
  const looked = await lookupName({ country, bankCode: bank.code, accountNumber });
  if (looked.verified) {
    name = looked.accountName;
    nameVerified = true;
  } else if (bank.nameEnquiryRequired) {
    throw badRequest('We couldn\'t confirm this account number with the bank. Check it and try again.', 'ACCOUNT_NOT_VERIFIED');
  }
  if (!name || name.length < 2) throw badRequest('Enter the account holder\'s name.', 'ACCOUNT_NAME_REQUIRED');

  const p = await price(user, dest, { amount, accountNumber }, settings);
  await assertBusinessFunds(dest, p.walletCurrency, p.needed);
  const { charge, debitWallet, walletCurrency, needed, userCur } = p;
  await assertWithinLimits(user, serviceFor(user), charge, settings);

  const q = {
    country: dest.code,
    countryName: dest.name,
    currency: dest.currency,
    accountType,
    bankCode: bank.code,
    bankName: bank.name,
    accountNumber,
    accountName: name,
    nameVerified,
    narration: narration || null,
    amount,
    charge,
    debitWallet,
    walletCurrency,
    needed,
    chargeCurrency: userCur,
    rate: p.breakdown.rate,
  };
  const token = jwt.sign({ sub: String(user._id), q }, env.jwtSecret, { expiresIn: QUOTE_TTL, audience: 'payout-quote' });
  return {
    quoteToken: token,
    ...q,
    charge: charge / 100,
    fee: userCur === dest.currency ? Math.max(0, charge / 100 - amount) : null,
    breakdown: p.breakdown,
    expiresInSeconds: 600,
    summary: `${dest.currency} ${amount.toFixed(2)} to ${name} (${bank.name}) costs ${formatMoney(charge, userCur)}`,
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
  await assertBusinessFunds({ name: q.countryName }, q.walletCurrency || q.currency, q.needed);
  await verifyPin(user._id, pin);

  const service = serviceFor(user);
  // Many transfers in a few minutes looks like a stolen phone or account.
  const burst = await Transaction.countDocuments({
    user: user._id,
    type: 'payout',
    createdAt: { $gte: new Date(Date.now() - VELOCITY_WINDOW_MS) },
  });
  if (burst >= VELOCITY_MAX) {
    await raiseAlert({
      type: 'suspicious',
      severity: 'critical',
      title: 'Many transfers in a short time',
      body: `${user.fullName} tried a ${burst + 1}th transfer within 10 minutes. Further transfers are paused for a few minutes.`,
      user: user._id,
    });
    throw new AppError(429, 'You\'ve made several transfers in a short time. For your safety, please wait a few minutes.', 'TOO_MANY_TRANSFERS');
  }
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
      // Our reference always goes first so a webhook can be matched by it.
      narration: `${reference} ${q.narration || 'Dalabapay transfer'}`.slice(0, 100),
      debitWalletCurrency: q.debitWallet !== undefined ? q.debitWallet : debitWalletFor(q.currency, cur),
    });
    txn.providerReference = r.transactionReference;
    await txn.save();
    // Some payouts finish straight away: check once now.
    try {
      await checkPayout(await Transaction.findById(txn._id));
    } catch {
      // the webhook or the sweeper will settle it
    }
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

const digits = (v) => String(v || '').replace(/\D/g, '');

/** Finds our payout for a webhook: by reference, by Cashwyre's, or by narration. */
async function findPayoutFor(eventData) {
  const pick = (...k) => cashwyre.pick(eventData, ...k);
  const refs = [pick('reference'), pick('transactionReference'), pick('requestId'), pick('code')].filter(Boolean).map(String);
  const narration = String(pick('narration', 'transactionDescription') || '');
  const fromNarration = (narration.match(/PO\d{12}[0-9A-F]{8}/) || [])[0];
  if (fromNarration) refs.push(fromNarration);
  if (!refs.length) return null;
  return Transaction.findOne({ type: 'payout', $or: [{ reference: { $in: refs } }, { providerReference: { $in: refs } }] });
}

/** True when the webhook describes this payout (same account and amount). */
function detailsMatch(txn, eventData) {
  const m = txn.metadata || {};
  const acct = digits(cashwyre.pick(eventData, 'destinationAccountNumber', 'accountNumber'));
  const amount = Number(cashwyre.pick(eventData, 'amount'));
  const sameAccount = acct && digits(m.accountNumber).endsWith(acct.slice(-6));
  const sameAmount = Number.isFinite(amount) && Math.abs(amount - Number(m.sendAmount)) < 0.01;
  return Boolean(sameAccount && sameAmount);
}

/**
 * Webhook payout.success / payout.failed. Confirmed with Cashwyre's status
 * check; if that can't answer, the webhook is accepted only when its
 * account number and amount match the payout (the URL is secret too).
 */
async function onPayoutEvent(eventData, eventType = '') {
  const txn = await findPayoutFor(eventData);
  if (!env.isTest) console.log(`[cashwyre webhook] ${eventType} ${JSON.stringify(eventData).slice(0, 600)} → ${txn ? txn.reference : 'no match'}`);
  if (!txn) return { matched: false };
  const txRef = cashwyre.pick(eventData, 'transactionReference');
  if (!txn.providerReference && txRef && String(txRef) !== txn.reference) {
    txn.providerReference = String(txRef);
    await txn.save();
  }
  if (txn.status !== 'pending') return { matched: true, result: txn.status };
  let r = null;
  try {
    r = await checkPayout(txn);
  } catch (e) {
    r = null;
  }
  if (r && r.result !== 'pending') return { matched: true, result: r.result };
  const said = cashwyre.payoutState(cashwyre.pick(eventData, 'status') || (String(eventType).endsWith('success') ? 'success' : String(eventType).endsWith('failed') ? 'failed' : ''));
  if (said !== 'pending' && detailsMatch(txn, eventData)) {
    await settle(txn, said, cashwyre.pick(eventData, 'transactionDescription') || null);
    return { matched: true, result: said, via: 'webhook' };
  }
  return { matched: true, result: 'pending' };
}

module.exports = {
  ACCOUNT_TYPES,
  payoutCountries,
  coverage,
  clearPayoutCache,
  bankList,
  findCountry,
  quote,
  preview,
  lookupName,
  send,
  settle,
  checkPayout,
  onPayoutEvent,
  serviceFor,
};
