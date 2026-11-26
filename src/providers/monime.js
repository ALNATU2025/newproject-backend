// Monime (Sierra Leone): Orange Money / Afrimoney / bank money in and out.
//   • Add Money: a one-time Payment Code the customer dials (USSD) and
//     approves with their mobile money PIN → webhook → wallet credited.
//   • Transfers to Sierra Leone mobile money / banks: Payouts.
// Docs: https://docs.monime.io (API version caph.2025-08-23).
//
// Env: MONIME_ACCESS_TOKEN, MONIME_SPACE_ID (spc-…), MONIME_WEBHOOK_SECRET,
// optional MONIME_BASE_URL (default https://api.monime.io), MONIME_VERSION,
// MONIME_AMOUNT_UNIT (minor = cents, the default; major = whole Leones).
const crypto = require('crypto');
const env = require('../config/env');
const { AppError, unavailable } = require('../utils/errors');

let doFetch = (...a) => fetch(...a);
/** Tests replace Monime's API with a fake. */
function setFetch(fn) {
  doFetch = fn || ((...a) => fetch(...a));
}

const cfg = () => env.monime;
const configured = () => Boolean(cfg().accessToken && cfg().spaceId);

/** Our amounts are in cents; Monime's per MONIME_AMOUNT_UNIT. */
const toMonime = (cents) => (cfg().amountUnit === 'major' ? Math.round(cents) / 100 : Math.round(cents));
const fromMonime = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return cfg().amountUnit === 'major' ? Math.round(n * 100) : Math.round(n);
};

// Known Sierra Leone mobile money providers (Monime ids). The live list
// comes from GET /v1/momos; this is the fallback.
const FALLBACK_MOMOS = [
  { id: 'm17', name: 'Orange Money' },
  { id: 'm18', name: 'Afrimoney' },
];

/** "076 123 456" / "+23276123456" / "23276123456" → "+23276123456". */
function msisdn(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('232') && d.length === 11) return `+${d}`;
  if (d.startsWith('0') && d.length === 9) return `+232${d.slice(1)}`;
  if (d.length === 8) return `+232${d}`;
  return d ? `+${d}` : '';
}

