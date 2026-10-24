// Picks the bill provider for each service.
//
//   BILL_PROVIDER    none | simulator | vtpass   — default for every service
//   VTPASS_SERVICES  e.g. "cable"                 — these go to VTpass instead
//   SL_PROVIDER      none | simulator | <name>    — Sierra Leone services
//                    (sl_airtime, sl_data, sl_electricity, sl_cable)
//
// So BILL_PROVIDER=simulator + VTPASS_SERVICES=cable sends DStv/GOtv/
// StarTimes to VTpass and keeps the rest on the simulator. A service routed
// to VTpass never falls back to another provider: if the VTpass keys are
// missing it says "not connected" instead of pretending.
//
// Every provider exposes the same functions (see none.js). Amounts are kobo.
const env = require('../../config/env');
const { unavailable } = require('../../utils/errors');
const { BILL_SERVICES, SL_SERVICES } = require('../../models/constants');

const makers = {
  none: () => require('./none'),
  simulator: () => require('./simulator'),
  vtpass: () => {
    const { createVtpass } = require('./vtpass');
    return createVtpass(env.vtpass);
  },
};

/** Which service each lookup belongs to. */
const METHOD_SERVICE = {
  networks: 'airtime',
  dataPlans: 'data',
  cableProviders: 'cable',
  cablePlans: 'cable',
  verifySmartcard: 'cable',
  discos: 'electricity',
  verifyMeter: 'electricity',
  educationProducts: 'education',
  verifyEducationProfile: 'education',
  insuranceOptions: 'insurance',
  insuranceModels: 'insurance',
  insuranceLgas: 'insurance',
  intlCountries: 'international',
  intlProductTypes: 'international',
  intlOperators: 'international',
  intlVariations: 'international',
  // Sierra Leone
  slNetworks: 'sl_airtime',
  slDataPlans: 'sl_data',
  slVerifyMeter: 'sl_electricity',
  slCableProviders: 'sl_cable',
  slCablePlans: 'sl_cable',
  slVerifySmartcard: 'sl_cable',
};

/**
 * @param {object} o
 * @param {object} o.base         provider for services not listed in routes
 * @param {object} [o.routes]     { cable: providerObject, ... }
 */
// Sierra Leone international airtime uses the same provider (VTpass) as
// Nigeria's: the provider sees it as "international".
const ALIASES = { sl_international: 'international' };

function createRouter({ base, routes = {} }) {
  const forService = (service) => routes[service] || (ALIASES[service] ? routes[ALIASES[service]] || base : base);
  const all = [...new Set([base, ...Object.values(routes)])];
  // The provider an admin most cares about for balance/health: the routed
  // (real) one when there is one.
  // VTpass when it's used for anything (the Sierra Leone services are
  // routed first and must not hide its balance), else the first routed one.
  const primary =
    all.find((p) => p.name === 'vtpass') ||
    Object.entries(routes).find(([s]) => !SL_SERVICES.includes(s))?.[1] ||
    base;

  const router = {
    get name() {
      return all.length === 1 ? base.name : all.map((p) => p.name).join('+');
    },
    get environment() {
      if (all.length === 1) return base.environment;
      return all.map((p) => `${p.name}: ${p.environment}`).join(' · ');
    },
    /** With a service: whether that service can be paid. Without: any. */
    isConfigured: (service) =>
      service ? forService(service).isConfigured() : all.some((p) => p.isConfigured()),
    nameFor: (service) => forService(service).name,
    /** { airtime: 'simulator', cable: 'vtpass', ... } for the admin screen. */
    serviceMap: () =>
      Object.fromEntries(
        BILL_SERVICES.map((s) => [
          s,
          { provider: forService(s).name, environment: forService(s).environment, configured: forService(s).isConfigured() },
        ]),
      ),
    purchase: (args = {}) => {
      if (!args.service) throw unavailable('Unknown service.', 'PROVIDER_NOT_CONFIGURED');
      return forService(args.service).purchase({ ...args, service: ALIASES[args.service] || args.service });
    },
    /** Asks the provider that handled the payment (by its stored name). */
    requery: (reference, { service, provider } = {}) => {
      const byName = all.find((p) => p.name === provider);
      return (byName || forService(service)).requery(reference, { service: ALIASES[service] || service });
    },
    balance: () => primary.balance(),
    health: () => primary.health(),
    testCredentials: () => primary.testCredentials(),
  };
  for (const [method, service] of Object.entries(METHOD_SERVICE)) {
    router[method] = (...args) => forService(service)[method](...args);
  }
  return router;
}

function fromEnv() {
  const make = (name) => {
    const m = makers[name];
    if (!m) throw new Error(`Unknown bill provider "${name}"`);
    return m();
  };
  const base = make(env.billProvider);
  const routes = {};
  // Sierra Leone services never fall back to the Nigerian provider.
  const sl = env.slProvider === env.billProvider ? base : make(env.slProvider);
  for (const s of SL_SERVICES) routes[s] = sl;
  if (env.vtpass.services.length) {
    const vt = env.billProvider === 'vtpass' ? base : make('vtpass');
    for (const s of env.vtpass.services) {
      if (!BILL_SERVICES.includes(s)) throw new Error(`VTPASS_SERVICES: unknown service "${s}"`);
      if (s === 'international') routes.sl_international = vt;
      routes[s] = vt;
    }
  }
  return createRouter({ base, routes });
}

let current = null;

function billProvider() {
  if (!current) current = fromEnv();
  return current;
}

/** For tests: swap the provider (a router or a single provider). */
function setBillProvider(p) {
  current = p;
}

module.exports = { billProvider, setBillProvider, createRouter };
