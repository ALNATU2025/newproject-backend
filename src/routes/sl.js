// Sierra Leone services, in Leones (amounts in the API are Le; stored as
// cents). Only Sierra Leone accounts can use these. Which company delivers
// them is set by SL_PROVIDER; until it's connected every payment answers
// "not connected yet" and no money moves.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { toKobo, toNaira } = require('../utils/money');
const { badRequest, forbidden, unavailable } = require('../utils/errors');
const { getSettings } = require('../services/settings');
const { usdRate } = require('../services/fx');
const { billProvider } = require('../providers/bill');
const { executePurchase } = require('../services/purchase');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) =>
  next(req.user.country === 'SL' ? undefined : forbidden('These services are for Sierra Leone accounts.', 'WRONG_COUNTRY')),
);

const p = () => billProvider();
const plan = (x) => ({ code: x.code, name: x.name, amount: toNaira(x.amount), validity: x.validity || null });
const respond = (res, txn) => ok(res, { transaction: serialize.transaction(txn) }, 201);

async function findPlan(list, code) {
  const found = list.find((x) => x.code === code);
  if (!found) throw badRequest('This plan is no longer available. Please choose another.', 'PLAN_NOT_FOUND');
  return found;
}

async function findNetwork(id) {
  const net = (await p().slNetworks()).find((n) => n.id === id);
  if (!net) throw badRequest('Choose a valid network.', 'INVALID_NETWORK');
  return net;
}

// ── Airtime and data (Africell, Orange, Qcell) ─────────────

router.get('/networks', asyncHandler(async (req, res) => ok(res, await p().slNetworks())));

router.post(
  '/airtime',
  validate({ body: z.object({ network: z.string().min(2), phone: fields.slPhone, amount: fields.amount, pin: fields.pin }) }),
  asyncHandler(async (req, res) => {
    const { network, phone, pin } = req.body;
    const net = await findNetwork(network);
    const txn = await executePurchase({
      user: req.user,
      service: 'sl_airtime',
      pin,
      amount: toKobo(req.body.amount),
      recipient: phone,
      description: `${net.name} Airtime`,
      providerParams: { network },
      metadata: { network: net.name, phone },
    });
    respond(res, txn);
  }),
);

router.get(
  '/data/plans',
  validate({ query: z.object({ network: z.string().min(2) }) }),
  asyncHandler(async (req, res) => ok(res, (await p().slDataPlans(req.query.network)).map(plan))),
);

router.post(
  '/data',
  validate({ body: z.object({ network: z.string().min(2), phone: fields.slPhone, planCode: z.string().min(1), pin: fields.pin }) }),
  asyncHandler(async (req, res) => {
    const { network, phone, planCode, pin } = req.body;
    const net = await findNetwork(network);
    const chosen = await findPlan(await p().slDataPlans(network), planCode);
    const txn = await executePurchase({
      user: req.user,
      service: 'sl_data',
      pin,
      amount: chosen.amount,
      recipient: phone,
      description: `${net.name} Data · ${chosen.name}`,
      providerParams: { network, planCode },
      metadata: { network: net.name, phone, plan: chosen.name },
    });
    respond(res, txn);
  }),
);

// ── EDSA electricity (prepaid) ─────────────────────────────

const meter = z.string().trim().regex(/^\d{6,13}$/, 'Enter a valid EDSA meter number');

router.post(
  '/electricity/verify',
  validate({ body: z.object({ meterNumber: meter }) }),
  asyncHandler(async (req, res) => ok(res, await p().slVerifyMeter(req.body.meterNumber))),
);

router.post(
  '/electricity',
  validate({
    body: z.object({ meterNumber: meter, amount: fields.amount, phone: fields.slPhone.optional(), pin: fields.pin }),
  }),
  asyncHandler(async (req, res) => {
    const { meterNumber, pin } = req.body;
    // Check the meter again on the server: never pay an unverified meter.
    const customer = await p().slVerifyMeter(meterNumber);
    const txn = await executePurchase({
      user: req.user,
      service: 'sl_electricity',
      pin,
      amount: toKobo(req.body.amount),
      recipient: meterNumber,
      description: 'EDSA Prepaid',
      providerParams: { meterNumber, phone: req.body.phone || req.user.phone },
      metadata: { customerName: customer.customerName, address: customer.address || null, disco: 'EDSA' },
    });
    respond(res, txn);
  }),
);

// ── Cable TV (DStv, GOtv, StarTimes Sierra Leone) ──────────

router.get('/cable/providers', asyncHandler(async (req, res) => ok(res, await p().slCableProviders())));

router.get(
  '/cable/plans',
  validate({ query: z.object({ provider: z.string().min(2) }) }),
  asyncHandler(async (req, res) => ok(res, (await p().slCablePlans(req.query.provider)).map(plan))),
);

const smartcard = z.string().trim().regex(/^\d{6,14}$/, 'Enter a valid smartcard / IUC number');

router.post(
  '/cable/verify',
  validate({ body: z.object({ provider: z.string().min(2), smartcardNumber: smartcard }) }),
  asyncHandler(async (req, res) => {
    const c = await p().slVerifySmartcard(req.body.provider, req.body.smartcardNumber);
    ok(res, { ...c, renewalAmount: c.renewalAmount != null ? toNaira(c.renewalAmount) : null });
  }),
);

