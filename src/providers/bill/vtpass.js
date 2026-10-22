// VTpass bill provider (https://vtpass.com/documentation).
//
// Implemented:
// • TV subscriptions — DStv, GOtv, StarTimes:
//   GET  service-variations?serviceID=…   bouquets (plans)
//   POST merchant-verify                  smartcard check
//   POST pay                              renew / change bouquet / recharge
// • International airtime / data / PINs (serviceID foreign-airtime):
//   GET  get-international-airtime-countries
//   GET  get-international-airtime-product-types?code=GH
//   GET  get-international-airtime-operators?code=GH&product_type_id=1
//   GET  service-variations?serviceID=foreign-airtime&operator_id=…&product_type_id=…
//   POST pay
// • Both: POST requery (status), GET balance (VTpass wallet, health)
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

/** The documented sandbox test numbers; passed to VTpass unchanged. */
const SANDBOX_NUMBERS = new Set(['08011111111', '201000000000', '500000000000', '400000000000', '300000000000']);

/** "GH" → 🇬🇭 */
function flagEmoji(code) {
  const c = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '🌍';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

const positive = (v) => (Number(v) > 0 ? Number(v) : null);

/**
 * One international variation. Fixed-price variations are sold at VTpass's
 * naira charge (charged_amount, or variation_rate × local amount); flexible
 * ones at variation_rate × the local amount the customer types. A variation
 * with no price we can work out is left out — we never sell at a guess.
 */
function intlVariation(v) {
  const rate = positive(v.variation_rate);
  const charged = positive(v.charged_amount);
  const local = positive(v.variation_amount) || 0;
  const range = /(\d[\d,]*(?:\.\d+)?)\s*-\s*(\d[\d,]*(?:\.\d+)?)/.exec(v.name || '');
  // VTpass marks some top-ups "fixed" although they are a range with no set
  // amount ("160 -2000 GMD Top Up", variation_amount 0). Those need the
  // amount the customer chooses, or VTpass answers INVALID ARGUMENTS.
  const flaggedFixed = String(v.fixedPrice || 'Yes').toLowerCase() === 'yes';
  const fixed = flaggedFixed && !(local === 0 && range && rate);
  const num = (x) => Number(String(x).replace(/,/g, ''));
  const base = {
    code: String(v.variation_code),
    name: String(v.name || '').replace(/\s+/g, ' ').trim(),
    fixed,
    amount: local,
    rate,
  };
  if (fixed) {
    const nairaAmount = charged ? kobo(charged) : rate && local ? kobo(local * rate) : null;
    return nairaAmount ? { ...base, nairaAmount } : null;
  }
  if (!rate) return null;
  return {
    ...base,
    nairaAmount: null,
    min: positive(v.minimum_amount) || (range ? num(range[1]) : 1),
    max: positive(v.maximum_amount) || (range ? num(range[2]) : 100000),
  };
}

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
    const data = { providerRaw: raw };
    if (json.purchased_code) data.token = String(json.purchased_code);
    if (Array.isArray(json.cards) && json.cards.length) {
      data.pins = json.cards.map((c) => ({
        pin: String(c.pin || c.Pin || c.code || c.Code || ''),
        serial: c.serial || c.Serial || c.serialNumber || null,
      }));
    }
    const result = (status, message) => ({
      status,
      providerReference: t.transactionId || null,
      message,
      data,
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
    if (code === '011') {
      return result('failed', 'The provider didn\'t accept these payment details (code 011). Your money has been returned — please check the number and plan and try again.');
    }
    return result('failed', description || `The provider declined this payment (code ${code}).`);
  }

  /**
   * Logs why VTpass didn't complete a payment, with the fields we sent
   * (no keys, phone partly hidden) so problems can be fixed from the log.
   */
  function logDecline(serviceID, json, body, fixed) {
    if (process.env.NODE_ENV === 'test') return;
    const digits = String(body.billersCode || '');
    const masked = digits.length > 4 ? `${digits.slice(0, 3)}…${digits.slice(-3)}` : digits;
    console.warn(
      `[vtpass] ${serviceID} not completed: code=${json.code ?? '-'} "${json.response_description || ''}"`
        + ` request_id=${body.request_id} billersCode=${masked} variation=${body.variation_code || '-'}`
        + ` operator=${body.operator_id || '-'} country=${body.country_code || '-'} type=${body.product_type_id || '-'}`
        + ` amount=${body.amount ?? '-'} fixed=${fixed} email=${body.email ? 'set' : 'MISSING'}`,
    );
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

  // ── International airtime / data / PINs ───────────────────

  const intlCache = new Map(); // key → { at, value }
  async function cached(key, ttlMs, load) {
    const hit = intlCache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await load();
    intlCache.set(key, { at: Date.now(), value });
    return value;
  }
  const HOUR = 60 * 60 * 1000;
  const qs = (o) => new URLSearchParams(o).toString();

  async function intlCountries() {
    return cached('countries', HOUR, async () => {
      const json = await lookup('GET', 'get-international-airtime-countries');
      const list = (json.content && json.content.countries) || [];
      return list
        .filter((c) => c.code && c.prefix)
        .map((c) => ({
          code: String(c.code).toUpperCase(),
          name: String(c.name),
          flag: flagEmoji(c.code),
          flagUrl: c.flag || null,
          dialCode: `+${String(c.prefix).replace(/\D/g, '')}`,
          currency: String(c.currency || ''),
        }));
    });
  }

  async function intlProductTypes(country) {
    return cached(`types:${country}`, HOUR, async () => {
      const json = await lookup('GET', `get-international-airtime-product-types?${qs({ code: country })}`);
      return (Array.isArray(json.content) ? json.content : []).map((t) => ({
        id: String(t.product_type_id),
        name: String(t.name),
      }));
    });
  }

  async function intlOperators(country, productType) {
    return cached(`ops:${country}:${productType}`, HOUR, async () => {
      const json = await lookup('GET', `get-international-airtime-operators?${qs({ code: country, product_type_id: productType })}`);
      return (Array.isArray(json.content) ? json.content : []).map((o) => ({
        id: String(o.operator_id),
        name: String(o.name),
        image: o.operator_image || null,
      }));
    });
  }

  async function intlVariations(country, operatorId, productType) {
    const countries = await intlCountries();
    const c = countries.find((x) => x.code === country);
    if (!c) throw badRequest('Choose a valid country.', 'INVALID_COUNTRY');
    return cached(`vars:${operatorId}:${productType}`, PLAN_TTL_MS, async () => {
      const json = await lookup(
        'GET',
        `service-variations?${qs({ serviceID: 'foreign-airtime', operator_id: operatorId, product_type_id: productType })}`,
      );
      const list = (json.content && (json.content.variations || json.content.varations)) || [];
      const variations = list.map(intlVariation).filter(Boolean);
      if (!variations.length && list.length) {
        await alert(
          'warning',
          'International prices missing',
          `VTpass returned ${list.length} plans for ${c.name} operator ${operatorId} without prices (charged_amount / variation_rate), so none can be sold.`,
        );
      }
      const firstRate = variations.find((v) => v.rate);
      return { currency: c.currency, rate: firstRate ? firstRate.rate : 0, variations };
    });
  }

  async function purchaseInternational({ requestId, recipient, amount, country, productType, operator, variationCode, foreignAmount, fixed, email, phone }) {
    const typed = String(phone || '');
    const billersCode =
      environment === 'sandbox' && SANDBOX_NUMBERS.has(typed) ? typed : String(recipient).replace(/\D/g, '');
    const body = {
      request_id: requestId,
      serviceID: 'foreign-airtime',
      billersCode,
      variation_code: variationCode,
      phone: billersCode,
      operator_id: String(operator),
      country_code: String(country),
      product_type_id: String(productType),
      email: email || '',
    };
    // Range/"any amount" plans need the amount; for set plans VTpass ignores
    // it, but sending the plan's own amount does no harm.
    if (foreignAmount) body.amount = Number(foreignAmount);
    const json = await call('POST', 'pay', body);
    const result = await interpret(json, { requestId, expectedKobo: amount });
    if (result.status !== 'success') logDecline('foreign-airtime', json, body, fixed);
    return result;
  }

  async function purchase(args) {
    if (args.service === 'international') return purchaseInternational(args);
    const { service, requestId, recipient, amount, provider, action, planCode, months = 1, phone } = args;
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
    services: ['cable', 'international'],
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
    intlCountries,
    intlProductTypes,
    intlOperators,
    intlVariations,
  };
}

module.exports = { createVtpass, validityFrom, parseDueDate, flagEmoji, intlVariation };
