// VTpass bill provider (https://vtpass.com/documentation).
//
// Implemented: TV subscriptions — DStv, GOtv, StarTimes:
//   GET  service-variations?serviceID=…   bouquets (plans)
//   POST merchant-verify                  smartcard check
//   POST pay                              renew / change bouquet / recharge
//   POST requery                          status of a payment
//   GET  balance                          VTpass wallet balance (health)
// Other services answer "not connected yet" until they are added.
//
// Auth: api-key + public-key on GET, api-key + secret-key on POST.
// Amounts given to and returned from this module are kobo.
const { badRequest, unavailable } = require('../../utils/errors');

const N = 100; // kobo per naira
const BASE = {
  sandbox: 'https://sandbox.vtpass.com/api',
  live: 'https://vtpass.com/api',
};

const TV = {
  dstv: { name: 'DStv', renew: true, change: true },
  gotv: { name: 'GOtv', renew: true, change: true },
  startimes: { name: 'StarTimes', renew: false, change: true, singleMonth: true },
};

/** Codes where VTpass did not (or may not yet) settle the payment. */
const PENDING_CODES = new Set(['099', '089', '001', '083']);

const kobo = (naira) => Math.round(Number(naira) * N);
const naira = (k) => Math.round(Number(k)) / N;

/** "1 Month" / "1 Week" / "3 Months" from a bouquet name. */
function validityFrom(name) {
  const m = /(\d+)\s*(month|week|day|year)s?/i.exec(name || '');
  if (!m) return '1 month';
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** VTpass dates come as "2025-02-06T00:00:00" or "02-FEB-25". */
function parseDueDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s);
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = months.indexOf(m[2].toLowerCase());
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (mi >= 0) return new Date(Date.UTC(year, mi, Number(m[1]))).toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function alert(severity, title, body) {
  try {
    const { raiseAlert } = require('../../services/alerts'); // eslint-disable-line global-require
    await raiseAlert({ type: 'provider', severity, title, body });
  } catch {
    // Alerts must never break a payment.
  }
}

