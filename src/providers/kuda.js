// Kuda Business API (Nigeria): account numbers for adding money, and bank
// transfers to Nigerian banks.
//
// Every call is a POST to the base URL with
//   { serviceType, requestRef, data }   and   Authorization: Bearer <token>
// The token comes from POST {base}/Account/GetToken { email, apiKey } and
// is returned as a raw JWT string. Amounts are in KOBO.
//
//   KUDA_EMAIL            business email on the Kuda Business account
//   KUDA_API_KEY          Business API key (Kuda dashboard → Business API)
//   KUDA_ACCOUNT_NUMBER   your Kuda Business main account number
//   KUDA_ENV              live (default) | uat (test)
//   KUDA_WEBHOOK_TOKEN    secret in the webhook URL given to Kuda
//
// Errors:
//   Kuda said no (status false / HTTP 4xx) → AppError 400 PROVIDER_DECLINED
//     (nothing happened; safe to refund).
//   No answer (timeout, network, HTTP 5xx) → KudaUnknownError (a transfer
//     may or may not have gone through: check with TSQ, never resend).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { AppError, unavailable } = require('../utils/errors');

let fetchImpl = (...a) => fetch(...a);

class KudaUnknownError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KudaUnknownError';
  }
}

const configured = () => Boolean(env.kuda.email && env.kuda.apiKey && env.kuda.accountNumber);
const baseUrl = () => (env.kuda.env === 'uat' ? 'https://kuda-openapi-uat.kudabank.com/v2.1' : 'https://kuda-openapi.kuda.com/v2.1');

