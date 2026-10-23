// Virtual dollar cards through Cashwyre. Customers pay from their wallet
// (Naira or Leones) and the card holds US dollars.
//
//   create   PIN → wallet debit → Cashwyre creates the card. Cashwyre's
//            answer has no card code, so the card is linked when its
//            webhook arrives, or by looking up the customer's cards.
//   top up   PIN → wallet debit → card credited (refund if declined)
//   withdraw PIN → card debited → wallet credited once Cashwyre confirms
//            the withdrawal in the card's history
//
// Card numbers and CVVs are never stored; they're read from Cashwyre when
// the owner asks (with their PIN).
const { Card, Transaction, User } = require('../models');
const { COUNTRIES } = require('../models/constants');
const cashwyre = require('../providers/cashwyre');
const { AppError, badRequest, conflict, forbidden, notFound, unavailable } = require('../utils/errors');
const { makeReference } = require('../utils/helpers');
const { currencyOf, formatMoney } = require('../utils/money');
const wallet = require('./wallet');
const { verifyPin } = require('./pin');
const { notify } = require('./notify');
const { raiseAlert } = require('./alerts');
const { getSettings } = require('./settings');
const { assertServiceOpen, assertCanTransact, assertWithinLimits } = require('./limits');
const { refundTransaction } = require('./ledger');
const { usdRate } = require('./fx');

// Cashwyre's fees (https://business.cashwyre.com/doc/api, "Cashwyre Fees").
const FEES = { setupUsd: 2.5, setupPercentAbove200: 2.35, topupPercent: 1.5, withdrawPercent: 0, minLeftUsd: 1 };

/** ID documents Cashwyre accepts, per country. */
const ID_TYPES = {
  NG: [
    { id: 'nin', name: 'NIN', needsImage: false },
    { id: 'bvn', name: 'BVN', needsImage: true },
  ],
  SL: [
    { id: 'national_id', name: 'National ID card', needsImage: true },
    { id: 'voters_card', name: "Voter's card", needsImage: true },
  ],
};

// Sierra Leone accounts only (the routes refuse other countries).
const serviceFor = () => 'sl_card';
const cents = (usd) => Math.round(Number(usd) * 100);
const usd2 = (v) => Math.round(Number(v) * 100) / 100;

async function checks(user, charge) {
  const settings = await getSettings();
  const service = serviceFor(user);
  assertServiceOpen(service, settings);
  assertCanTransact(user, settings);
  if (!cashwyre.configured()) {
    throw unavailable('Dollar cards are not connected yet. Please try again later.', 'PROVIDER_NOT_CONFIGURED');
  }
  if (charge !== undefined) await assertWithinLimits(user, service, charge, settings);
  return settings;
}

function cardSettings(settings) {
  return { minCardUsd: 5, maxCardUsd: 2000, maxCardsPerUser: 2, cardFeePercent: 1, cardWithdrawMarginPercent: 2, ...(settings.cashwyre || {}) };
}

/** Dollars Cashwyre takes for [action] on [amountUsd]. */
function providerUsd(action, amountUsd) {
  if (action === 'create') {
    const fee = amountUsd > 200 ? (amountUsd * FEES.setupPercentAbove200) / 100 : FEES.setupUsd;
    return { feeUsd: usd2(fee), totalUsd: usd2(amountUsd + fee) };
  }
  if (action === 'topup') {
    const fee = (amountUsd * FEES.topupPercent) / 100;
    return { feeUsd: usd2(fee), totalUsd: usd2(amountUsd + fee) };
  }
  return { feeUsd: 0, totalUsd: usd2(amountUsd) };
}

/**
 * Price in the customer's currency (minor units): what they pay to create
 * or top up a card, or what they receive for a withdrawal.
 */