router.post(
  '/cable',
  validate({
    body: z.object({
      provider: z.string().min(2),
      smartcardNumber: smartcard,
      planCode: z.string().min(1),
      phone: fields.slPhone.optional(),
      pin: fields.pin,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { provider, smartcardNumber, planCode, pin } = req.body;
    const tv = (await p().slCableProviders()).find((x) => x.id === provider);
    if (!tv) throw badRequest('Choose a valid TV provider.', 'INVALID_PROVIDER');
    const customer = await p().slVerifySmartcard(provider, smartcardNumber);
    const chosen = await findPlan(await p().slCablePlans(provider), planCode);
    const txn = await executePurchase({
      user: req.user,
      service: 'sl_cable',
      pin,
      amount: chosen.amount,
      recipient: smartcardNumber,
      description: `${tv.name} · ${chosen.name}`,
      providerParams: { provider, planCode, phone: req.body.phone || req.user.phone },
      metadata: { provider: tv.name, plan: chosen.name, customerName: customer.customerName },
    });
    respond(res, txn);
  }),
);

// ── International airtime (VTpass) ─────────────────────────
// VTpass prices in Naira and charges your Naira VTpass wallet; the customer
// pays Leones: Naira price × (Le per ₦1) × (1 + margin).

/** Le the customer pays per ₦1 of VTpass price (margin included). */
async function lePerNaira() {
  const cfg = (await getSettings()).slInternational || {};
  let rate = Number(cfg.rateLePerNaira) || 0;
  if (!(rate > 0)) {
    const [sle, ngn] = await Promise.all([usdRate('SLE', 'sell'), usdRate('NGN', 'buy')]);
    rate = sle / ngn;
  }
  if (!(rate > 0)) throw unavailable('International airtime isn\'t available right now.', 'FX_UNAVAILABLE');
  return rate * (1 + (Number(cfg.marginPercent) || 0) / 100);
}

const toLeCents = (kobo, rate) => Math.ceil(kobo * rate - 1e-6);

router.get('/international/countries', asyncHandler(async (req, res) => ok(res, await p().intlCountries())));

router.get(
  '/international/product-types',
  validate({ query: z.object({ country: z.string().length(2) }) }),
  asyncHandler(async (req, res) => ok(res, await p().intlProductTypes(req.query.country))),
);

router.get(
  '/international/operators',
  validate({ query: z.object({ country: z.string().length(2), productType: z.string().min(1) }) }),
  asyncHandler(async (req, res) => ok(res, await p().intlOperators(req.query.country, req.query.productType))),
);

/** Plans with prices in Leones ("rate" = Le per 1 unit of the foreign currency). */
router.get(
  '/international/variations',
  validate({ query: z.object({ country: z.string().length(2), operator: z.string().min(1), productType: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const [r, conv] = await Promise.all([p().intlVariations(req.query.country, req.query.operator, req.query.productType), lePerNaira()]);
    ok(res, {
      ...r,
      rate: r.rate ? r.rate * conv : null,
      variations: r.variations.map((v) => ({
        ...v,
        rate: v.rate ? v.rate * conv : null,
        nairaAmount: v.nairaAmount !== undefined && v.nairaAmount !== null ? toNaira(toLeCents(v.nairaAmount, conv)) : null,
      })),
    });
  }),
);

router.post(
  '/international',
  validate({
    body: z.object({
      country: z.string().length(2),
      productType: z.string().min(1),
      operator: z.string().min(1),
      variationCode: z.string().min(1),
      phone: fields.anyPhone,
      amount: z.coerce.number().positive().optional(), // foreign currency, for "any amount" plans
      email: z.string().email().optional().or(z.literal('')),
      pin: fields.pin,
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const country = (await p().intlCountries()).find((c) => c.code === b.country);
    if (!country) throw badRequest('Choose a valid country.', 'INVALID_COUNTRY');
    const operator = (await p().intlOperators(b.country, b.productType)).find((o) => o.id === b.operator);
    if (!operator) throw badRequest('Choose a valid network.', 'INVALID_OPERATOR');
    const { rate, currency, variations } = await p().intlVariations(b.country, b.operator, b.productType);
    const v = variations.find((x) => x.code === b.variationCode);
    if (!v) throw badRequest('Choose a valid plan.', 'PLAN_NOT_FOUND');
    const planRate = v.rate || rate; // ₦ per 1 unit of the foreign currency
    let foreign;
    let naira; // kobo, what VTpass charges
    if (v.fixed) {
      foreign = v.amount || null;
      naira = v.nairaAmount ?? (foreign && planRate ? toKobo(foreign * planRate) : null);
    } else {
      foreign = Number(b.amount);
      if (!Number.isFinite(foreign) || foreign < (v.min || 0) || foreign > (v.max || Infinity)) {
        throw badRequest(`Enter an amount between ${currency} ${v.min} and ${currency} ${v.max}.`, 'AMOUNT_OUT_OF_RANGE');
      }
      naira = planRate ? toKobo(foreign * planRate) : null;
    }
    if (!naira || naira <= 0) throw unavailable('The price for this plan isn\'t available right now. Please try another.', 'PRICE_UNAVAILABLE');
    const conv = await lePerNaira();
    const amount = toLeCents(naira, conv);
    const local = b.phone.replace(/^\+/, '');
    const national = local.startsWith(country.dialCode.replace('+', '')) ? local.slice(country.dialCode.length - 1) : local.replace(/^0+/, '');
    const txn = await executePurchase({
      user: req.user,
      service: 'sl_international',
      pin: b.pin,
      amount,
      recipient: `${country.dialCode}${national}`,
      description: `${operator.name} · ${country.name}`,
      providerParams: {
        // VTpass is paid in Naira.
        amount: naira,
        country: b.country,
        productType: b.productType,
        operator: b.operator,
        variationCode: v.code,
        foreignAmount: foreign,
        fixed: Boolean(v.fixed),
        email: b.email || req.user.email,
        phone: local,
      },
      metadata: { country: country.name, operator: operator.name, currency, foreignAmount: foreign, rate: planRate * conv, plan: v.name, nairaCost: naira / 100, lePerNaira: conv },
    });
    respond(res, txn);
  }),
);

module.exports = router;