/** Short alphanumeric reference (Kuda prefers these to UUIDs). */
const ref = (prefix = 'DP') => `${prefix}${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/** Reads a field whatever its casing. */
function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const keys = Object.keys(obj);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// ── Token ──────────────────────────────────────────────────

let token = null;
let tokenUntil = 0;

async function getToken({ fresh = false } = {}) {
  if (!fresh && token && Date.now() < tokenUntil) return token;
  let res;
  try {
    res = await fetchImpl(`${baseUrl()}/Account/GetToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: env.kuda.email, apiKey: env.kuda.apiKey }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw unavailable('Kuda is not reachable right now. Please try again.', 'PROVIDER_UNAVAILABLE');
  }
  const text = (await res.text().catch(() => '')).trim();
  // A raw JWT, sometimes in quotes, or (older versions) JSON { token }.
  let t = text.replace(/^"|"$/g, '');
  if (t.startsWith('{')) {
    try {
      t = pick(JSON.parse(t), 'token', 'data') || '';
    } catch {
      t = '';
    }
  }
  if (!res.ok || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(t)) {
    if (!env.isTest) console.error(`[kuda] GetToken failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    throw unavailable('Kuda sign-in failed. Check KUDA_EMAIL and KUDA_API_KEY.', 'PROVIDER_AUTH_FAILED');
  }
  token = t;
  const exp = (jwt.decode(t) || {}).exp;
  tokenUntil = exp ? exp * 1000 - 2 * 60 * 1000 : Date.now() + 20 * 60 * 1000;
  return token;
}

// ── Calls ──────────────────────────────────────────────────

function isOk(j) {
  const status = pick(j, 'status', 'isSuccessful', 'success');
  const code = String(pick(j, 'responseCode') || '').toLowerCase();
  if (status === true || status === 'true') return true;
  if (status === false || status === 'false') return false;
  return code === '00' || code === 'k00';
}

async function call(serviceType, data = {}, { requestRef = ref(), retried = false } = {}) {
  if (!configured()) throw unavailable('Kuda is not connected yet.', 'PROVIDER_NOT_CONFIGURED');
  const t = await getToken();
  let res;
  try {
    res = await fetchImpl(baseUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ serviceType, requestRef, data }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    throw new KudaUnknownError(`${serviceType}: ${e.message}`);
  }
  if (res.status === 401 && !retried) {
    await getToken({ fresh: true });
    return call(serviceType, data, { requestRef, retried: true });
  }
  const text = await res.text().catch(() => '');
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = null;
  }
  if (!env.isTest && serviceType !== 'BANK_LIST') console.log(`[kuda] ${serviceType} ${requestRef} → HTTP ${res.status} ${text.slice(0, 500)}`);
  if (res.status >= 500 || (!j && res.ok)) throw new KudaUnknownError(`${serviceType}: HTTP ${res.status}`);
  if (!res.ok || !j || !isOk(j)) {
    const message = String(pick(j || {}, 'message', 'responseMessage') || `HTTP ${res.status}`);
    const err = new AppError(400, message, 'PROVIDER_DECLINED');
    err.providerCode = String(pick(j || {}, 'responseCode') || '');
    throw err;
  }
  return { body: j, data: pick(j, 'data') || {}, requestRef };
}

// ── Banks and names ────────────────────────────────────────

async function bankList() {
  const { data } = await call('BANK_LIST', {});
  const rows = Array.isArray(data) ? data : pick(data, 'banks', 'bankList') || [];
  return rows
    .map((b) => ({ code: String(pick(b, 'bankCode', 'code') || ''), name: String(pick(b, 'bankName', 'name') || '').trim() }))
    .filter((b) => b.code && b.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** { accountName, sessionId } or throws PROVIDER_DECLINED. */
async function nameEnquiry({ bankCode, accountNumber }) {
  const { data } = await call('NAME_ENQUIRY', { beneficiaryAccountNumber: accountNumber, beneficiaryBankCode: bankCode });
  const name = pick(data, 'beneficiaryName', 'accountName');
  if (!name) throw new AppError(400, 'Account not found', 'PROVIDER_DECLINED');
  return { accountName: String(name).trim(), sessionId: pick(data, 'sessionID', 'sessionId') || null };
}

// ── Transfers ──────────────────────────────────────────────

/** True for a Kuda-to-Kuda transfer (TSQ needs to know). */
const isKudaBank = (bankName) => /kuda/i.test(String(bankName || ''));

async function transfer({ requestRef, bankCode, accountNumber, accountName, amountKobo, narration, sessionId }) {
  const { data, body } = await call(
    'SINGLE_FUND_TRANSFER',
    {
      beneficiaryAccount: accountNumber,
      beneficiaryBankCode: bankCode,
      amount: String(amountKobo),
      clientAccountNumber: env.kuda.accountNumber,
      beneficiaryName: accountName,
      narration: String(narration || 'Dalabapay transfer').slice(0, 100),
      ...(sessionId ? { nameEnquirySessionID: sessionId } : {}),
    },
    { requestRef },
  );
  return { transactionReference: pick(data, 'transactionReference', 'sessionID', 'sessionId') || null, message: pick(body, 'message') || null };
}

/** 'success' | 'failed' | 'pending' from words or codes in a response. */
function stateOf(...values) {
  const s = values.filter((v) => v !== undefined && v !== null).map((v) => String(v).toLowerCase()).join(' ');
  if (/pending|processing|in progress|queued|awaiting/.test(s)) return 'pending';
  if (/fail|revers|declin|reject|cancel|insufficient/.test(s)) return 'failed';
  if (/success|completed|approved/.test(s)) return 'success';
  return 'pending';
}

/** Transfer status (TSQ) by our original requestRef. */
async function transferStatus({ requestRef, thirdParty = true }) {
  try {
    const { data, body } = await call('TRANSACTION_STATUS_QUERY', { isThirdPartyBankTransfer: thirdParty, transactionRequestReference: requestRef });
    // Only clear words settle a transfer ("successful", "failed"…); a bare
    // true/false may just mean the query itself worked.
    const status = stateOf(pick(data, 'transactionStatus', 'statusDescription', 'statusMessage'), pick(data, 'message', 'responseMessage'));
    return { status, message: pick(data, 'message', 'statusDescription') || pick(body, 'message') || null };
  } catch (e) {
    // k25: no record yet — keep waiting.
    if (e instanceof AppError && String(e.providerCode).toLowerCase() === 'k25') return { status: 'pending', message: 'Not found yet' };
    throw e;
  }
}

// ── Account numbers for adding money ───────────────────────

/**
 * A pass-through account: never closes, any amount, money goes straight to
 * the main account. One per customer (Add Money).
 */
async function createPassThroughAccount({ accountName, requestRef = ref('KDA') }) {
  const { data } = await call(
    'ADMIN_CREATE_DYNAMIC_COLLECTION_ACCOUNT',
    {
      amount: 0,
      isPassThrough: true,
      isFlexiblePayment: false,
      accountName: String(accountName || '').slice(0, 40),
      remittingAccounts: [{ splitPercentage: 100, accountNumber: env.kuda.accountNumber }],
    },
    { requestRef },
  );
  const accountNumber = pick(data, 'accountNumber', 'virtualAccountNumber', 'dynamicAccountNumber');
  if (!accountNumber) throw new AppError(400, 'Kuda did not return an account number', 'PROVIDER_DECLINED');
  return {
    accountNumber: String(accountNumber),
    accountName: String(pick(data, 'accountName') || accountName || ''),
    bankName: String(pick(data, 'bankName') || 'Kuda MFB'),
    providerRef: requestRef,
  };
}

/** Payments received on a dynamic account (TSQ). */
async function accountStatus({ requestRef, accountNumber }) {
  const { data } = await call('DYNAMIC_COLLECTION_ACCOUNT_TSQ', {
    ...(requestRef ? { accountCreationRequestRef: requestRef } : {}),
    ...(accountNumber ? { accountNumber } : {}),
  });
  return data;
}

// ── Incoming payment notifications ─────────────────────────

/**
 * Normalises Kuda's credit notification. Amount is read as kobo (as the
 * rest of Kuda's API); a naira payload would be under-credited, never
 * over-credited. Returns null for anything that isn't a credit.
 */
function parseCredit(body) {
  const b = pick(body || {}, 'data', 'payload') || body || {};
  const type = String(pick(b, 'transactionType', 'type', 'direction') || 'credit').toLowerCase();
  if (type && !/credit|inflow|incoming|cr$/.test(type)) return null;
  const amount = Number(String(pick(b, 'amount', 'amountInKobo', 'transactionAmount') || '').replace(/,/g, ''));
  const accountNumber = pick(b, 'accountNumber', 'virtualAccountNumber', 'recipientAccountNumber', 'beneficiaryAccountNumber', 'creditAccount');
  const reference = pick(b, 'transactionReference', 'sessionId', 'sessionID', 'instrumentNumber', 'reference', 'requestRef');
  if (!(amount > 0) || !accountNumber || !reference) return null;
  return {
    amount: Math.round(amount),
    accountNumber: String(accountNumber),
    providerReference: `KUDA-${reference}`,
    senderName: pick(b, 'senderName', 'payerName', 'originatorAccountName') || null,
    narration: pick(b, 'narrations', 'narration', 'remarks') || null,
  };
}

// ── Tests ──────────────────────────────────────────────────

function setFetch(fn) {
  fetchImpl = fn;
  token = null;
  tokenUntil = 0;
}

module.exports = {
  configured,
  ref,
  pick,
  getToken,
  bankList,
  nameEnquiry,
  transfer,
  transferStatus,
  stateOf,
  isKudaBank,
  createPassThroughAccount,
  accountStatus,
  parseCredit,
  KudaUnknownError,
  setFetch,
};
