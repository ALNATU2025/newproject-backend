// Sierra Leone instant Add Money with Monime (Orange Money / Afrimoney).
//
// 1. start(): a pending wallet_funding transaction + a one-time Monime
//    Payment Code locked to the customer's number and network.
// 2. The customer dials the USSD code and approves with their PIN.
// 3. Monime's webhook (payment_code.completed) — or check() — confirms it
//    with Monime's API, then the wallet is credited once.
const { Transaction } = require('../models');
const monime = require('../providers/monime');
const { makeReference } = require('../utils/helpers');
const { badRequest, forbidden } = require('../utils/errors');
const { getSettings } = require('./settings');
const { assertCanTransact, fmt } = require('./limits');
const { creditDeposit } = require('./funding');
const { notify } = require('./notify');
const env = require('../config/env');

const METHOD = 'monime';

async function options() {
  const s = await getSettings();
  const f = s.slFunding || {};
  const m = s.monime || {};
  if (!monime.configured()) return { available: false, providers: [] };
  const list = (await monime.momos()).filter((x) => x.canPay !== false);
  return {
    available: list.length > 0,
    providers: list.map((x) => ({ id: x.id, name: x.name })),
    minAmount: (f.minAmount || 0) / 100,
    maxAmount: (f.maxAmount || 0) / 100,
    feePercent: m.depositFeePercent || 0,
  };
}

async function start(user, { amount, providerId, phone }) {
  if (user.country !== 'SL') throw forbidden('This is for Sierra Leone accounts.', 'WRONG_COUNTRY');
  const s = await getSettings();
  assertCanTransact(user, s);
  const f = s.slFunding || {};
  const cents = Math.round(Number(amount) * 100);
  if (!(cents > 0) || cents < f.minAmount || cents > f.maxAmount) {
    throw badRequest(`Enter an amount between ${fmt(f.minAmount, 'SLE')} and ${fmt(f.maxAmount, 'SLE')}.`, 'AMOUNT_OUT_OF_RANGE');
  }
  const providers = await monime.momos();
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) throw badRequest('Choose Orange Money or Afrimoney.', 'INVALID_METHOD');
  const number = monime.msisdn(phone || user.phone);
  if (!/^\+232\d{8}$/.test(number)) throw badRequest('Enter the Sierra Leone mobile money number you will pay from.', 'INVALID_PHONE');
  // eslint-disable-next-line global-require
  await require('./tiers').assertCanReceive(user._id, cents, s, { who: 'your' });

  const open = await Transaction.countDocuments({ user: user._id, type: 'wallet_funding', status: 'pending', provider: METHOD });
  if (open >= 3) throw badRequest('You have top-ups waiting. Finish or cancel them first.', 'TOO_MANY_PENDING');

  const reference = makeReference('MN');
  const txn = await Transaction.create({
    user: user._id,
    reference,
    type: 'wallet_funding',
    direction: 'credit',
    currency: 'SLE',
    amount: cents,
    status: 'pending',
    provider: METHOD,
    description: `Wallet top-up · ${provider.name}`,
    recipient: number,
    metadata: { method: METHOD, methodName: provider.name, providerId: provider.id, payerNumber: number },
  });
  try {
    const code = await monime.createPaymentCode({
      reference,
      amountCents: cents,
      phone: number,
      providerId: provider.id,
      name: `Dalabapay top-up ${reference.slice(-6)}`,
      customerName: user.fullName,
      metadata: { userId: String(user._id) },
    });
    txn.providerReference = code.id;
    txn.metadata = { ...txn.metadata, paymentCodeId: code.id, ussdCode: code.ussdCode || null, expireTime: code.expireTime };
    await txn.save();
    return { transaction: txn, ussdCode: code.ussdCode, expireTime: code.expireTime, provider: provider.name };
  } catch (e) {
    txn.status = 'failed';
    txn.metadata = { ...txn.metadata, failureReason: e.message };
    await txn.save();
    throw e.noAnswer ? badRequest('Mobile money is not responding right now. Please try again in a moment.', 'PROVIDER_UNAVAILABLE') : e;
  }
}

