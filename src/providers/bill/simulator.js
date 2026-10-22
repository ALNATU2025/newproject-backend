// Development-only bill provider. Returns a realistic catalogue and simulates
// purchases so the whole app can be tested end to end without real money.
// Never enabled in production unless BILL_PROVIDER=simulator is set on purpose.
//
// Test numbers:
//   recipient ending in 0000 → provider fails (wallet is refunded)
//   recipient ending in 9999 → stays pending
//   meter / smartcard / profile ending in 000 → "not found" on verify
const crypto = require('crypto');
const { badRequest } = require('../../utils/errors');

const N = 100; // kobo per naira

const NETWORKS = [
  { id: 'mtn', name: 'MTN' },
  { id: 'airtel', name: 'Airtel' },
  { id: 'glo', name: 'Glo' },
  { id: '9mobile', name: '9mobile' },
];

const DATA_PLANS = [
  ['500mb-1d', '500MB', 350, '1 day'],
  ['1gb-1d', '1GB', 500, '1 day'],
  ['1gb-7d', '1GB', 800, '7 days'],
  ['2gb-30d', '2GB', 1500, '30 days'],
  ['5gb-30d', '5GB', 2500, '30 days'],
  ['10gb-30d', '10GB', 3000, '30 days'],
  ['20gb-30d', '20GB', 5500, '30 days'],
  ['40gb-30d', '40GB', 11000, '30 days'],
];

const CABLE = {
  dstv: { name: 'DSTV', plans: [['padi', 'Padi', 3600], ['yanga', 'Yanga', 5100], ['confam', 'Confam', 9300], ['compact', 'Compact', 15700], ['compact-plus', 'Compact Plus', 25000], ['premium', 'Premium', 37000]] },
  gotv: { name: 'GOtv', plans: [['smallie', 'Smallie', 1575], ['jinja', 'Jinja', 3300], ['jolli', 'Jolli', 4850], ['max', 'Max', 7200], ['supa', 'Supa', 9600]] },
  startimes: { name: 'StarTimes', plans: [['nova', 'Nova', 1700], ['basic', 'Basic', 3300], ['smart', 'Smart', 4200], ['classic', 'Classic', 5000]] },
  showmax: { name: 'Showmax', plans: [['mobile', 'Mobile', 1450], ['pro-mobile', 'Pro Mobile', 3200]] },
};

const DISCOS = [
  ['ikeja-electric', 'Ikeja Electric', 'IKEDC'],
  ['eko-electric', 'Eko Electric', 'EKEDC'],
  ['abuja-electric', 'Abuja Electric', 'AEDC'],
  ['ibadan-electric', 'Ibadan Electric', 'IBEDC'],
  ['enugu-electric', 'Enugu Electric', 'EEDC'],
  ['portharcourt-electric', 'Port Harcourt Electric', 'PHED'],
  ['kano-electric', 'Kano Electric', 'KEDCO'],
  ['jos-electric', 'Jos Electric', 'JED'],
  ['kaduna-electric', 'Kaduna Electric', 'KAEDCO'],
  ['benin-electric', 'Benin Electric', 'BEDC'],
];

const EDUCATION = [
  { id: 'waec', name: 'WAEC Result Checker', requiresProfile: false, allowQuantity: true, variations: [['waecdirect', 'WAEC Result Checker PIN', 3900]] },
  { id: 'waec-registration', name: 'WAEC Registration', requiresProfile: false, allowQuantity: false, variations: [['waec-registration', 'WAEC Registration PIN', 18500]] },
  { id: 'jamb', name: 'JAMB', requiresProfile: true, allowQuantity: false, variations: [['utme', 'JAMB UTME PIN', 6200], ['de', 'JAMB Direct Entry PIN', 6200]] },
];

