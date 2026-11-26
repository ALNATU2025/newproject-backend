// Reloadly (SL_PROVIDER=reloadly): Sierra Leone airtime and data bundles
// for Africell, Orange and Qcell, paid from Dalabapay's prepaid Reloadly
// wallet (USD). EDSA electricity and Sierra Leone TV are not on Reloadly:
// those say "not connected yet" until a provider for them is added.
//
// Env: RELOADLY_CLIENT_ID, RELOADLY_CLIENT_SECRET, RELOADLY_ENV (live |
// sandbox). Amounts in and out are cents of Leones.
const env = require('../../config/env');
const { badRequest, unavailable, AppError } = require('../../utils/errors');

let doFetch = (...a) => fetch(...a);
function setFetch(fn) {
  doFetch = fn || ((...a) => fetch(...a));
}

const cfg = () => env.reloadly;
const live = () => cfg().env !== 'sandbox';
const audience = () => (live() ? 'https://topups.reloadly.com' : 'https://topups-sandbox.reloadly.com');
const ACCEPT = 'application/com.reloadly.topups-v1+json';
const configured = () => Boolean(cfg().clientId && cfg().clientSecret);

const notHere = () => {
  throw unavailable('This service is not connected yet in Sierra Leone. Please try again later.', 'PROVIDER_NOT_CONFIGURED');
};

let token = null; // { value, until }
async function getToken() {
  if (token && token.until > Date.now() + 60_000) return token.value;
  if (!configured()) notHere();
  let res;
  try {
    res = await doFetch('https://auth.reloadly.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: cfg().clientId, client_secret: cfg().clientSecret, grant_type: 'client_credentials', audience: audience() }),
    });
  } catch (e) {
    throw unavailable('Airtime provider is not responding. Please try again.', 'PROVIDER_UNAVAILABLE');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    console.error('[reloadly] token refused', res.status, j.message || j.error || '');
    throw unavailable('Airtime provider is not available right now.', 'PROVIDER_UNAVAILABLE');
  }
  token = { value: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return token.value;
}

