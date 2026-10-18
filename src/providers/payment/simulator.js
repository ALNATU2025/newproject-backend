// Development-only payment provider: issues account numbers that look real.
// Money "arrives" when you call POST /api/dev/simulate-transfer (non-production)
// or POST /api/webhooks/payment with the WEBHOOK_SECRET header.
const crypto = require('crypto');
const env = require('../../config/env');
const { unauthorized, badRequest } = require('../../utils/errors');
const { toKobo } = require('../../utils/money');

const accountNumber = () => `90${crypto.randomInt(10_000_000, 99_999_999)}`;

module.exports = {
  name: 'simulator',
  isConfigured: () => true,

  async createDedicatedAccount(user) {
    return {
      accountNumber: accountNumber(),
      accountName: `Dalabapay - ${user.fullName}`,
      bankName: 'Wema Bank (simulated)',
      providerRef: `SIMDA${Date.now()}`,
    };
  },

  async createOneTimeAccount({ user, reference, amount }) {
    return {
      accountNumber: accountNumber(),
      accountName: `DALABAPAY / ${user.fullName.toUpperCase()}`,
      bankName: 'Paystack-Titan (simulated)',
      amountToPay: amount,
      reference,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  },

  async verifyTransfer() {
    // The simulator never knows about real transfers.
    return { status: 'pending' };
  },

  /**
   * Accepts JSON: { reference?, accountNumber?, amount (₦), providerReference? }
   * with header x-webhook-secret = WEBHOOK_SECRET.
   */
  parseWebhook(req) {
    if (!env.webhookSecret || req.headers['x-webhook-secret'] !== env.webhookSecret) {
      throw unauthorized('Invalid webhook signature.', 'BAD_SIGNATURE');
    }
    const { reference, accountNumber: acct, amount, providerReference } = req.body || {};
    const kobo = toKobo(amount);
    if (!Number.isFinite(kobo) || kobo <= 0) throw badRequest('amount is required');
    return {
      event: 'transfer.received',
      reference: reference || null,
      accountNumber: acct || null,
      amount: kobo,
      providerReference: providerReference || `SIMTRF${Date.now()}`,
    };
  },
};