const INSURANCE_TYPES = [
  ['private', 'Private', 3000],
  ['commercial', 'Commercial', 5000],
  ['tricycle', 'Tricycle', 1500],
  ['motorcycle', 'Motorcycle', 3000],
];
const MAKES = ['Toyota', 'Honda', 'Lexus', 'Hyundai', 'Kia', 'Mercedes-Benz', 'Ford', 'Volkswagen'];
const MODELS = {
  Toyota: ['Corolla', 'Camry', 'Highlander', 'RAV4', 'Sienna'],
  Honda: ['Accord', 'Civic', 'CR-V', 'Pilot'],
  Lexus: ['ES 350', 'RX 350', 'GX 460'],
  Hyundai: ['Elantra', 'Sonata', 'Tucson', 'Santa Fe'],
  Kia: ['Rio', 'Cerato', 'Sorento', 'Sportage'],
  'Mercedes-Benz': ['C300', 'E350', 'GLK 350', 'ML 350'],
  Ford: ['Focus', 'Fusion', 'Escape', 'Explorer'],
  Volkswagen: ['Golf', 'Passat', 'Jetta', 'Touareg'],
};
const COLORS = ['Black', 'White', 'Silver', 'Grey', 'Blue', 'Red', 'Green', 'Gold'];
const ENGINES = ['1.0 – 1.5L', '1.6 – 2.0L', '2.1 – 3.0L', 'Above 3.0L'];
const STATES = {
  'Abuja (FCT)': ['Abaji', 'Abuja Municipal', 'Bwari', 'Gwagwalada', 'Kuje', 'Kwali'],
  Lagos: ['Agege', 'Alimosho', 'Eti-Osa', 'Ikeja', 'Kosofe', 'Surulere'],
  Ogun: ['Abeokuta North', 'Abeokuta South', 'Ado-Odo/Ota', 'Ijebu Ode'],
  Oyo: ['Ibadan North', 'Ibadan South-West', 'Ogbomosho North', 'Oyo East'],
  Rivers: ['Obio/Akpor', 'Port Harcourt', 'Eleme', 'Ikwerre'],
  Kano: ['Fagge', 'Gwale', 'Nassarawa', 'Tarauni'],
  Enugu: ['Enugu East', 'Enugu North', 'Enugu South', 'Nsukka'],
};

const COUNTRIES = [
  { code: 'GH', name: 'Ghana', flag: '🇬🇭', dialCode: '+233', currency: 'GHS', rate: 105 },
  { code: 'KE', name: 'Kenya', flag: '🇰🇪', dialCode: '+254', currency: 'KES', rate: 12 },
  { code: 'SL', name: 'Sierra Leone', flag: '🇸🇱', dialCode: '+232', currency: 'SLE', rate: 70 },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', dialCode: '+44', currency: 'GBP', rate: 2000 },
  { code: 'US', name: 'United States', flag: '🇺🇸', dialCode: '+1', currency: 'USD', rate: 1550 },
  { code: 'ZA', name: 'South Africa', flag: '🇿🇦', dialCode: '+27', currency: 'ZAR', rate: 85 },
  { code: 'CM', name: 'Cameroon', flag: '🇨🇲', dialCode: '+237', currency: 'XAF', rate: 2.6 },
];
const INTL_OPERATORS = {
  GH: ['MTN Ghana', 'Vodafone Ghana', 'AirtelTigo'],
  KE: ['Safaricom', 'Airtel Kenya'],
  SL: ['Orange Sierra Leone', 'Africell Sierra Leone'],
  GB: ['EE', 'O2', 'Vodafone UK', 'Three'],
  US: ['AT&T', 'T-Mobile', 'Verizon'],
  ZA: ['Vodacom', 'MTN South Africa', 'Cell C'],
  CM: ['MTN Cameroon', 'Orange Cameroon'],
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) =>
  String(crypto.randomInt(1, 10)) + Array.from({ length: n - 1 }, () => crypto.randomInt(0, 10)).join('');

function outcomeFor(recipient) {
  const r = String(recipient || '');
  if (r.endsWith('0000')) return 'failed';
  if (r.endsWith('9999')) return 'pending';
  return 'success';
}

// ── Sierra Leone (development only; prices in Leones) ─────────
const SL_NETWORKS = [
  { id: 'africell', name: 'Africell' },
  { id: 'orange', name: 'Orange' },
  { id: 'qcell', name: 'Qcell' },
];
const SL_DATA = [
  ['d1', '500MB · 1 day', 5, '1 day'],
  ['d7', '2GB · 7 days', 25, '7 days'],
  ['d30', '10GB · 30 days', 100, '30 days'],
];
const SL_TV = [
  { id: 'dstv', name: 'DStv' },
  { id: 'gotv', name: 'GOtv' },
  { id: 'startimes', name: 'StarTimes' },
];
const SL_TV_PLANS = {
  dstv: [['dstv-access', 'DStv Access', 250], ['dstv-family', 'DStv Family', 450], ['dstv-compact', 'DStv Compact', 800]],
  gotv: [['gotv-lite', 'GOtv Lite', 60], ['gotv-plus', 'GOtv Plus', 150], ['gotv-max', 'GOtv Max', 250]],
  startimes: [['st-nova', 'Nova', 50], ['st-basic', 'Basic', 100], ['st-classic', 'Classic', 180]],
};

