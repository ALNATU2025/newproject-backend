// Add Money with Kuda Business: each customer gets their own pass-through
// account number (no ID check needed: the number is in Dalabapay's name and
// money goes straight to the Kuda main account). Credits arrive on
// POST /api/webhooks/kuda/<KUDA_WEBHOOK_TOKEN>.
const kuda = require('../kuda');
const { unavailable, unauthorized } = require('../../utils/errors');

module.exports = {
  name: 'kuda',
  isConfigured: () => kuda.configured(),
  // The account number is issued without BVN/NIN (it belongs to Dalabapay).
  kycFree: true,
  oneTimeAvailable: false,

  async createDedicatedAccount(user) {
    const a = await kuda.createPassThroughAccount({ accountName: user.fullName });
    return { ...a, accountName: a.accountName || user.fullName, bankName: a.bankName || 'Kuda MFB' };
  },

  async createOneTimeAccount() {
    throw unavailable('Use your Dalabapay account number to add money.', 'ONE_TIME_UNAVAILABLE');
  },

  async verifyTransfer() {
    return { status: 'pending' };
  },

  // Kuda notifications use their own route (see routes/webhooks.js).
  parseWebhook() {
    throw unauthorized('Use the Kuda webhook URL.', 'BAD_SIGNATURE');
  },
};
