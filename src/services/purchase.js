// One flow for every bill payment:
//   checks → PIN → duplicate guard → debit wallet → call provider →
//   success (commission, notify) | pending | failed (automatic refund).
const { Transaction } = require('../models');
const { SERVICE_LABELS } = require('../models/constants');
const { AppError, conflict, unavailable } = require('../utils/errors');
const { makeRequestId } = require('../utils/helpers');
const { billProvider } = require('../providers/bill');
const wallet = require('./wallet');
const { verifyPin } = require('./pin');
const { notify } = require('./notify');
const { raiseAlert } = require('./alerts');
const { getSettings } = require('./settings');
const { assertServiceOpen, assertCanTransact, assertWithinLimits, fmt } = require('./limits');
const { payPurchaseCommission } = require('./commission');
const { refundTransaction } = require('./ledger');

const DUPLICATE_WINDOW_MS = 60 * 1000;

/** Checks that run before any money moves (also used by "review" screens). */
async function preflight(user, service, amount) {
  const settings = await getSettings();
  assertServiceOpen(service, settings);
  assertCanTransact(user, settings);
  const bp = billProvider();
  if (!bp.isConfigured(service)) {
    throw unavailable(
      `${SERVICE_LABELS[service] || 'This service'} is not connected yet. Please try again later.`,
      'PROVIDER_NOT_CONFIGURED',
    );
  }
  await assertWithinLimits(user, service, amount, settings);
  return settings;
}

/**
 * @param {object} p
 * @param {object} p.user        Mongoose user
 * @param {string} p.service     airtime | data | electricity | cable | education | insurance | international
 * @param {string} p.pin
 * @param {number} p.amount      kobo, worked out by the route (never trusted from the app for plans)
 * @param {string} p.recipient   phone / meter / smartcard / profile / plate
 * @param {string} p.description shown in history and receipts
 * @param {object} p.providerParams passed to provider.purchase()
 * @param {object} p.metadata    saved on the transaction (plan, network, customer…)
 */
async function executePurchase({ user, service, pin, amount, recipient, description, providerParams = {}, metadata = {} }) {
  const settings = await preflight(user, service, amount);
  await verifyPin(user._id, pin);

  const recent = await Transaction.exists({
    user: user._id,
    service,
    recipient,
    amount,
    status: { $in: ['pending', 'success'] },
    createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
  });
  if (recent) {
    await raiseAlert({
      type: 'duplicate',
      severity: 'warning',
      title: 'Duplicate attempt blocked',
      body: `${user.fullName} repeated a ${SERVICE_LABELS[service]} payment of ${fmt(amount)} to ${recipient} within a minute.`,
      user: user._id,
    });
    throw conflict(
      'It looks like you just made this exact payment. Please wait a minute before repeating it.',
      'DUPLICATE_TRANSACTION',
    );
  }

  // Also the provider's request_id (VTpass needs a date-prefixed format).
  const reference = makeRequestId();
  const { before, after } = await wallet.debit(user._id, amount);

  let txn;
  try {
    txn = await Transaction.create({
      user: user._id,
      reference,
      type: service,
      direction: 'debit',
      amount,
      status: 'pending',
      service,
      recipient,
      description,
      provider: billProvider().nameFor ? billProvider().nameFor(service) : billProvider().name,
      balanceBefore: before,
      balanceAfter: after,
      metadata,
    });
  } catch (e) {
    await wallet.credit(user._id, amount); // put the money back
    throw e;
  }

  let result;
  try {
    result = await billProvider().purchase({ service, requestId: reference, recipient, amount, ...providerParams });
  } catch (e) {
    if (e instanceof AppError && e.status < 500) {
      // The provider rejected the request outright: refund.
      txn.metadata = { ...txn.metadata, failureReason: e.message };
      await txn.save();
      await refundTransaction(txn, { reason: e.message, status: 'failed' });
      throw e;
    }
    // Unknown outcome (timeout, network): keep it pending so it can be
    // checked with the provider instead of risking a double payment.
    await raiseAlert({
      type: 'provider',
      severity: 'warning',
      title: 'Provider did not respond',
      body: `${reference} (${SERVICE_LABELS[service]}, ${fmt(amount)}) is pending: ${e.message}`,
      user: user._id,
      transaction: txn._id,
    });
    result = { status: 'pending', message: 'Waiting for the provider to confirm.' };
  }

  txn.providerReference = result.providerReference || txn.providerReference;
  txn.metadata = { ...txn.metadata, ...(result.data || {}), providerMessage: result.message || null };

  if (result.status === 'success') {
    txn.status = 'success';
    await txn.save();
    await payPurchaseCommission(txn, settings);
    await notify(user._id, {
      title: 'Payment successful',
      body: `${description} · ${fmt(amount)} was successful.`,
      kind: 'payment',
      data: { transactionId: String(txn._id) },
    });
  } else if (result.status === 'pending') {
    txn.status = 'pending';
    await txn.save();
    await notify(user._id, {
      title: 'Payment pending',
      body: `We're confirming your ${description} payment of ${fmt(amount)} with the provider.`,
      kind: 'payment',
      data: { transactionId: String(txn._id) },
    });
  } else {
    txn.metadata = { ...txn.metadata, failureReason: result.message || 'Declined by provider' };
    await txn.save();
    await refundTransaction(txn, { reason: result.message, status: 'failed' });
    txn = await Transaction.findById(txn._id);
    await notify(user._id, {
      title: 'Payment failed',
      body: `${description} · ${fmt(amount)} failed. Your wallet has been refunded.`,
      kind: 'payment',
      data: { transactionId: String(txn._id) },
    });
  }
  return Transaction.findById(txn._id);
}

module.exports = { executePurchase, preflight };