const simulator = {
  name: 'simulator',
  environment: 'simulator',
  isConfigured: () => true,

  async networks() {
    return NETWORKS;
  },

  async dataPlans(network) {
    if (!NETWORKS.some((n) => n.id === network)) throw badRequest('Unknown network.');
    return DATA_PLANS.map(([code, name, price, validity]) => ({
      code: `${network}-${code}`,
      name: `${name}`,
      amount: price * N,
      validity,
    }));
  },

  async cableProviders() {
    return Object.entries(CABLE).map(([id, c]) => ({ id, name: c.name }));
  },

  async cablePlans(provider) {
    const c = CABLE[provider];
    if (!c) throw badRequest('Unknown TV provider.');
    return c.plans.map(([code, name, price]) => ({
      code: `${provider}-${code}`,
      name,
      amount: price * N,
      validity: '1 month',
    }));
  },

  async verifySmartcard(provider, smartcardNumber) {
    await delay(300);
    const c = CABLE[provider];
    if (!c) throw badRequest('Unknown TV provider.');
    if (String(smartcardNumber).endsWith('000')) {
      throw badRequest('We couldn\'t find this smartcard number. Please check it.', 'NOT_FOUND');
    }
    const current = c.plans[Math.min(1, c.plans.length - 1)];
    const due = new Date(Date.now() + 12 * 86400000);
    return {
      customerName: 'ADAEZE OKAFOR',
      currentPlan: current[1],
      currentPlanCode: `${provider}-${current[0]}`,
      renewalAmount: current[2] * N,
      dueDate: due.toISOString().slice(0, 10),
    };
  },

  async discos() {
    return DISCOS.map(([id, name, shortName]) => ({ id, name, shortName }));
  },

  async verifyMeter(disco, meterNumber) {
    await delay(300);
    if (!DISCOS.some(([id]) => id === disco)) throw badRequest('Unknown electricity provider.');
    if (String(meterNumber).endsWith('000')) {
      throw badRequest('We couldn\'t find this meter number. Please check it.', 'NOT_FOUND');
    }
    return { customerName: 'ADAEZE OKAFOR', address: '12 Admiralty Way, Lekki, Lagos' };
  },

  async educationProducts() {
    return EDUCATION.map((e) => ({
      id: e.id,
      name: e.name,
      requiresProfile: e.requiresProfile,
      allowQuantity: e.allowQuantity,
      variations: e.variations.map(([code, name, price]) => ({ code, name, amount: price * N })),
    }));
  },

  async verifyEducationProfile(serviceId, profileId) {
    await delay(300);
    if (serviceId !== 'jamb') throw badRequest('This service doesn\'t need a profile ID.');
    if (String(profileId).endsWith('000')) {
      throw badRequest('Invalid Profile ID. Please check and try again.', 'NOT_FOUND');
    }
    return { customerName: 'ADAEZE CHIOMA OKAFOR' };
  },

  async insuranceOptions() {
    return {
      types: INSURANCE_TYPES.map(([code, name, price]) => ({ code, name, amount: price * N })),
      makes: MAKES.map((m) => ({ id: slug(m), name: m })),
      colors: COLORS,
      engineCapacities: ENGINES,
      states: Object.keys(STATES),
    };
  },

  async insuranceModels(makeId) {
    const make = MAKES.find((m) => slug(m) === makeId);
    return (MODELS[make] || []).map((m) => ({ id: slug(m), name: m }));
  },

  async insuranceLgas(state) {
    return STATES[state] || [];
  },

  async intlCountries() {
    return COUNTRIES.map(({ rate, ...c }) => c); // eslint-disable-line no-unused-vars
  },

  async intlProductTypes(country) {
    if (!COUNTRIES.some((c) => c.code === country)) throw badRequest('Unknown country.');
    return [
      { id: 'topup', name: 'Mobile Top Up' },
      { id: 'data', name: 'Mobile Data' },
    ];
  },

  async intlOperators(country) {
    const ops = INTL_OPERATORS[country];
    if (!ops) throw badRequest('Unknown country.');
    return ops.map((name) => ({ id: slug(name), name }));
  },

  async intlVariations(country, operatorId, productType) {
    const c = COUNTRIES.find((x) => x.code === country);
    if (!c) throw badRequest('Unknown country.');
    const variations =
      productType === 'data'
        ? [
            { code: `${operatorId}-data-small`, name: 'Small bundle', fixed: true, amount: 5 },
            { code: `${operatorId}-data-medium`, name: 'Medium bundle', fixed: true, amount: 10 },
            { code: `${operatorId}-data-large`, name: 'Large bundle', fixed: true, amount: 25 },
          ]
        : [{ code: `${operatorId}-topup`, name: 'Any amount', fixed: false, min: 1, max: 500 }];
    return { currency: c.currency, rate: c.rate, variations };
  },

  async slNetworks() {
    return SL_NETWORKS;
  },

  async slDataPlans(network) {
    if (!SL_NETWORKS.some((n) => n.id === network)) throw badRequest('Unknown network.');
    return SL_DATA.map(([code, name, price, validity]) => ({ code: `${network}-${code}`, name, amount: price * N, validity }));
  },

  async slVerifyMeter(meterNumber) {
    await delay(300);
    if (String(meterNumber).endsWith('000')) throw badRequest('We couldn\'t find this meter number. Please check it.', 'NOT_FOUND');
    return { customerName: 'Fatmata Kamara', address: '12 Wilkinson Road, Freetown', meterNumber: String(meterNumber) };
  },

  async slCableProviders() {
    return SL_TV;
  },

  async slCablePlans(provider) {
    const plans = SL_TV_PLANS[provider];
    if (!plans) throw badRequest('Choose a valid TV provider.', 'INVALID_PROVIDER');
    return plans.map(([code, name, price]) => ({ code, name, amount: price * N, validity: '1 month' }));
  },

  async slVerifySmartcard(provider, smartcardNumber) {
    await delay(300);
    if (!SL_TV_PLANS[provider]) throw badRequest('Choose a valid TV provider.', 'INVALID_PROVIDER');
    if (String(smartcardNumber).endsWith('000')) throw badRequest('We couldn\'t find this smartcard number. Please check it.', 'NOT_FOUND');
    const [code, name, price] = SL_TV_PLANS[provider][1];
    return { customerName: 'Mohamed Sesay', currentPlan: name, currentPlanCode: code, renewalAmount: price * N, dueDate: null };
  },

  async purchase({ service, requestId, recipient }) {
    await delay(400);
    const outcome = outcomeFor(recipient);
    const providerReference = `SIM${Date.now()}${rand(4)}`;
    if (outcome === 'failed') {
      return { status: 'failed', providerReference, message: 'The provider declined this request.' };
    }
    if (outcome === 'pending') {
      return { status: 'pending', providerReference, message: 'Waiting for the provider to confirm.' };
    }
    const data = {};
    if (service === 'electricity' || service === 'sl_electricity') {
      data.token = rand(20).replace(/(\d{4})(?=\d)/g, '$1-');
      data.units = '48.6 kWh';
    }
    if (service === 'education') {
      data.pins = [{ serial: `WRN${rand(9)}`, pin: rand(12).replace(/(\d{4})(?=\d)/g, '$1 ') }];
    }
    if (service === 'insurance') {
      data.certificateNumber = `TPM-${new Date().getFullYear()}-${rand(7)}`;
    }
    return { status: 'success', providerReference, message: 'Delivered', data, requestId };
  },

  async requery(requestId) {
    return { status: 'success', providerReference: `SIM-RQ-${requestId}`, message: 'Delivered' };
  },

  async balance() {
    return 186_450.75 * N;
  },

  async health() {
    return { ok: true, latencyMs: 42, message: 'Simulator is running.' };
  },

  async testCredentials() {
    return { ok: true, message: 'Simulator doesn\'t need credentials.' };
  },
};

module.exports = simulator;
