// Bill payments: lists (plans, providers), checks (meter, smartcard,
// profile) and purchases. Prices for plans always come from the provider,
// never from the app.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { toKobo, toNaira } = require('../utils/money');
const { badRequest, unavailable, forbidden } = require('../utils/errors');
const { billProvider } = require('../providers/bill');
const { getSettings } = require('../services/settings');
const { executePurchase } = require('../services/purchase');
const { ratesFor } = require('../services/commission');
const { effectiveLimits } = require('../services/limits');
const { SERVICES, BILL_SERVICES } = require('../models/constants');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);

// Nigerian services: Sierra Leone accounts only get the shared status,
// rates and limits (their own services are under /api/services/sl).
const SHARED = new Set(['/status', '/rates', '/limits']);
router.use((req, res, next) =>
  next(req.user.country === 'SL' && !SHARED.has(req.path)
    ? forbidden('This service isn\'t available for your country.', 'WRONG_COUNTRY')
    : undefined),
);

const p = () => billProvider();
const plan = (x) => ({ code: x.code, name: x.name, amount: toNaira(x.amount), validity: x.validity || null });

async function findPlan(list, code, label = 'plan') {
  const found = list.find((x) => x.code === code);
  if (!found) throw badRequest(`This ${label} is no longer available. Please choose another.`, 'PLAN_NOT_FOUND');
  return found;
}

const respond = (res, txn) => ok(res, { transaction: serialize.transaction(txn) }, 201);

// ── Status, rates and limits (for the app's screens) ─────────

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    ok(res, {
      maintenance: Boolean(s.maintenance),
      maintenanceMessage: s.maintenance ? s.maintenanceMessage : null,
      services: Object.fromEntries(SERVICES.map((k) => [k, s.services[k] !== false])),
      providerConnected: p().isConfigured(),
      // Per service: whether its provider is connected (payments possible).
      connected: Object.fromEntries(BILL_SERVICES.map((k) => [k, p().isConfigured(k)])),
      requireApproval: Boolean(s.requireApproval),
    });
  }),
);

router.get(
  '/rates',
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    ok(res, Object.fromEntries(BILL_SERVICES.map((k) => [k, ratesFor(k, s).user])));
  }),
);

router.get(
  '/limits',
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    ok(
      res,
      Object.fromEntries(
        SERVICES.map((k) => [
          k,
          {
            ...serialize.limits(effectiveLimits(req.user, k, s)),
            minimum: toNaira(s.minimums[k] || 0),
          },
        ]),
      ),
    );
  }),
);

// ── Airtime ────────────────────────────────────────────────

router.get('/networks', asyncHandler(async (req, res) => ok(res, await p().networks())));

