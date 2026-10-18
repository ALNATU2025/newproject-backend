// Money coming into a wallet: bank transfers, assisted funding, admin credits.
const { Transaction, User } = require('../models');
const { makeReference } = require('../utils/helpers');
const { percentOf } = require('../utils/money');
const wallet = require('./wallet');
const { notify } = require('./notify');
const { raiseAlert } = require('./alerts');
const referral = require('./referral');
const { getSettings } = require('./settings');
const { fmt } = require('./limits');

/**
 * Credits a deposit once. If `pendingTxn` is given it's completed;
 * otherwise a new funding transaction is created. Idempotent on
 * `providerReference`. `chargeFee` applies the funding fee %.
 */
async function creditDeposit({
  userId,
  amount,
  method,
  providerReference = null,
  pendingTxn = null,
  chargeFee = true,
  actor = null,
  note = null,
  description,
}) {
  if (providerReference) {
    const existing = await Transaction.findOne({ providerReference, type: 'wallet_funding', status: 'success' });
    if (existing) return { transaction: existing, duplicate: true };
  }
  const settings = await getSettings();
  const fee = chargeFee ? percentOf(amount, settings.fundingFeePercent) : 0;
  const net = amount - fee;

  let txn = null;
  if (pendingTxn) {
    // Complete a pending request only once, even if two admins click.
    const claimed = await Transaction.updateOne(
      { _id: pendingTxn._id, status: 'pending' },
      { $set: { status: 'success' } },
    );
    if (claimed.modifiedCount !== 1) {
      return { transaction: await Transaction.findById(pendingTxn._id), duplicate: true };
    }
    txn = await Transaction.findById(pendingTxn._id);
  }

  const { before, after } = await wallet.credit(userId, net);

  if (txn) {
    txn.status = 'success';
    txn.amount = amount;
    txn.fee = fee;
    txn.balanceBefore = before;
    txn.balanceAfter = after;
    if (providerReference) txn.providerReference = providerReference;
    if (actor) txn.actor = actor;
    if (note) txn.adminNote = note;
    await txn.save();
  } else {
    txn = await Transaction.create({
      user: userId,
      reference: makeReference('WF'),
      type: 'wallet_funding',
      direction: 'credit',
      amount,
      fee,
      status: 'success',
      description: description || 'Wallet top-up',
      providerReference,
      balanceBefore: before,
      balanceAfter: after,
      actor,
      adminNote: note,
      metadata: { method },
    });
  }

  const user = await User.findById(userId).select('fullName');
  await notify(userId, {
    title: 'Wallet funded',
    body: `${fmt(net)} has been added to your wallet.`,
    kind: 'wallet',
    data: { transactionId: String(txn._id) },
  });
  await raiseAlert({
    type: 'wallet',
    title: 'Wallet funding successful',
    body: `${user ? user.fullName : 'A user'} funded ${fmt(amount)} (${method}).`,
    user: userId,
    transaction: txn._id,
  });
  await referral.onDeposit(userId, amount);
  return { transaction: txn, duplicate: false };
}

module.exports = { creditDeposit };
