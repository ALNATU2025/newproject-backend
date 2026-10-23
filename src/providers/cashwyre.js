// Cashwyre business API (https://business.cashwyre.com/doc/api).
// Every call is a POST with `Authorization: Bearer <secret key>`, and the
// body carries appId (= business code), businessCode and a unique
// requestId. Amounts are in major units (e.g. 1500.00), not kobo.
//
// Errors:
//   Cashwyre said no (success:false or HTTP 4xx) → AppError 400
//     PROVIDER_DECLINED; nothing happened, safe to refund.
//   No answer (timeout, network, HTTP 5xx) → CashwyreUnknownError;
//     the request may or may not have gone through.
const crypto = require('crypto');
const env = require('../config/env');
const { AppError, unavailable } = require('../utils/errors');

let fetchImpl = (...a) => fetch(...a);

class CashwyreUnknownError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CashwyreUnknownError';
  }
}

const configured = () => Boolean(env.cashwyre.secretKey && env.cashwyre.businessCode);

const requestId = () => `DP${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

/** Reads a field whatever its casing (Cashwyre mixes camelCase and PascalCase). */
function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const keys = Object.keys(obj);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** Same object with every key lower-cased (one level). */
function lower(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
}

async function call(path, body = {}) {
  if (!configured()) {
    throw unavailable('International transfers and cards are not connected yet. Please try again later.', 'PROVIDER_NOT_CONFIGURED');
  }
  const code = env.cashwyre.businessCode;
  const payload = { appId: code, requestId: requestId(), businessCode: code, ...body };
  let res;
  try {
    res = await fetchImpl(`${env.cashwyre.baseUrl}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.cashwyre.secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(env.cashwyre.timeoutMs),
    });
  } catch (e) {
    throw new CashwyreUnknownError(`No answer from Cashwyre (${e.name === 'TimeoutError' ? 'timeout' : e.message})`);
  }
  const json = await res.json().catch(() => null);
  const success = json && pick(json, 'success');
  const message = (json && pick(json, 'message')) || `HTTP ${res.status}`;
  if (res.status >= 500 || (!json && res.ok)) {
    throw new CashwyreUnknownError(`Cashwyre ${path}: ${message}`);
  }
  if (!res.ok || success === false) {
    if (!env.isTest) console.warn(`[cashwyre] ${path} declined: HTTP ${res.status} ${message}`);
    if (res.status === 401 || res.status === 403) {
      throw unavailable('The transfer service is not set up correctly on the server.', 'PROVIDER_NOT_CONFIGURED');
    }
    throw new AppError(400, String(message), 'PROVIDER_DECLINED');
  }
  // Card transactions come back at the top level, everything else in data.
  const data = pick(json, 'data');
  return data !== undefined ? data : json;
}

// ── Countries, banks and mobile money wallets ──────────────

/** [{ code, name, canPayout, canDeposit, currencies: [code] }] */
async function countries() {
  const rows = (await call('country/getCountryInfo', {})) || [];
  return rows.map((c) => ({
    code: String(pick(c, 'code') || '').toUpperCase(),
    name: pick(c, 'name') || '',
    canPayout: Boolean(pick(c, 'canPayout')),
    canDeposit: Boolean(pick(c, 'canDeposit')),
    currencies: (pick(c, 'currencies') || []).map((x) => pick(x, 'currency')).filter(Boolean),
  }));
}

/** Banks (accountType "bank") or mobile money wallets ("wallet") for payouts. */
async function banks(country, accountType = 'bank') {
  const rows = (await call('CountryBank/getCountryBanks', { country, accountType, transactionType: 'payout' })) || [];
  return rows
    .map((b) => ({
      code: String(pick(b, 'code') || ''),
      name: String(pick(b, 'name') || ''),
      nameEnquiryRequired: Boolean(pick(b, 'nameEnquiryRequired')),
    }))
    .filter((b) => b.code && b.name);
}

/** Account holder's name (works for selected countries). */
async function accountLookup({ country, bankCode, accountNumber }) {
  const d = await call('Account/accountLookup', { country, bankCode, accountNumber });
  return pick(d, 'accountName') || null;
}

// ── Payouts ────────────────────────────────────────────────

/** Fee for sending [amount] (major units) in [currency]. */
async function payoutFee({ currency, amount, accountNumber = '' }) {
  const d = await call('Payout/getFee', { currency, amount, accountNumber });
  return {
    sendAmount: Number(pick(d, 'sendAmount') ?? amount),
    currency: pick(d, 'currency') || currency,
    feeLocal: Number(pick(d, 'feeInLocalCurrency') || 0),
    totalDebitLocal: Number(pick(d, 'totalDebitAmount') || 0),
    totalDebitUsd: Number(pick(d, 'totalDebitInUSD') || 0),
    fxRate: Number(pick(d, 'fxRate') || 0),
    info: pick(d, 'totalDebitAmountInfo') || null,
  };
}

async function initiatePayout(p) {
  const d = await call('Payout/initiate', {
    BusinessCode: env.cashwyre.businessCode,
    AppId: env.cashwyre.businessCode,
    RequestId: p.reference,
    BankCode: p.bankCode,
    AccountName: p.accountName,
    AccountNumber: p.accountNumber,
    Currency: p.currency,
    Country: p.country,
    Narration: p.narration,
    Reference: p.reference,
    Amount: p.amount,
    ...(p.debitWalletCurrency ? { DebitWalletCurrency: p.debitWalletCurrency } : {}),
  });
  return { transactionReference: pick(d, 'transactionReference') || null, reference: pick(d, 'reference') || p.reference };
}