async function price(user, action, amountUsd, settings) {
  const s = cardSettings(settings || (await getSettings()));
  const cur = currencyOf(user.country);
  const { feeUsd, totalUsd } = providerUsd(action, amountUsd);
  if (action === 'withdraw') {
    const rate = await usdRate(cur, 'buy');
    const local = Math.floor(totalUsd * rate * 100 * (1 - s.cardWithdrawMarginPercent / 100) + 1e-6);
    return { action, amountUsd, feeUsd, totalUsd, rate, currency: cur, local };
  }
  const rate = await usdRate(cur, 'sell');
  const local = Math.ceil(totalUsd * rate * 100 * (1 + s.cardFeePercent / 100) - 1e-6);
  return { action, amountUsd, feeUsd, totalUsd, rate, currency: cur, local };
}

function publicPrice(p) {
  return { ...p, local: p.local / 100, display: formatMoney(p.local, p.currency) };
}

function config(user, settings) {
  const s = cardSettings(settings);
  return {
    connected: cashwyre.configured(),
    open: settings.services[serviceFor(user)] !== false && !settings.maintenance,
    minUsd: s.minCardUsd,
    maxUsd: s.maxCardUsd,
    maxCards: s.maxCardsPerUser,
    brands: ['Visa', 'Mastercard'],
    idTypes: ID_TYPES[user.country] || ID_TYPES.NG,
    fees: {
      setupUsd: FEES.setupUsd,
      setupPercentAbove200: FEES.setupPercentAbove200,
      topupPercent: FEES.topupPercent,
      minimumLeftOnCardUsd: FEES.minLeftUsd,
    },
  };
}

async function ownCard(user, id) {
  const card = await Card.findOne({ _id: id, user: user._id });
  if (!card) throw notFound('Card not found.');
  return card;
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  return { firstName: parts[0] || 'Customer', lastName: parts.slice(1).join(' ') || parts[0] || 'Customer' };
}