async function call(method, path, body, { allowNoAnswer = false } = {}) {
  const t = await getToken();
  let res;
  try {
    res = await doFetch(`${audience()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, Accept: ACCEPT, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (allowNoAnswer) throw e; // a purchase with no answer stays pending
    throw unavailable('Airtime provider is not responding. Please try again.', 'PROVIDER_UNAVAILABLE');
  }
  const j = await res.json().catch(() => null);
  if (res.status === 401) token = null;
  if (!res.ok) {
    const msg = (j && (j.message || j.errorCode)) || `HTTP ${res.status}`;
    if (!env.isTest) console.warn(`[reloadly] ${method} ${path} → ${res.status} ${msg}`);
    if (res.status >= 500 && allowNoAnswer) throw new Error(`Reloadly error ${res.status}`);
    throw new AppError(400, msg, 'PROVIDER_DECLINED', { code: j && j.errorCode });
  }
  return j;
}

// ── Operators (cached 30 min) ───────────────────────────────
let opsCache = null;
async function operators() {
  if (opsCache && opsCache.at > Date.now() - 30 * 60 * 1000) return opsCache.list;
  const list = await call('GET', '/operators/countries/SL?includeBundles=true&includeData=true&includePin=false&suggestedAmounts=false');
  opsCache = { at: Date.now(), list: Array.isArray(list) ? list.filter((o) => !o.status || o.status === 'ACTIVE') : [] };
  return opsCache.list;
}

const NETWORKS = [
  { id: 'africell', name: 'Africell', match: /africell/i },
  { id: 'orange', name: 'Orange', match: /orange/i },
  { id: 'qcell', name: 'Qcell', match: /q-?cell/i },
];
const isBundle = (o) => Boolean(o.data || o.bundle) || /bundle|data/i.test(o.name || '');

/** The airtime operator (not a bundle) for a network. */
async function airtimeOperator(network) {
  const n = NETWORKS.find((x) => x.id === network);
  if (!n) throw badRequest('Choose a valid network.', 'INVALID_NETWORK');
  const op = (await operators()).find((o) => n.match.test(o.name || '') && !isBundle(o));
  if (!op) throw unavailable(`${n.name} airtime is not available right now.`, 'PROVIDER_NOT_CONFIGURED');
  return op;
}

/** Leones per unit of the sender currency (USD), from Reloadly's fx. */
const rateOf = (o) => Number(o.fx && o.fx.rate) || 0;

function lePrice(o, senderAmount, i) {
  const local = Array.isArray(o.localFixedAmounts) ? o.localFixedAmounts[i] : undefined;
  if (Number(local) > 0) return Number(local);
  return Math.round(Number(senderAmount) * rateOf(o) * 100) / 100;
}

module.exports = {
  name: 'reloadly',
  get environment() {
    return live() ? 'live' : 'sandbox';
  },
  isConfigured: configured,
  setFetch,
  _reset() {
    token = null;
    opsCache = null;
  },

  // Not on Reloadly (Nigeria and Sierra Leone bills).
  networks: notHere,
  dataPlans: notHere,
  cableProviders: notHere,
  cablePlans: notHere,
  verifySmartcard: notHere,
  discos: notHere,
  verifyMeter: notHere,
  educationProducts: notHere,
  verifyEducationProfile: notHere,
  insuranceOptions: notHere,
  insuranceModels: notHere,
  insuranceLgas: notHere,
  intlCountries: notHere,
  intlProductTypes: notHere,
  intlOperators: notHere,
  intlVariations: notHere,
  slVerifyMeter: notHere,
  slCableProviders: notHere,
  slCablePlans: notHere,
  slVerifySmartcard: notHere,

  /** Africell / Orange / Qcell, as far as Reloadly offers them. */
  async slNetworks() {
    const ops = await operators();
    return NETWORKS.filter((n) => ops.some((o) => n.match.test(o.name || ''))).map(({ id, name }) => ({ id, name }));
  },

  /** Fixed data bundles for a network, priced in Leones (cents). */
  async slDataPlans(network) {
    const n = NETWORKS.find((x) => x.id === network);
    if (!n) throw badRequest('Choose a valid network.', 'INVALID_NETWORK');
    const plans = [];
    for (const o of (await operators()).filter((x) => n.match.test(x.name || '') && isBundle(x))) {
      const amounts = Array.isArray(o.fixedAmounts) ? o.fixedAmounts : [];
      const descs = { ...(o.localFixedAmountsDescriptions || {}), ...(o.fixedAmountsDescriptions || {}) };
      amounts.forEach((amt, i) => {
        const le = lePrice(o, amt, i);
        if (!(le > 0)) return;
        const key = Number(amt).toFixed(2);
        const label = descs[key] || descs[String(amt)] || descs[Number(o.localFixedAmounts?.[i] || 0).toFixed(2)] || `${o.name} Le ${le.toLocaleString('en')}`;
        plans.push({ code: `${o.operatorId || o.id}:${key}`, name: String(label).slice(0, 80), amount: Math.round(le * 100), validity: null });
      });
    }
    plans.sort((a, b) => a.amount - b.amount);
    return plans;
  },

  async purchase({ service, requestId, amount, recipient, providerParams = {} }) {
    let body;
    if (service === 'sl_airtime') {
      const op = await airtimeOperator(providerParams.network);
      const le = amount / 100;
      if (op.supportsLocalAmounts) {
        body = { operatorId: op.operatorId || op.id, amount: le, useLocalAmount: true };
      } else {
        const r = rateOf(op);
        if (!(r > 0)) throw unavailable('Airtime pricing is not available right now.', 'PROVIDER_UNAVAILABLE');
        body = { operatorId: op.operatorId || op.id, amount: Math.round((le / r) * 100) / 100, useLocalAmount: false };
      }
    } else if (service === 'sl_data') {
      const [operatorId, senderAmount] = String(providerParams.planCode || '').split(':');
      if (!operatorId || !senderAmount) throw badRequest('This plan is no longer available.', 'PLAN_NOT_FOUND');
      body = { operatorId: Number(operatorId) || operatorId, amount: Number(senderAmount), useLocalAmount: false };
    } else {
      notHere();
    }
    const digits = String(recipient).replace(/\D/g, '');
    const local = digits.startsWith('232') ? `0${digits.slice(3)}` : digits;
    let j;
    try {
      j = await call('POST', '/topups', { ...body, customIdentifier: requestId, recipientPhone: { countryCode: 'SL', number: local } }, { allowNoAnswer: true });
    } catch (e) {
      if (e instanceof AppError) return { status: 'failed', providerReference: null, message: e.message };
      throw e; // no answer: stays pending, requery settles it
    }
    const st = String(j.status || '').toUpperCase();
    const status = st === 'SUCCESSFUL' ? 'success' : st === 'FAILED' || st === 'REFUNDED' ? 'failed' : 'pending';
    return {
      status,
      providerReference: j.transactionId ? String(j.transactionId) : null,
      message: status === 'success' ? 'Delivered' : j.message || st || 'Processing',
      data: {
        providerRaw: {
          transactionId: j.transactionId || null,
          operatorTransactionId: j.operatorTransactionId || null,
          status: st,
          deliveredAmount: j.deliveredAmount ?? null,
          deliveredCurrency: j.deliveredAmountCurrencyCode || null,
          cost: j.requestedAmount ?? null,
          costCurrency: j.requestedAmountCurrencyCode || null,
          discount: j.discount ?? null,
        },
        ...(j.pinDetail ? { pin: j.pinDetail } : {}),
      },
    };
  },

  /** By our reference (customIdentifier). */
  async requery(requestId) {
    const j = await call('GET', `/topups/reports/transactions?customIdentifier=${encodeURIComponent(requestId)}&size=1`);
    const t = (j && (j.content || j.data || []))[0];
    if (!t) return { status: 'failed', providerReference: null, message: 'Reloadly has no record of this top-up' };
    const st = String(t.status || 'SUCCESSFUL').toUpperCase();
    return {
      status: st === 'SUCCESSFUL' ? 'success' : st === 'FAILED' || st === 'REFUNDED' ? 'failed' : 'pending',
      providerReference: t.transactionId ? String(t.transactionId) : null,
      message: st,
    };
  },

  /** Reloadly wallet balance, in its currency's cents (usually USD). */
  async balance() {
    try {
      const j = await call('GET', '/accounts/balance');
      return Math.round(Number(j.balance) * 100);
    } catch {
      return null;
    }
  },

  async health() {
    if (!configured()) return { ok: false, message: 'RELOADLY_CLIENT_ID / RELOADLY_CLIENT_SECRET not set' };
    try {
      const ops = await operators();
      return { ok: true, message: `${ops.length} Sierra Leone products` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  },

  async testCredentials() {
    return this.health();
  },
};
