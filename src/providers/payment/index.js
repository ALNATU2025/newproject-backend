// Picks the wallet-funding provider from PAYMENT_PROVIDER.
//   createDedicatedAccount(user, kyc)        → { accountNumber, accountName, bankName, providerRef }
//   createOneTimeAccount({ user, reference, amount }) → { accountNumber, accountName, bankName, amountToPay, reference, expiresAt }
//   verifyTransfer(reference)                → { status: 'success'|'pending'|'not_found'|'unknown', amount? }
//   parseWebhook(req)                        → { event, reference?, accountNumber?, amount, providerReference }
const env = require('../../config/env');

const providers = {
  none: () => require('./none'),
  simulator: () => require('./simulator'),
};

let current = null;

function paymentProvider() {
  if (!current) {
    const make = providers[env.paymentProvider];
    if (!make) throw new Error(`Unknown PAYMENT_PROVIDER "${env.paymentProvider}"`);
    current = make();
  }
  return current;
}

function setPaymentProvider(p) {
  current = p;
}

module.exports = { paymentProvider, setPaymentProvider };
