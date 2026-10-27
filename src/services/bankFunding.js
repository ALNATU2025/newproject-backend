// Nigeria "Add money" by transfer to the company account (Kuda):
//
//   1. start   — amount + PIN → a pending top-up and the account to pay
//   2. sent    — "I have sent it" → admins get a push with Confirm / Cancel
//                buttons and a webhook event with Confirm / Cancel links
//   3. confirm — an admin confirms → the exact amount is credited at once
//      cancel  — the person or an admin cancels → nothing is credited
//
// Every step only moves forward once (status is claimed atomically), so a
// double tap or two admins can never credit twice.
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { Transaction, User } = require('../models');
const { makeReference } = require('../utils/helpers');
const { badRequest, notFound, conflict } = require('../utils/errors');
const { getSettings } = require('./settings');
const { raiseAlert } = require('./alerts');
const { notify } = require('./notify');
const { creditDeposit } = require('./funding');
const { fmt } = require('./limits');

const METHOD = 'manual_bank';
const ACTION_AUDIENCE = 'funding-action';
const ACTION_TTL = '3d';
const OPEN_HOURS = 24;

function account(settings) {
  const a = settings.ngBankFunding || {};
  return { accountNumber: a.accountNumber, accountName: a.accountName, bankName: a.bankName };
}

function view(t) {
  const m = t.metadata || {};
  return {
    id: String(t._id),
    reference: t.reference,
    amount: t.amount / 100,
    currency: t.currency || 'NGN',
    status: t.status,
    // awaiting (show the account) → sent (waiting for admin) →
    // confirmed | cancelled
    stage: t.status === 'success' ? 'confirmed' : t.status === 'failed' ? 'cancelled' : m.stage || 'awaiting',
    account: m.account || null,
    sentAt: m.sentAt || null,
    createdAt: t.createdAt,
    note: t.adminNote || null,
  };
}

async function findOwn(userId, id) {
  const t = await Transaction.findOne({ _id: id, user: userId, type: 'wallet_funding', 'metadata.method': METHOD });
  if (!t) throw notFound('Top-up not found.');
  return t;
}

/** Step 1: records the top-up and returns the account to pay. */
async function start(user, amount) {
  const settings = await getSettings();
  const acct = account(settings);
  if (!settings.ngBankFunding || settings.ngBankFunding.enabled === false || !acct.accountNumber) {
    throw badRequest('Bank transfer top-up is not available right now.', 'BANK_FUNDING_OFF');
  }
  // An older top-up the person never paid is replaced by this one.
  await Transaction.updateMany(
    { user: user._id, type: 'wallet_funding', status: 'pending', 'metadata.method': METHOD, 'metadata.stage': 'awaiting' },
    { $set: { status: 'failed', 'metadata.stage': 'cancelled', adminNote: 'Replaced by a newer top-up' } },
  );
  const sentOpen = await Transaction.countDocuments({ user: user._id, type: 'wallet_funding', status: 'pending', 'metadata.method': METHOD, 'metadata.stage': 'sent' });
  if (sentOpen >= 3) {
    throw conflict('You already have 3 top-ups waiting for confirmation. Please wait for them to be confirmed.', 'TOO_MANY_PENDING');
  }
  const t = await Transaction.create({
    user: user._id,
    reference: makeReference('BT'),
    type: 'wallet_funding',
    direction: 'credit',
    amount,
    status: 'pending',
    description: `Wallet top-up · ${acct.bankName} transfer`,
    metadata: { method: METHOD, stage: 'awaiting', account: acct },
  });
  return view(t);
}

function actionToken(t, action) {
  return jwt.sign({ t: String(t._id), a: action, amt: t.amount }, env.jwtSecret, { audience: ACTION_AUDIENCE, expiresIn: ACTION_TTL });
}

/** Reads a Confirm / Cancel link. Throws on a bad or expired link. */
function readActionToken(token) {
  try {
    const p = jwt.verify(token, env.jwtSecret, { audience: ACTION_AUDIENCE });
    if (!['confirm', 'cancel'].includes(p.a)) throw new Error('bad action');
    return p;
  } catch (e) {
    throw badRequest('This link has expired or is not valid. Use the admin app instead.', 'ACTION_LINK_INVALID');
  }
}