/** 'success' | 'failed' | 'pending' (+ the provider's message). */
function payoutState(raw) {
  const s = String(raw || '').toLowerCase();
  if (['success', 'successful', 'completed', 'paid'].includes(s)) return 'success';
  if (['failed', 'failure', 'reversed', 'declined', 'rejected', 'cancelled', 'canceled'].includes(s)) return 'failed';
  return 'pending';
}

async function payoutStatus({ reference, transactionReference }) {
  const d = await call('Payout/getPayoutStatus', { reference, transactionReference: transactionReference || '' });
  return {
    status: payoutState(pick(d, 'status')),
    message: pick(d, 'message') || null,
    bankName: pick(d, 'bankName') || null,
  };
}

// ── Your business wallets ──────────────────────────────────

/** Available balance of your Cashwyre wallet in [currency] (major units). */
async function walletBalance(currency) {
  const d = await call('Wallet/getFundwalletAccountInfo', { currency });
  const v = Number(pick(d, 'availableBalance'));
  if (!Number.isFinite(v)) throw new AppError(400, `No ${currency} wallet`, 'PROVIDER_DECLINED');
  return v;
}

// ── Exchange rates ─────────────────────────────────────────

/** { NGN: { buy, sell }, ... } — $1 in each currency. */
async function fxRates() {
  const rows = (await call('businessRate/getFxRates', { currency: '' })) || [];
  const out = {};
  for (const r of rows) {
    const c = String(pick(r, 'currency') || '').toUpperCase();
    if (!c) continue;
    out[c] = { buy: Number(pick(r, 'buyRate') || 0), sell: Number(pick(r, 'sellRate') || 0) };
  }
  return out;
}

// ── Virtual dollar cards ───────────────────────────────────

async function createCard(p) {
  return call('CustomerCard/createCard', {
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    phoneCode: p.phoneCode,
    phoneNumber: p.phoneNumber,
    dateOfBirth: p.dateOfBirth,
    homeAddressNumber: p.homeAddressNumber,
    homeAddress: p.homeAddress,
    cardName: p.cardName,
    cardType: 'virtual',
    cardBrand: p.cardBrand,
    amountInUSD: p.amountUsd,
    idType: p.idType,
    idTypeNumber: p.idNumber,
    ...(p.idImageBase64 ? { idTypeBase64: p.idImageBase64 } : {}),
  });
}

/** Card details as stored/shown. Includes the full number and CVV. */
function cardFrom(c) {
  const l = lower(c) || {};
  return {
    code: l.code || l.cardcode || null,
    customerEmail: (l.customeremail || '').toLowerCase(),
    brand: l.cardbrand || null,
    last4: l.last4 || null,
    name: l.cardname || null,
    status: String(l.status || '').toLowerCase() || null,
    balanceUsd: Number(l.cardbalance || 0),
    validMonthYear: l.validmonthyear || null,
    number: l.cardnumber ? String(l.cardnumber).replace(/\s+/g, '') : null,
    cvv: l.cvv2 || null,
    billing: {
      street: l.billingaddressstreet || null,
      city: l.billingaddresscity || null,
      zip: l.billingaddresszipcode || null,
      country: l.billingaddresscountry || null,
    },
  };
}

async function getCard(cardCode) {
  return cardFrom(await call('CustomerCard/getCard', { cardCode }));
}

async function cardsByEmail(email) {
  const rows = (await call('CustomerCard/getCards', { customerEmail: email, customerCode: '' })) || [];
  return (Array.isArray(rows) ? rows : []).map(cardFrom);
}

async function cardTransactions(cardCode) {
  const d = await call('CustomerCard/getCardTransactions', { cardCode });
  const rows = Array.isArray(d) ? d : pick(d, 'cardTransactions') || [];
  return rows.map((t) => {
    const l = lower(t);
    return {
      id: l.code || l.reference,
      description: l.description || '',
      status: String(l.status || '').toLowerCase(),
      reference: l.reference || null,
      amountUsd: Number(l.amount || 0),
      feeUsd: Number(l.fee || 0),
      direction: String(l.drcr || '').toUpperCase() === 'CR' ? 'credit' : 'debit',
      category: String(l.category || '').toLowerCase(),
      createdAt: l.createdon || null,
    };
  });
}

const topupCard = (cardCode, amountUsd) => call('CustomerCard/topup', { cardCode, amountInUSD: amountUsd });
const withdrawCard = (cardCode, amountUsd, reason) =>
  call('CustomerCard/cardwithdrawal', { cardCode, amountInUSD: amountUsd, reason: reason || 'Move to wallet' });
const freezeCard = (cardCode) => call('customerCard/freezeCard', { cardCode });
const unfreezeCard = (cardCode) => call('customerCard/unfreezeCard', { cardCode });

/** For tests: replace the HTTP call. */
function setFetch(fn) {
  fetchImpl = fn;
}

module.exports = {
  CashwyreUnknownError,
  configured,
  pick,
  lower,
  countries,
  banks,
  accountLookup,
  payoutFee,
  initiatePayout,
  payoutStatus,
  payoutState,
  fxRates,
  walletBalance,
  createCard,
  getCard,
  cardFrom,
  cardsByEmail,
  cardTransactions,
  topupCard,
  withdrawCard,
  freezeCard,
  unfreezeCard,
  setFetch,
};
