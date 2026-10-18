// Atomic wallet movements. Every change is a single conditional update, so
// two requests can never spend the same money (no read-then-write races).
const { User } = require('../models');
const { paymentRequired, notFound } = require('../utils/errors');

const FIELD = { main: 'balance', commission: 'commissionBalance' };

/**
 * Takes `kobo` from the user's wallet if they have enough.
 * Returns { before, after } in kobo. Throws 402 if not enough.
 */
async function debit(userId, kobo, { wallet = 'main', session } = {}) {
  const field = FIELD[wallet];
  const updated = await User.findOneAndUpdate(
    { _id: userId, [field]: { $gte: kobo } },
    { $inc: { [field]: -kobo } },
    { new: true, session, projection: { [field]: 1 } },
  );
  if (!updated) {
    const exists = await User.exists({ _id: userId });
    if (!exists) throw notFound('User not found.');
    throw paymentRequired(
      wallet === 'commission'
        ? 'You don\'t have enough earnings for this.'
        : 'Insufficient wallet balance. Please fund your wallet.',
    );
  }
  const after = updated[field];
  return { before: after + kobo, after };
}

/** Adds `kobo` to the user's wallet. Returns { before, after }. */
async function credit(userId, kobo, { wallet = 'main', session, extraInc = {} } = {}) {
  const field = FIELD[wallet];
  const updated = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { [field]: kobo, ...extraInc } },
    { new: true, session, projection: { [field]: 1 } },
  );
  if (!updated) throw notFound('User not found.');
  const after = updated[field];
  return { before: after - kobo, after };
}

module.exports = { debit, credit };
