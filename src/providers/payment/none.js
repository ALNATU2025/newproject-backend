// Used when no payment provider (dedicated / one-time accounts) is set up.
const { unavailable } = require('../../utils/errors');

const fail = () => {
  throw unavailable(
    'Wallet funding by bank transfer is not connected yet. Please use assisted funding.',
    'PROVIDER_NOT_CONFIGURED',
  );
};

module.exports = {
  name: 'none',
  isConfigured: () => false,
  createDedicatedAccount: fail,
  createOneTimeAccount: fail,
  verifyTransfer: async () => ({ status: 'unknown' }),
  parseWebhook: fail,
};
