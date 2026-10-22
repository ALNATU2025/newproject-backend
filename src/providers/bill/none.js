// Used when no bill provider is configured: every call explains that the
// service isn't connected yet instead of pretending to work.
const { unavailable } = require('../../utils/errors');

const fail = () => {
  throw unavailable(
    'Bill payments are not connected yet. Please try again later.',
    'PROVIDER_NOT_CONFIGURED',
  );
};

module.exports = {
  name: 'none',
  environment: 'none',
  isConfigured: () => false,
  networks: fail,
  dataPlans: fail,
  cableProviders: fail,
  cablePlans: fail,
  verifySmartcard: fail,
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
  slNetworks: fail,
  slDataPlans: fail,
  slVerifyMeter: fail,
  slCableProviders: fail,
  slCablePlans: fail,
  slVerifySmartcard: fail,
  purchase: fail,
  requery: fail,
  balance: async () => null,
  health: async () => ({ ok: false, latencyMs: null, message: 'No bill provider is configured.' }),
  testCredentials: async () => ({ ok: false, message: 'No bill provider is configured.' }),
};