function createVtpass({
  apiKey,
  publicKey,
  secretKey,
  environment = 'sandbox',
  timeoutMs = 45000,
  fetchImpl = (...a) => fetch(...a),
} = {}) {
  const base = BASE[environment] || BASE.sandbox;
  const configured = Boolean(apiKey && publicKey && secretKey);
  const planCache = new Map(); // serviceID → { at, plans }
  const PLAN_TTL_MS = 10 * 60 * 1000;

  function notConnected() {
    return unavailable(
      'This service is not connected yet. Please try again later.',
      'PROVIDER_NOT_CONFIGURED',
    );
  }

  /**
   * Raw call. Network problems and timeouts throw a plain Error (so a payment
   * stays pending and is checked later instead of being refunded blindly).
   */
  async function call(method, path, body) {
    if (!configured) throw notConnected();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/${path}`, {
        method,
        headers: {
          'api-key': apiKey,
          ...(method === 'GET' ? { 'public-key': publicKey } : { 'secret-key': secretKey }),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (res.status === 401 || res.status === 403) {
        await alert('critical', 'VTpass rejected our API keys', `HTTP ${res.status}. Check VTPASS_API_KEY / keys and the IP whitelist.`);
      }
      if (!json) {
        const err = new Error(`VTpass returned an unreadable response (HTTP ${res.status})`);
        err.vtpassStatus = res.status;
        throw err;
      }
      return json;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('VTpass did not respond in time');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** For lookups: any provider trouble becomes a clear 503 for the app. */
  async function lookup(method, path, body) {
    try {
      return await call(method, path, body);
    } catch (e) {
      if (e.status) throw e; // already an AppError
      throw unavailable('The TV provider is not reachable right now. Please try again shortly.', 'PROVIDER_UNAVAILABLE');
    }
  }

  function tvOrFail(provider) {
    const tv = TV[provider];
    if (!tv) throw badRequest('Choose a valid TV provider.', 'INVALID_PROVIDER');
    return tv;
  }

  /** Turns a pay/requery response into { status, providerReference, message, data }. */
  async function interpret(json, { requestId, expectedKobo } = {}) {
    const code = String(json.code ?? '');
    const t = (json.content && json.content.transactions) || {};
    const description = json.response_description || '';
    const raw = {
      code,
      description,
      transactionId: t.transactionId || null,
      status: t.status || null,
      amount: json.amount ?? t.amount ?? null,
      commission: t.commission ?? null,
      totalAmount: t.total_amount ?? null,
    };
    const result = (status, message) => ({
      status,
      providerReference: t.transactionId || null,
      message,
      data: { providerRaw: raw },
    });

    if (code === '000') {
      const s = String(t.status || '').toLowerCase();
      if (s === 'delivered' || s === 'successful') {
        if (expectedKobo && raw.amount !== null && Math.abs(kobo(raw.amount) - expectedKobo) > N) {
          await alert(
            'warning',
            'VTpass amount differs',
            `${requestId}: we charged ₦${naira(expectedKobo)} but VTpass recorded ₦${raw.amount}.`,
          );
        }
        return result('success', 'Delivered');
      }
      if (s === 'failed' || s === 'reversed') return result('failed', description || 'The provider declined this payment.');
      return result('pending', 'Waiting for the provider to confirm.');
    }
    if (code === '040') return result('failed', 'The provider reversed this payment.');
    if (code === '018') {
      await alert('critical', 'VTpass wallet balance is low', `A payment (${requestId}) failed because the VTpass wallet is low. Top it up on vtpass.com.`);
      return result('failed', 'This service is temporarily unavailable.');
    }
    if (PENDING_CODES.has(code) || !code) return result('pending', 'Waiting for the provider to confirm.');
    return result('failed', description || `The provider declined this payment (code ${code}).`);
  }

  // ── Bill provider interface ─────────────────────────────

  async function cablePlans(provider) {
    tvOrFail(provider);
    const hit = planCache.get(provider);
    if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plans;
    const json = await lookup('GET', `service-variations?serviceID=${encodeURIComponent(provider)}`);
    const list = (json.content && (json.content.variations || json.content.varations)) || [];
    const plans = list
      .filter((v) => Number(v.variation_amount) > 0 && String(v.fixedPrice || 'Yes').toLowerCase() === 'yes')
      .map((v) => ({
        code: String(v.variation_code),
        name: String(v.name).replace(/\s+/g, ' ').trim(),
        amount: kobo(v.variation_amount),
        validity: validityFrom(v.name),
      }));
    if (!plans.length) throw unavailable('No packages are available for this provider right now.', 'PROVIDER_UNAVAILABLE');
    planCache.set(provider, { at: Date.now(), plans });
    return plans;
  }

  async function verifySmartcard(provider, smartcardNumber) {
    const tv = tvOrFail(provider);
    const json = await lookup('POST', 'merchant-verify', { billersCode: String(smartcardNumber), serviceID: provider });
    const c = json.content || {};
    if (String(json.code) !== '000' || c.error || c.WrongBillersCode === true || !c.Customer_Name) {
      throw badRequest(
        c.error || 'We couldn\'t find this smartcard number. Please check it.',
        'NOT_FOUND',
      );
    }
    const renewal = c.Renewal_Amount !== undefined && c.Renewal_Amount !== null ? kobo(c.Renewal_Amount) : null;
    const bouquet = c.Current_Bouquet ? String(c.Current_Bouquet).trim() : null;
    let currentPlanCode = null;
    if (bouquet) {
      try {
        const plans = await cablePlans(provider);
        const match = plans.find((p) => p.name.toLowerCase().startsWith(bouquet.toLowerCase()));
        currentPlanCode = match ? match.code : null;
      } catch {
        currentPlanCode = null;
      }
    }
    const canRenew = tv.renew && renewal !== null && renewal > 0;
    return {
      customerName: String(c.Customer_Name).trim(),
      currentPlan: bouquet,
      currentPlanCode: canRenew ? currentPlanCode || 'renew' : null,
      renewalAmount: canRenew ? renewal : null,
      dueDate: parseDueDate(c.Due_Date),
      status: c.Status || null,
      balance: c.Balance !== undefined ? kobo(c.Balance) : null,
      canRenew,
      maxMonths: tv.singleMonth ? 1 : 12,
    };
  }

  async function purchase({ service, requestId, recipient, amount, provider, action, planCode, months = 1, phone }) {
    if (service !== 'cable') throw notConnected();
    const tv = tvOrFail(provider);
    const body = {
      request_id: requestId,
      serviceID: provider,
      billersCode: String(recipient),
      phone: String(phone || ''),
    };
    if (action === 'renew') {
      if (!tv.renew) throw badRequest(`${tv.name} can't be renewed this way. Choose a package instead.`, 'RENEW_NOT_SUPPORTED');
      body.subscription_type = 'renew';
      body.amount = naira(amount);
    } else {
      body.variation_code = planCode;
      if (tv.change && provider !== 'startimes') {
        body.subscription_type = 'change';
        body.quantity = Number(months) || 1;
      }
    }
    // Errors here (timeout, network) propagate: the payment stays pending.
    const json = await call('POST', 'pay', body);
    return interpret(json, { requestId, expectedKobo: amount });
  }

  async function requery(requestId) {
    const json = await call('POST', 'requery', { request_id: requestId });
    if (String(json.code) === '015') {
      return { status: 'failed', providerReference: null, message: 'VTpass has no record of this payment.' };
    }
    return interpret(json, { requestId });
  }

  async function balance() {
    const json = await call('GET', 'balance');
    const b = json.contents && json.contents.balance;
    if (b === undefined || b === null) throw new Error('VTpass did not return a balance');
    return kobo(b);
  }

  async function health() {
    if (!configured) return { ok: false, latencyMs: null, message: 'VTpass keys are not set.' };
    const started = Date.now();
    try {
      const b = await balance();
      return { ok: true, latencyMs: Date.now() - started, message: `VTpass ${environment} is reachable · balance ₦${naira(b).toLocaleString('en-NG')}` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, message: `VTpass ${environment}: ${e.message}` };
    }
  }

  async function testCredentials() {
    const h = await health();
    return { ok: h.ok, message: h.ok ? `Your VTpass ${environment} keys work.` : h.message };
  }

  const fail = async () => {
    throw notConnected();
  };

  return {
    name: 'vtpass',
    environment,
    isConfigured: () => configured,
    services: ['cable'],
    cableProviders: async () => Object.entries(TV).map(([id, t]) => ({ id, name: t.name })),
    cablePlans,
    verifySmartcard,
    purchase,
    requery,
    balance,
    health,
    testCredentials,
    networks: fail,
    dataPlans: fail,
    discos: fail,
    verifyMeter: fail,
    educationProducts: fail,
    verifyEducationProfile: fail,
    insuranceOptions: fail,
    insuranceModels: fail,
    insuranceLgas: fail,
    intlCountries: fail,
    intlProductTypes: fail,
    intlOperators: fail,
    intlVariations: fail,
  };
}

module.exports = { createVtpass, validityFrom, parseDueDate };