async function request(method, path, { body, idempotencyKey } = {}) {
  if (!configured()) throw unavailable('Mobile money is not connected yet. Please try again later.', 'PROVIDER_NOT_CONFIGURED');
  const headers = {
    Authorization: `Bearer ${cfg().accessToken}`,
    'Monime-Space-Id': cfg().spaceId,
    'Monime-Version': cfg().version,
    Accept: 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 64);
  let res;
  try {
    res = await doFetch(`${cfg().baseUrl.replace(/\/$/, '')}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    const err = new Error(`Monime did not respond: ${e.message}`);
    err.noAnswer = true;
    throw err;
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.success === false) {
    const msg = (json && (json.error?.message || (Array.isArray(json.messages) && json.messages[0]) || json.message)) || `HTTP ${res.status}`;
    if (!env.isTest) console.warn(`[monime] ${method} ${path} → ${res.status} ${String(msg).slice(0, 300)}`);
    if (res.status >= 500 || res.status === 429) {
      const err = new Error(`Monime error: ${msg}`);
      err.noAnswer = true;
      throw err;
    }
    throw new AppError(400, typeof msg === 'string' ? msg : 'Declined by Monime', 'PROVIDER_DECLINED');
  }
  return json.result !== undefined ? json.result : json;
}

/** Mobile money providers that can pay in / be paid in Sierra Leone. */
async function momos() {
  try {
    const r = await request('GET', '/v1/momos?country=SL');
    const list = (Array.isArray(r) ? r : r.items || r.data || []).filter((m) => m && (m.providerId || m.id));
    if (!list.length) return FALLBACK_MOMOS;
    return list
      .filter((m) => !m.status || m.status.active !== false)
      .map((m) => ({
        id: m.providerId || m.id,
        name: m.name || m.providerId,
        canPay: m.featureSet?.payment?.canPayFrom !== false,
        canReceive: m.featureSet?.payout?.canPayTo !== false,
      }));
  } catch (e) {
    if (e instanceof AppError && e.code === 'PROVIDER_NOT_CONFIGURED') throw e;
    return FALLBACK_MOMOS;
  }
}

/** Banks in Sierra Leone Monime can pay to. */
async function banks() {
  try {
    const r = await request('GET', '/v1/banks?country=SL');
    const list = Array.isArray(r) ? r : r.items || r.data || [];
    return list
      .filter((b) => b && (b.providerId || b.id) && (!b.status || b.status.active !== false))
      .map((b) => ({ id: b.providerId || b.id, name: b.name || b.providerId }));
  } catch (e) {
    if (e instanceof AppError && e.code === 'PROVIDER_NOT_CONFIGURED') throw e;
    return [];
  }
}

/** Add Money: a one-time code the customer dials and approves. */
async function createPaymentCode({ reference, amountCents, phone, providerId, name, customerName, metadata = {}, duration = '15m' }) {
  const body = {
    name: String(name || 'Dalabapay top-up').slice(0, 64),
    mode: 'one_time',
    enable: true,
    amount: { currency: 'SLE', value: toMonime(amountCents) },
    duration,
    reference: String(reference).slice(0, 64),
    metadata: { reference, ...metadata },
  };
  if (customerName) body.customer = { name: String(customerName).slice(0, 100) };
  if (providerId) body.authorizedProviders = [providerId];
  const p = msisdn(phone);
  if (p) body.authorizedPhoneNumber = p;
  const r = await request('POST', '/v1/payment-codes', { body, idempotencyKey: `pc-${reference}` });
  return { id: r.id, ussdCode: r.ussdCode, status: r.status, expireTime: r.expireTime || null, raw: r };
}

async function getPaymentCode(id) {
  return request('GET', `/v1/payment-codes/${encodeURIComponent(id)}`);
}

async function cancelPaymentCode(id) {
  try {
    await request('DELETE', `/v1/payment-codes/${encodeURIComponent(id)}`);
  } catch {
    // already used or expired
  }
}

/** Money out to Sierra Leone mobile money or a bank account. */
async function createPayout({ reference, amountCents, type, providerId, accountNumber, metadata = {} }) {
  const destination = type === 'bank'
    ? { type: 'bank', providerId, accountNumber: String(accountNumber) }
    : { type: 'momo', providerId, phoneNumber: msisdn(accountNumber) };
  const r = await request('POST', '/v1/payouts', {
    body: { amount: { currency: 'SLE', value: toMonime(amountCents) }, destination, metadata: { reference, ...metadata } },
    idempotencyKey: `po-${reference}`,
  });
  return { id: r.id, status: r.status, raw: r };
}

async function getPayout(id) {
  return request('GET', `/v1/payouts/${encodeURIComponent(id)}`);
}

/** Monime status → ours. */
function codeState(status) {
  if (status === 'completed') return 'success';
  if (status === 'expired' || status === 'cancelled') return 'failed';
  return 'pending';
}
function payoutState(status) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'failed';
  return 'pending';
}

/**
 * Checks the `monime-signature` header ("t=<unix>,v1=<base64>"): HMAC-SHA256
 * of "<t>_<raw body>" with MONIME_WEBHOOK_SECRET, at most 5 minutes old.
 */
function verifySignature(header, rawBody, { now = Date.now() } = {}) {
  const secret = cfg().webhookSecret;
  if (!secret || !header || !rawBody) return false;
  const parts = {};
  for (const kv of String(header).split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  const age = Math.floor(now / 1000) - t;
  if (age > 300 || age < -60) return false;
  const expected = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${parts.t}_`), Buffer.from(rawBody)])).digest();
  let got;
  try {
    got = Buffer.from(parts.v1, 'base64');
  } catch {
    return false;
  }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

module.exports = {
  configured,
  setFetch,
  momos,
  banks,
  createPaymentCode,
  getPaymentCode,
  cancelPaymentCode,
  createPayout,
  getPayout,
  codeState,
  payoutState,
  verifySignature,
  msisdn,
  toMonime,
  fromMonime,
  FALLBACK_MOMOS,
};