function isAdult(dob) {
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  const age = now.getUTCFullYear() - d.getUTCFullYear() - (now < new Date(Date.UTC(now.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) ? 1 : 0);
  return age >= 18 && age < 120;
}

// ── Linking a newly created card ───────────────────────────

/** Fills a 'creating' card from Cashwyre's details and completes its payment. */
async function activate(card, details) {
  const updated = await Card.findOneAndUpdate(
    { _id: card._id, status: 'creating' },
    {
      $set: {
        cardCode: details.code,
        status: details.status === 'frozen' ? 'frozen' : 'active',
        brand: details.brand ? details.brand[0].toUpperCase() + details.brand.slice(1) : card.brand,
        name: details.name || card.name,
        last4: details.last4,
        validMonthYear: details.validMonthYear,
        balanceUsd: cents(details.balanceUsd),
        lastSyncedAt: new Date(),
      },
    },
    { new: true },
  );
  if (!updated) return null;
  if (card.createTransaction) {
    const txn = await Transaction.findOneAndUpdate(
      { _id: card.createTransaction, status: 'pending' },
      { $set: { status: 'success', providerReference: details.code, 'metadata.last4': details.last4 } },
      { new: true },
    );
    if (txn) {
      await notify(card.user, {
        title: 'Your dollar card is ready',
        body: `Your ${updated.brand} card ending ${details.last4 || ''} is ready to use.`,
        kind: 'payment',
        data: { transactionId: String(txn._id), cardId: String(updated._id) },
      });
    }
  }
  return updated;
}

/** Looks for the customer's new card at Cashwyre and links it. */
async function tryLink(card) {
  const user = await User.findById(card.user).select('email');
  if (!user) return null;
  const theirs = await cashwyre.cardsByEmail(user.email);
  const known = new Set((await Card.find({ user: card.user, cardCode: { $ne: null } }).select('cardCode')).map((c) => c.cardCode));
  const fresh = theirs.find((c) => c.code && !known.has(c.code));
  if (!fresh) return null;
  return activate(card, fresh);
}

async function failCreation(card, reason) {
  const claimed = await Card.findOneAndUpdate({ _id: card._id, status: 'creating' }, { $set: { status: 'failed', failureReason: reason } }, { new: true });
  if (!claimed || !card.createTransaction) return;
  const txn = await Transaction.findById(card.createTransaction);
  if (txn && txn.status === 'pending' && !txn.refunded) {
    txn.metadata = { ...(txn.metadata || {}), failureReason: reason };
    await txn.save();
    await refundTransaction(txn, { reason, status: 'failed' });
  }
}

// ── Actions ────────────────────────────────────────────────

async function create(user, body) {
  const settings = await checks(user);
  const s = cardSettings(settings);
  const amountUsd = usd2(body.amountUsd);
  if (amountUsd < s.minCardUsd || amountUsd > s.maxCardUsd) {
    throw badRequest(`A new card must be loaded with between $${s.minCardUsd} and $${s.maxCardUsd}.`, 'CARD_AMOUNT');
  }
  const live = await Card.countDocuments({ user: user._id, status: { $in: ['creating', 'active', 'frozen'] } });
  if (live >= s.maxCardsPerUser) throw conflict(`You can have up to ${s.maxCardsPerUser} dollar cards.`, 'CARD_LIMIT');
  if (await Card.exists({ user: user._id, status: 'creating' })) {
    throw conflict('Your last card is still being created. Please wait a moment.', 'CARD_CREATING');
  }
  const idType = (ID_TYPES[user.country] || ID_TYPES.NG).find((t) => t.id === body.idType);
  if (!idType) throw badRequest('Choose a valid ID type.', 'INVALID_ID_TYPE');
  if (idType.needsImage && !body.idImageBase64) throw badRequest(`Add a photo of your ${idType.name}.`, 'ID_IMAGE_REQUIRED');
  if (!isAdult(body.dateOfBirth)) throw badRequest('You must be 18 or older to get a dollar card.', 'INVALID_DOB');

  const p = await price(user, 'create', amountUsd, settings);
  await assertWithinLimits(user, serviceFor(user), p.local, settings);
  await verifyPin(user._id, body.pin);

  const country = COUNTRIES[user.country] || COUNTRIES.NG;
  const { firstName, lastName } = splitName(user.fullName);
  const cardName = (body.cardName || user.fullName).slice(0, 40);
  const reference = makeReference('VC');
  const { before, after } = await wallet.debit(user._id, p.local);
  let txn;
  let card;
  try {
    txn = await Transaction.create({
      user: user._id,
      reference,
      type: 'card_create',
      direction: 'debit',
      amount: p.local,
      status: 'pending',
      service: serviceFor(user),
      recipient: `${body.brand} dollar card`,
      description: `New ${body.brand} dollar card · $${amountUsd.toFixed(2)}`,
      provider: 'cashwyre',
      balanceBefore: before,
      balanceAfter: after,
      metadata: { amountUsd, feeUsd: p.feeUsd, totalUsd: p.totalUsd, rate: p.rate },
    });
    card = await Card.create({ user: user._id, brand: body.brand, name: cardName, createTransaction: txn._id });
    txn.metadata = { ...txn.metadata, cardId: String(card._id) };
    await txn.save();
  } catch (e) {
    await wallet.credit(user._id, p.local);
    if (txn) await Transaction.deleteOne({ _id: txn._id });
    throw e;
  }

  try {
    await cashwyre.createCard({
      firstName,
      lastName,
      email: user.email,
      phoneCode: country.dialCode,
      phoneNumber: String(user.phone || '').replace(/^0/, ''),
      dateOfBirth: `${body.dateOfBirth}T00:00:00Z`,
      homeAddressNumber: body.homeAddressNumber,
      homeAddress: body.homeAddress,
      cardName,
      cardBrand: body.brand,
      amountUsd,
      idType: idType.id,
      idNumber: body.idNumber,
      idImageBase64: body.idImageBase64 || null,
    });
  } catch (e) {
    if (e instanceof AppError) {
      await failCreation(card, e.message);
      throw badRequest(`The card couldn't be created: ${e.message}. Your wallet has been refunded.`, 'CARD_DECLINED');
    }
    await raiseAlert({
      type: 'provider',
      severity: 'warning',
      title: 'Cashwyre did not respond (new card)',
      body: `${reference} for ${user.fullName} is pending: ${e.message}`,
      user: user._id,
      transaction: txn._id,
    });
  }
  // Remember the details for next time (not the ID number).
  await User.updateOne(
    { _id: user._id },
    { $set: { 'kyc.dateOfBirth': user.kyc?.dateOfBirth || body.dateOfBirth, 'kyc.address': user.kyc?.address || `${body.homeAddressNumber} ${body.homeAddress}` } },
  );
  try {
    await tryLink(card);
  } catch {
    // The webhook or the sweeper will link it.
  }
  return Card.findById(card._id);
}

async function refresh(card) {
  if (!card.cardCode || card.status === 'terminated') return card;
  try {
    const d = await cashwyre.getCard(card.cardCode);
    card.balanceUsd = cents(d.balanceUsd);
    if (['active', 'frozen', 'terminated'].includes(d.status)) card.status = d.status;
    else if (d.status === 'inactive' && card.status !== 'frozen') card.status = 'active';
    card.lastSyncedAt = new Date();
    await card.save();
  } catch {
    // Keep the last known balance.
  }
  return card;
}

async function list(user) {
  const cards = await Card.find({ user: user._id, status: { $ne: 'failed' } }).sort({ createdAt: -1 });
  await Promise.all(
    cards.map(async (c) => {
      if (c.status === 'creating') {
        try {
          await tryLink(c);
        } catch {
          /* later */
        }
      } else if (!c.lastSyncedAt || Date.now() - c.lastSyncedAt.getTime() > 60 * 1000) {
        await refresh(c);
      }
    }),
  );
  return Card.find({ user: user._id, status: { $ne: 'failed' } }).sort({ createdAt: -1 });
}

function assertUsable(card) {
  if (card.status === 'creating') throw conflict('This card is still being created.', 'CARD_CREATING');
  if (card.status === 'terminated') throw forbidden('This card has been closed.', 'CARD_TERMINATED');
}

async function reveal(user, id, pin) {
  const card = await ownCard(user, id);
  assertUsable(card);
  await verifyPin(user._id, pin);
  const d = await cashwyre.getCard(card.cardCode);
  return { number: d.number, cvv: d.cvv, validMonthYear: d.validMonthYear, name: d.name, billing: d.billing };
}

async function topup(user, id, { amountUsd: raw, pin }) {
  const card = await ownCard(user, id);
  assertUsable(card);
  if (card.status === 'frozen') throw conflict('Unfreeze the card before adding money.', 'CARD_FROZEN');
  const settings = await checks(user);
  const amountUsd = usd2(raw);
  if (amountUsd < 1) throw badRequest('The minimum top-up is $1.', 'CARD_AMOUNT');
  const p = await price(user, 'topup', amountUsd, settings);
  await assertWithinLimits(user, serviceFor(user), p.local, settings);
  await verifyPin(user._id, pin);

  const reference = makeReference('VT');
  const { before, after } = await wallet.debit(user._id, p.local);
  const txn = await Transaction.create({
    user: user._id,
    reference,
    type: 'card_topup',
    direction: 'debit',
    amount: p.local,
    status: 'pending',
    service: serviceFor(user),
    recipient: `Card •••• ${card.last4 || ''}`,
    description: `Dollar card top-up · $${amountUsd.toFixed(2)}`,
    provider: 'cashwyre',
    balanceBefore: before,
    balanceAfter: after,
    metadata: { cardId: String(card._id), cardCode: card.cardCode, amountUsd, feeUsd: p.feeUsd, totalUsd: p.totalUsd, rate: p.rate },
  });
  try {
    await cashwyre.topupCard(card.cardCode, amountUsd);
    txn.status = 'success';
    await txn.save();
    await notify(user._id, {
      title: 'Card topped up',
      body: `$${amountUsd.toFixed(2)} was added to your card ending ${card.last4 || ''}.`,
      kind: 'payment',
      data: { transactionId: String(txn._id), cardId: String(card._id) },
    });
  } catch (e) {
    if (e instanceof AppError) {
      txn.metadata = { ...txn.metadata, failureReason: e.message };
      await txn.save();
      await refundTransaction(txn, { reason: e.message, status: 'failed' });
      throw badRequest(`The top-up was declined: ${e.message}. Your wallet has been refunded.`, 'CARD_DECLINED');
    }
    await raiseAlert({
      type: 'provider',
      severity: 'warning',
      title: 'Cashwyre did not respond (card top-up)',
      body: `${reference} ($${amountUsd}) for ${user.fullName} is pending. Check the card's balance in Cashwyre, then mark it successful or refund it.`,
      user: user._id,
      transaction: txn._id,
    });
  }
  await refresh(card);
  return Transaction.findById(txn._id);
}

async function withdraw(user, id, { amountUsd: raw, pin }) {
  const card = await ownCard(user, id);
  assertUsable(card);
  if (card.status === 'frozen') throw conflict('Unfreeze the card before moving money out.', 'CARD_FROZEN');
  const settings = await checks(user);
  const amountUsd = usd2(raw);
  if (amountUsd < 1) throw badRequest('The minimum is $1.', 'CARD_AMOUNT');
  await verifyPin(user._id, pin);
  await refresh(card);
  const balance = card.balanceUsd / 100;
  if (balance - amountUsd < FEES.minLeftUsd) {
    throw badRequest(`$${FEES.minLeftUsd} must stay on the card. You can move up to $${Math.max(0, balance - FEES.minLeftUsd).toFixed(2)}.`, 'CARD_BALANCE');
  }
  if (await Transaction.exists({ user: user._id, type: 'card_withdrawal', status: 'pending', 'metadata.cardId': String(card._id) })) {
    throw conflict('Your last withdrawal from this card is still processing.', 'WITHDRAWAL_PENDING');
  }
  const p = await price(user, 'withdraw', amountUsd, settings);
  const reference = makeReference('VW');
  const txn = await Transaction.create({
    user: user._id,
    reference,
    type: 'card_withdrawal',
    direction: 'credit',
    amount: p.local,
    status: 'pending',
    service: serviceFor(user),
    recipient: `Card •••• ${card.last4 || ''}`,
    description: `From dollar card · $${amountUsd.toFixed(2)}`,
    provider: 'cashwyre',
    metadata: { cardId: String(card._id), cardCode: card.cardCode, amountUsd, rate: p.rate, requestedAt: new Date().toISOString() },
  });
  try {
    await cashwyre.withdrawCard(card.cardCode, amountUsd, 'Move to Dalabapay wallet');
  } catch (e) {
    if (e instanceof AppError) {
      txn.status = 'failed';
      txn.metadata = { ...txn.metadata, failureReason: e.message };
      await txn.save();
      throw badRequest(`The withdrawal was declined: ${e.message}`, 'CARD_DECLINED');
    }
  }
  await notify(user._id, {
    title: 'Withdrawal processing',
    body: `$${amountUsd.toFixed(2)} is moving from your card to your wallet. We'll credit ${formatMoney(p.local, p.currency)} once it's confirmed.`,
    kind: 'payment',
    data: { transactionId: String(txn._id), cardId: String(card._id) },
  });
  // Often confirmed straight away.
  try {
    await settleWithdrawals(card);
  } catch {
    /* webhook or sweeper */
  }
  return Transaction.findById(txn._id);
}

/** Credits pending withdrawals that Cashwyre's card history confirms. */
async function settleWithdrawals(card) {
  const pending = await Transaction.find({ type: 'card_withdrawal', status: 'pending', 'metadata.cardId': String(card._id) }).sort({ createdAt: 1 });
  if (!pending.length || !card.cardCode) return 0;
  const history = await cashwyre.cardTransactions(card.cardCode);
  const used = new Set(
    (await Transaction.find({ type: 'card_withdrawal', 'metadata.cardId': String(card._id), providerReference: { $ne: null } }).select('providerReference')).map(
      (t) => t.providerReference,
    ),
  );
  let settled = 0;
  for (const t of pending) {
    const since = new Date(t.metadata.requestedAt || t.createdAt).getTime() - 2 * 60 * 60 * 1000;
    const match = history.find(
      (h) =>
        !used.has(h.reference || h.id) &&
        h.status === 'success' &&
        (h.category.includes('withdrawal') || h.description.toLowerCase().startsWith('withdraw from card')) &&
        Math.abs(h.amountUsd - Number(t.metadata.amountUsd)) < 0.005 &&
        (!h.createdAt || new Date(h.createdAt).getTime() >= since),
    );
    if (!match) continue;
    const ref = match.reference || match.id;
    used.add(ref);
    // eslint-disable-next-line no-await-in-loop
    const claimed = await Transaction.findOneAndUpdate({ _id: t._id, status: 'pending' }, { $set: { status: 'success', providerReference: ref } }, { new: true });
    if (!claimed) continue;
    // eslint-disable-next-line no-await-in-loop
    const { before, after } = await wallet.credit(t.user, t.amount);
    // eslint-disable-next-line no-await-in-loop
    await Transaction.updateOne({ _id: t._id }, { $set: { balanceBefore: before, balanceAfter: after } });
    // eslint-disable-next-line no-await-in-loop
    await notify(t.user, {
      title: 'Money moved to your wallet',
      body: `${formatMoney(t.amount, t.currency)} from your dollar card is now in your wallet.`,
      kind: 'wallet',
      data: { transactionId: String(t._id), cardId: String(card._id) },
    });
    settled += 1;
  }
  return settled;
}

async function setFrozen(user, id, frozen) {
  const card = await ownCard(user, id);
  assertUsable(card);
  if (frozen) await cashwyre.freezeCard(card.cardCode);
  else await cashwyre.unfreezeCard(card.cardCode);
  card.status = frozen ? 'frozen' : 'active';
  await card.save();
  return card;
}

async function history(user, id) {
  const card = await ownCard(user, id);
  if (!card.cardCode) return [];
  return cashwyre.cardTransactions(card.cardCode);
}

// ── Webhooks (never trusted alone: confirmed with Cashwyre) ─

async function onCardEvent(eventType, data) {
  const type = String(eventType || '').toLowerCase();
  const code = cashwyre.pick(data, 'cardCode');
  const email = String(cashwyre.pick(data, 'CustomerEmail') || '').toLowerCase();

  if (type.startsWith('virtualcard.created')) {
    const user = email ? await User.findOne({ email }).select('_id') : null;
    if (!user) return { matched: false };
    const card = await Card.findOne({ user: user._id, status: 'creating' }).sort({ createdAt: 1 });
    if (!card) return { matched: false };
    if (type.endsWith('failed')) {
      // Make sure no card was made before refunding.
      if (await tryLink(card)) return { matched: true, result: 'linked' };
      await failCreation(card, 'Cashwyre could not create the card');
      await notify(user._id, { title: 'Card not created', body: 'We couldn\'t create your dollar card. Your wallet has been refunded.', kind: 'payment' });
      return { matched: true, result: 'failed' };
    }
    if (!code) return { matched: true, result: (await tryLink(card)) ? 'linked' : 'waiting' };
    const details = await cashwyre.getCard(code);
    if (details.customerEmail && details.customerEmail !== email) return { matched: false };
    if (await Card.exists({ cardCode: code })) return { matched: true, result: 'already linked' };
    await activate(card, { ...details, code });
    return { matched: true, result: 'linked' };
  }

  const card = code ? await Card.findOne({ cardCode: code }) : null;
  if (!card) return { matched: false };

  if (type.includes('withdraw')) {
    if (type.endsWith('failed')) {
      const t = await Transaction.findOneAndUpdate(
        { type: 'card_withdrawal', status: 'pending', 'metadata.cardId': String(card._id) },
        { $set: { status: 'failed', 'metadata.failureReason': 'Withdrawal failed at Cashwyre' } },
        { sort: { createdAt: 1 }, new: true },
      );
      if (t) await notify(card.user, { title: 'Withdrawal failed', body: 'Moving money from your dollar card failed. The money is still on your card.', kind: 'payment' });
      return { matched: true, result: 'failed' };
    }
    const n = await settleWithdrawals(card);
    await refresh(card);
    return { matched: true, result: `settled ${n}` };
  }

  if (type.includes('topup')) {
    await refresh(card);
    return { matched: true, result: 'refreshed' };
  }

  if (type.startsWith('virtualcard.transaction')) {
    const amount = Number(cashwyre.pick(data, 'amount') || 0);
    const desc = String(cashwyre.pick(data, 'description') || '').slice(0, 80);
    if (type.endsWith('declined.terminated')) {
      card.status = 'terminated';
      await card.save();
      await notify(card.user, { title: 'Card closed', body: `Your card ending ${card.last4 || ''} has been closed by the card issuer after repeated declines.`, kind: 'security' });
    } else if (type.endsWith('declined.frozen')) {
      card.status = 'frozen';
      await card.save();
      await notify(card.user, { title: 'Card frozen', body: `Your card ending ${card.last4 || ''} has been frozen.`, kind: 'security' });
    } else if (type.endsWith('declined')) {
      await notify(card.user, {
        title: 'Card payment declined',
        body: `$${amount.toFixed(2)} ${desc ? `at ${desc} ` : ''}was declined. Add money to your card — repeated declines can get the card closed.`,
        kind: 'payment',
      });
    } else if (type.endsWith('reversed')) {
      await notify(card.user, { title: 'Card payment reversed', body: `$${amount.toFixed(2)} ${desc ? `(${desc}) ` : ''}was returned to your card.`, kind: 'payment' });
    } else if (type.endsWith('crossborder')) {
      await notify(card.user, { title: 'Cross-border fee', body: `A $${amount.toFixed(2)} fee was charged for a non-dollar payment.`, kind: 'payment' });
    } else {
      await notify(card.user, { title: 'Card payment', body: `$${amount.toFixed(2)} paid with your card ending ${card.last4 || ''}${desc ? ` · ${desc}` : ''}.`, kind: 'payment' });
    }
    card.lastSyncedAt = null; // refresh the balance next time
    await card.save();
    return { matched: true, result: 'notified' };
  }
  return { matched: true, result: 'ignored' };
}

/** For the sweeper: links cards still being created, settles withdrawals. */
async function sweepCards({ now = Date.now() } = {}) {
  if (!cashwyre.configured()) return;
  const creating = await Card.find({ status: 'creating', createdAt: { $lte: new Date(now - 60 * 1000), $gte: new Date(now - 72 * 3600 * 1000) } }).limit(20);
  for (const c of creating) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const linked = await tryLink(c);
      if (!linked && now - c.createdAt.getTime() > 30 * 60 * 1000 && !c.failureReason) {
        c.failureReason = 'Not confirmed by Cashwyre after 30 minutes';
        // eslint-disable-next-line no-await-in-loop
        await c.save();
        // eslint-disable-next-line no-await-in-loop
        await raiseAlert({
          type: 'provider',
          severity: 'warning',
          title: 'Dollar card not confirmed',
          body: `A card paid for ${new Date(c.createdAt).toISOString()} hasn't appeared in Cashwyre. Check it there, then refund the payment if it wasn't created.`,
          user: c.user,
          transaction: c.createTransaction,
        });
      }
    } catch {
      /* next time */
    }
  }
  const pendingCards = await Transaction.distinct('metadata.cardId', {
    type: 'card_withdrawal',
    status: 'pending',
    createdAt: { $lte: new Date(now - 60 * 1000), $gte: new Date(now - 72 * 3600 * 1000) },
  });
  for (const id of pendingCards.slice(0, 20)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const card = await Card.findById(id);
      // eslint-disable-next-line no-await-in-loop
      if (card) await settleWithdrawals(card);
    } catch {
      /* next time */
    }
  }
}

module.exports = {
  FEES,
  ID_TYPES,
  config,
  price,
  publicPrice,
  create,
  list,
  refresh,
  reveal,
  topup,
  withdraw,
  setFrozen,
  history,
  onCardEvent,
  settleWithdrawals,
  sweepCards,
  serviceFor,
};