function publicBase(req) {
  if (env.publicUrl) return env.publicUrl.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** Step 2: "I have sent it" → tell the admins (push buttons + webhook links). */
async function markSent(user, id, req) {
  const t = await findOwn(user._id, id);
  if (t.status !== 'pending') return view(t);
  const claimed = await Transaction.findOneAndUpdate(
    { _id: t._id, status: 'pending', 'metadata.stage': 'awaiting' },
    { $set: { 'metadata.stage': 'sent', 'metadata.sentAt': new Date() } },
    { new: true },
  );
  if (!claimed) return view(await Transaction.findById(t._id));

  const a = (claimed.metadata && claimed.metadata.account) || {};
  const base = publicBase(req);
  const amount = fmt(claimed.amount, 'NGN');
  await raiseAlert({
    type: 'wallet',
    severity: 'warning',
    title: `${user.fullName} has sent ${amount}`,
    body: `${user.fullName} (${user.phone || user.email}) says they sent ${amount} to ${a.bankName} ${a.accountNumber}. Check your ${a.bankName} app, then confirm or cancel. Ref ${claimed.reference}.`,
    user: user._id,
    transaction: claimed._id,
    data: { event: 'funding.sent', action: 'funding_confirm', amount: claimed.amount / 100, reference: claimed.reference, customer: user.fullName },
    actions: [
      { id: 'confirm', label: 'Confirm', url: `${base}/api/funding-actions/${actionToken(claimed, 'confirm')}` },
      { id: 'cancel', label: 'Cancel', url: `${base}/api/funding-actions/${actionToken(claimed, 'cancel')}` },
    ],
  });
  return view(claimed);
}

/** The person cancels (before or after "I have sent it"). */
async function cancelOwn(user, id) {
  const t = await findOwn(user._id, id);
  if (t.status !== 'pending') return view(t);
  const wasSent = t.metadata && t.metadata.stage === 'sent';
  const done = await Transaction.findOneAndUpdate(
    { _id: t._id, status: 'pending' },
    { $set: { status: 'failed', 'metadata.stage': 'cancelled', adminNote: 'Cancelled by customer' } },
    { new: true },
  );
  if (done && wasSent) {
    await raiseAlert({
      type: 'wallet',
      title: 'Top-up cancelled by customer',
      body: `${user.fullName} cancelled the ${fmt(t.amount, 'NGN')} top-up ${t.reference}. Don't credit it.`,
      user: user._id,
      transaction: t._id,
    });
  }
  return view(done || (await Transaction.findById(t._id)));
}

/**
 * Step 3, by an admin (app, Status Update or webhook link): [action] is
 * confirm (credits the exact amount) or cancel.
 */
async function decide(id, action, { actor = null, note = null, via = 'app' } = {}) {
  const t = await Transaction.findOne({ _id: id, type: 'wallet_funding', 'metadata.method': METHOD });
  if (!t) throw notFound('Top-up not found.');
  if (t.status !== 'pending') return { result: 'already', topUp: view(t) };
  const user = await User.findById(t.user).select('fullName');
  const by = actor ? (await User.findById(actor).select('fullName')) : null;
  const who = by ? by.fullName : via === 'link' ? 'webhook link' : 'admin';

  if (action === 'confirm') {
    const { duplicate } = await creditDeposit({
      userId: t.user,
      amount: t.amount,
      method: METHOD,
      pendingTxn: t,
      chargeFee: false,
      actor,
      note: note || `Confirmed by ${who}`,
      description: t.description,
    });
    const fresh = await Transaction.findById(t._id);
    return { result: duplicate ? 'already' : 'confirmed', topUp: view(fresh) };
  }

  const done = await Transaction.findOneAndUpdate(
    { _id: t._id, status: 'pending' },
    { $set: { status: 'failed', 'metadata.stage': 'cancelled', adminNote: note || 'Payment not received', actor } },
    { new: true },
  );
  if (!done) return { result: 'already', topUp: view(await Transaction.findById(t._id)) };
  await notify(t.user, {
    title: 'Top-up not confirmed',
    body: `We couldn't confirm your ${fmt(t.amount, 'NGN')} transfer (${t.reference}).${note ? ` ${note}` : ' If you sent it, contact support with your bank receipt.'}`,
    kind: 'wallet',
    data: { transactionId: String(t._id) },
  });
  await raiseAlert({
    type: 'status',
    title: 'Top-up cancelled',
    body: `${user ? user.fullName : 'A user'}'s ${fmt(t.amount, 'NGN')} top-up ${t.reference} was cancelled by ${who}.`,
    user: t.user,
    transaction: t._id,
  });
  return { result: 'cancelled', topUp: view(done) };
}

/** The person's latest unfinished top-up (to reopen the confirm page). */
async function openFor(userId) {
  const t = await Transaction.findOne({
    user: userId,
    type: 'wallet_funding',
    status: 'pending',
    'metadata.method': METHOD,
    createdAt: { $gte: new Date(Date.now() - OPEN_HOURS * 3600 * 1000) },
  }).sort({ createdAt: -1 });
  return t ? view(t) : null;
}

module.exports = { METHOD, start, markSent, cancelOwn, decide, openFor, findOwn, view, readActionToken, account };