/** Settles a pending top-up from the Payment Code as Monime reports it. */
async function settle(txn, code) {
  if (!txn || txn.status !== 'pending') return { result: txn ? txn.status : 'missing' };
  const state = monime.codeState(code && code.status);
  if (state === 'success') {
    const s = await getSettings();
    const paid = monime.fromMonime(code.processedPaymentData?.amount?.value ?? code.amount?.value);
    const amount = paid && paid > 0 ? paid : txn.amount;
    const r = await creditDeposit({
      userId: txn.user,
      amount,
      method: (txn.metadata && txn.metadata.methodName) || 'Mobile money',
      providerReference: (txn.metadata && txn.metadata.paymentCodeId) || code.id || txn.providerReference,
      pendingTxn: txn,
      chargeFee: true,
      feePercent: (s.monime && s.monime.depositFeePercent) || 0,
    });
    return { result: 'success', credited: !r.duplicate };
  }
  if (state === 'failed') {
    const done = await Transaction.findOneAndUpdate(
      { _id: txn._id, status: 'pending' },
      { $set: { status: 'failed', 'metadata.failureReason': code.status === 'cancelled' ? 'Cancelled' : 'Code expired before payment' } },
      { new: true },
    );
    if (done) {
      await notify(done.user, {
        title: 'Top-up not completed',
        body: `Your ${fmt(done.amount, 'SLE')} mobile money top-up wasn't paid in time. No money was taken. You can start a new one.`,
        kind: 'wallet',
        data: { transactionId: String(done._id) },
      });
    }
    return { result: 'failed' };
  }
  return { result: 'pending' };
}

/** Customer's "check status" (also the safety net if a webhook is missed). */
async function check(user, id) {
  const txn = await Transaction.findOne({ _id: id, user: user._id, type: 'wallet_funding', provider: METHOD });
  if (!txn) throw badRequest('Top-up not found.', 'NOT_FOUND');
  if (txn.status === 'pending' && txn.providerReference) {
    try {
      await settle(txn, await monime.getPaymentCode((txn.metadata && txn.metadata.paymentCodeId) || txn.providerReference));
    } catch (e) {
      if (!env.isTest) console.warn('[monime] check failed', txn.reference, e.message);
    }
  }
  return Transaction.findById(txn._id);
}

async function cancel(user, id) {
  const txn = await Transaction.findOne({ _id: id, user: user._id, type: 'wallet_funding', provider: METHOD, status: 'pending' });
  if (!txn) throw badRequest('Nothing to cancel.', 'NOT_FOUND');
  // Paid already? Then credit instead of cancelling.
  if (txn.providerReference) {
    try {
      const code = await monime.getPaymentCode(txn.providerReference);
      if (monime.codeState(code.status) === 'success') {
        await settle(txn, code);
        return Transaction.findById(txn._id);
      }
    } catch {
      // carry on cancelling
    }
    await monime.cancelPaymentCode(txn.providerReference);
  }
  await Transaction.updateOne({ _id: txn._id, status: 'pending' }, { $set: { status: 'failed', 'metadata.failureReason': 'Cancelled by customer' } });
  return Transaction.findById(txn._id);
}

/** Pending top-ups older than their code: ask Monime once more (sweeper). */
async function sweep() {
  if (!monime.configured()) return 0;
  const old = await Transaction.find({
    type: 'wallet_funding',
    provider: METHOD,
    status: 'pending',
    createdAt: { $lt: new Date(Date.now() - 3 * 60 * 1000) },
  }).limit(50);
  for (const t of old) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await settle(t, await monime.getPaymentCode(t.providerReference));
    } catch {
      // next time
    }
  }
  return old.length;
}

/**
 * Webhook (signature already checked). The event only says which object
 * changed; its state is always read back from Monime's API.
 */
async function onEvent(body) {
  const name = String(body?.event?.name || '');
  const data = body?.data || {};
  const objectId = body?.object?.id || data.id;
  if (name.startsWith('payment_code.')) {
    const txn = await Transaction.findOne({
      type: 'wallet_funding',
      provider: METHOD,
      $or: [{ providerReference: objectId }, { reference: data.reference || data.metadata?.reference || '__none__' }],
    });
    if (!txn) return { matched: false };
    const code = await monime.getPaymentCode((txn.metadata && txn.metadata.paymentCodeId) || objectId);
    return { matched: true, reference: txn.reference, ...(await settle(txn, code)) };
  }
  if (name.startsWith('payout.')) {
    // eslint-disable-next-line global-require
    return { matched: true, ...(await require('./payouts').onMonimePayout(objectId, data)) };
  }
  return { ignored: true };
}

module.exports = { options, start, check, cancel, settle, sweep, onEvent, METHOD };