router.post(
  '/airtime',
  validate({
    body: z.object({ network: z.string().min(2), phone: fields.phone, amount: fields.amount, pin: fields.pin }),
  }),
  asyncHandler(async (req, res) => {
    const { network, phone, pin } = req.body;
    const networks = await p().networks();
    const net = networks.find((n) => n.id === network);
    if (!net) throw badRequest('Choose a valid network.', 'INVALID_NETWORK');
    const txn = await executePurchase({
      user: req.user,
      service: 'airtime',
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

// ── Data ───────────────────────────────────────────────────

router.get(
  '/data/plans',
  validate({ query: z.object({ network: z.string().min(2) }) }),
  asyncHandler(async (req, res) => ok(res, (await p().dataPlans(req.query.network)).map(plan))),
);

router.post(
  '/data',
  validate({
    body: z.object({ network: z.string().min(2), phone: fields.phone, planCode: z.string().min(1), pin: fields.pin }),
  }),
  asyncHandler(async (req, res) => {
    const { network, phone, planCode, pin } = req.body;
    const net = (await p().networks()).find((n) => n.id === network);
    if (!net) throw badRequest('Choose a valid network.', 'INVALID_NETWORK');
    const chosen = await findPlan(await p().dataPlans(network), planCode, 'data plan');
    const txn = await executePurchase({
      user: req.user,
      service: 'data',
      pin,
      amount: chosen.amount,
      recipient: phone,
      description: `${net.name} Data ${chosen.name}`,
      providerParams: { network, planCode },
      metadata: { network: net.name, phone, plan: chosen.name, validity: chosen.validity },
    });
    respond(res, txn);
  }),
);

// ── Electricity ────────────────────────────────────────────

router.get('/electricity/providers', asyncHandler(async (req, res) => ok(res, await p().discos())));

const meterType = z.enum(['prepaid', 'postpaid']);

router.post(
  '/electricity/verify',
  validate({
    body: z.object({
      provider: z.string().min(2),
      meterNumber: z.string().trim().regex(/^\d{6,13}$/, 'Enter a valid meter number'),
      meterType,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { provider, meterNumber } = req.body;
    ok(res, await p().verifyMeter(provider, meterNumber, req.body.meterType));
  }),
);

router.post(
  '/electricity',
  validate({
    body: z.object({
      provider: z.string().min(2),
      meterNumber: z.string().trim().regex(/^\d{6,13}$/, 'Enter a valid meter number'),
      meterType,
      amount: fields.amount,
      phone: fields.phone,
      pin: fields.pin,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { provider, meterNumber, phone, pin } = req.body;
    const disco = (await p().discos()).find((d) => d.id === provider);
    if (!disco) throw badRequest('Choose a valid electricity provider.', 'INVALID_PROVIDER');
    const customer = await p().verifyMeter(provider, meterNumber, req.body.meterType);
    const txn = await executePurchase({
      user: req.user,
      service: 'electricity',
      pin,
      amount: toKobo(req.body.amount),
      recipient: meterNumber,
      description: `${disco.name} ${req.body.meterType === 'prepaid' ? 'Prepaid' : 'Postpaid'}`,
      providerParams: { provider, meterType: req.body.meterType, phone },
      metadata: {
        disco: disco.name,
        meterType: req.body.meterType,
        meterNumber,
        phone,
        customerName: customer.customerName,
        address: customer.address,
      },
    });
    respond(res, txn);
  }),
);

// ── Cable TV ───────────────────────────────────────────────

router.get('/cable/providers', asyncHandler(async (req, res) => ok(res, await p().cableProviders())));

router.get(
  '/cable/plans',
  validate({ query: z.object({ provider: z.string().min(2) }) }),
  asyncHandler(async (req, res) => ok(res, (await p().cablePlans(req.query.provider)).map(plan))),
);

const smartcard = z.string().trim().regex(/^\d{8,12}$/, 'Enter a valid smartcard / IUC number');

router.post(
  '/cable/verify',
  validate({ body: z.object({ provider: z.string().min(2), smartcardNumber: smartcard }) }),
  asyncHandler(async (req, res) => {
    const r = await p().verifySmartcard(req.body.provider, req.body.smartcardNumber);
    const canRenew = r.canRenew !== undefined ? r.canRenew : Boolean(r.renewalAmount);
    ok(res, {
      ...r,
      canRenew,
      maxMonths: r.maxMonths || 12,
      renewalAmount: r.renewalAmount ? toNaira(r.renewalAmount) : null,
      balance: r.balance !== undefined && r.balance !== null ? toNaira(r.balance) : null,
    });
  }),
);

router.post(
  '/cable',
  validate({
    body: z.object({
      provider: z.string().min(2),
      smartcardNumber: smartcard,
      action: z.enum(['renew', 'change']),
      planCode: z.string().optional(),
      months: z.coerce.number().int().min(1).max(12).default(1),
      phone: fields.phone,
      pin: fields.pin,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { provider, smartcardNumber, action, months, phone, pin } = req.body;
    const providers = await p().cableProviders();
    const prov = providers.find((x) => x.id === provider);
    if (!prov) throw badRequest('Choose a valid TV provider.', 'INVALID_PROVIDER');
    const customer = await p().verifySmartcard(provider, smartcardNumber);
    const maxMonths = customer.maxMonths || 12;
    if (months > maxMonths) {
      throw badRequest(
        maxMonths === 1 ? `${prov.name} can only be paid one period at a time.` : `You can pay up to ${maxMonths} months at once.`,
        'TOO_MANY_MONTHS',
      );
    }
    let chosen;
    if (action === 'renew') {
      const canRenew = customer.canRenew !== undefined ? customer.canRenew : Boolean(customer.renewalAmount);
      if (!canRenew || !customer.renewalAmount) {
        throw badRequest('Renewal isn\'t available for this decoder. Please choose a package.', 'RENEW_NOT_AVAILABLE');
      }
      chosen = {
        code: customer.currentPlanCode || 'renew',
        name: customer.currentPlan || 'Current package',
        amount: customer.renewalAmount,
      };
    } else {
      if (!req.body.planCode) throw badRequest('Choose a package.', 'PLAN_REQUIRED');
      chosen = await findPlan(await p().cablePlans(provider), req.body.planCode, 'package');
    }
    const txn = await executePurchase({
      user: req.user,
      service: 'cable',
      pin,
      amount: chosen.amount * months,
      recipient: smartcardNumber,
      description: `${prov.name} ${chosen.name}`,
      providerParams: { provider, action, planCode: chosen.code, months, phone },
      metadata: { provider: prov.name, plan: chosen.name, months, phone, customerName: customer.customerName },
    });
    respond(res, txn);
  }),
);

// ── Education ──────────────────────────────────────────────

router.get(
  '/education/products',
  asyncHandler(async (req, res) => {
    const products = await p().educationProducts();
    ok(res, products.map((x) => ({ ...x, variations: x.variations.map(plan) })));
  }),
);

router.post(
  '/education/verify',
  validate({
    body: z.object({
      service: z.string().min(2),
      profileId: z.string().trim().regex(/^\d{6,15}$/, 'Enter a valid Profile ID'),
      variationCode: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    ok(res, await p().verifyEducationProfile(req.body.service, req.body.profileId, req.body.variationCode));
  }),
);

router.post(
  '/education',
  validate({
    body: z.object({
      service: z.string().min(2),
      variationCode: z.string().min(1),
      quantity: z.coerce.number().int().min(1).max(10).default(1),
      phone: fields.phone,
      profileId: z.string().trim().optional(),
      pin: fields.pin,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { service, variationCode, phone, profileId, pin } = req.body;
    const product = (await p().educationProducts()).find((x) => x.id === service);
    if (!product) throw badRequest('Choose a valid service.', 'INVALID_SERVICE');
    const quantity = product.allowQuantity ? req.body.quantity : 1;
    const variation = await findPlan(product.variations, variationCode);
    let customerName = null;
    if (product.requiresProfile) {
      if (!profileId) throw badRequest('Enter your Profile ID.', 'PROFILE_REQUIRED');
      ({ customerName } = await p().verifyEducationProfile(service, profileId, variationCode));
    }
    const txn = await executePurchase({
      user: req.user,
      service: 'education',
      pin,
      amount: variation.amount * quantity,
      recipient: profileId || phone,
      description: quantity > 1 ? `${variation.name} × ${quantity}` : variation.name,
      providerParams: { serviceId: service, variationCode, quantity, phone, profileId },
      metadata: { product: product.name, variation: variation.name, quantity, phone, profileId: profileId || null, customerName },
    });
    respond(res, txn);
  }),
);

// ── Insurance ──────────────────────────────────────────────

router.get(
  '/insurance/options',
  asyncHandler(async (req, res) => {
    const o = await p().insuranceOptions();
    ok(res, { ...o, types: o.types.map(plan) });
  }),
);

router.get(
  '/insurance/models',
  validate({ query: z.object({ make: z.string().min(1) }) }),
  asyncHandler(async (req, res) => ok(res, await p().insuranceModels(req.query.make))),
);

router.get(
  '/insurance/lgas',
  validate({ query: z.object({ state: z.string().min(1) }) }),
  asyncHandler(async (req, res) => ok(res, await p().insuranceLgas(req.query.state))),
);

router.post(
  '/insurance',
  validate({
    body: z.object({
      typeCode: z.string().min(1),
      plateNumber: z.string().trim().min(5, 'Enter the plate number').max(12).transform((v) => v.toUpperCase()),
      chassisNumber: z.string().trim().max(30).optional(),
      yearOfMake: z.string().trim().regex(/^(19|20)\d{2}$/, 'Enter a valid year').optional(),
      make: z.string().optional(),
      model: z.string().optional(),
      color: z.string().optional(),
      engineCapacity: z.string().optional(),
      state: z.string().optional(),
      lga: z.string().optional(),
      insuredName: fields.name,
      email: fields.email,
      phone: fields.phone,
      pin: fields.pin,
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const o = await p().insuranceOptions();
    const type = await findPlan(o.types, b.typeCode, 'insurance type');
    const { pin, ...details } = b;
    const txn = await executePurchase({
      user: req.user,
      service: 'insurance',
      pin,
      amount: type.amount,
      recipient: b.plateNumber,
      description: `${type.name} — Third Party Motor`,
      providerParams: details,
      metadata: { cover: `${type.name} third party`, ...details },
    });
    respond(res, txn);
  }),
);

// ── International airtime ──────────────────────────────────

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

router.get(
  '/international/variations',
  validate({
    query: z.object({ country: z.string().length(2), operator: z.string().min(1), productType: z.string().min(1) }),
  }),
  asyncHandler(async (req, res) => {
    const r = await p().intlVariations(req.query.country, req.query.operator, req.query.productType);
    ok(res, {
      ...r,
      variations: r.variations.map((v) => ({
        ...v,
        rate: v.rate ?? null,
        // Naira price for fixed plans when the provider gives one
        nairaAmount: v.nairaAmount !== undefined && v.nairaAmount !== null ? toNaira(v.nairaAmount) : null,
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
    const countries = await p().intlCountries();
    const country = countries.find((c) => c.code === b.country);
    if (!country) throw badRequest('Choose a valid country.', 'INVALID_COUNTRY');
    const operator = (await p().intlOperators(b.country, b.productType)).find((o) => o.id === b.operator);
    if (!operator) throw badRequest('Choose a valid network.', 'INVALID_OPERATOR');
    const { rate, currency, variations } = await p().intlVariations(b.country, b.operator, b.productType);
    const v = variations.find((x) => x.code === b.variationCode);
    if (!v) throw badRequest('Choose a valid plan.', 'PLAN_NOT_FOUND');
    // Each plan may carry its own rate (VTpass); otherwise the operator rate.
    const planRate = v.rate || rate;
    let foreign;
    let amount;
    if (v.fixed) {
      foreign = v.amount || null;
      amount = v.nairaAmount ?? (foreign && planRate ? toKobo(foreign * planRate) : null);
    } else {
      foreign = Number(b.amount);
      if (!Number.isFinite(foreign) || foreign < (v.min || 0) || foreign > (v.max || Infinity)) {
        throw badRequest(`Enter an amount between ${currency} ${v.min} and ${currency} ${v.max}.`, 'AMOUNT_OUT_OF_RANGE');
      }
      amount = planRate ? toKobo(foreign * planRate) : null;
    }
    if (!amount || amount <= 0) {
      throw unavailable('The price for this plan isn\'t available right now. Please try another.', 'PRICE_UNAVAILABLE');
    }
    const local = b.phone.replace(/^\+/, '');
    // "0241234567" in Ghana is dialled internationally as +233 241234567
    const national = local.startsWith(country.dialCode.replace('+', '')) ? local.slice(country.dialCode.length - 1) : local.replace(/^0+/, '');
    const txn = await executePurchase({
      user: req.user,
      service: 'international',
      pin: b.pin,
      amount,
      recipient: `${country.dialCode}${national}`,
      description: `${operator.name} · ${country.name}`,
      providerParams: {
        country: b.country,
        productType: b.productType,
        operator: b.operator,
        variationCode: v.code,
        foreignAmount: foreign,
        fixed: Boolean(v.fixed),
        email: b.email || req.user.email,
        phone: local,
      },
      metadata: { country: country.name, operator: operator.name, currency, foreignAmount: foreign, rate: planRate, plan: v.name },
    });
    respond(res, txn);
  }),
);

module.exports = router;
