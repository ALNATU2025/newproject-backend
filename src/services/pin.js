// Payment PIN: hashing, verification and lockout after repeated failures.
const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { badRequest, locked, forbidden } = require('../utils/errors');
const { raiseAlert } = require('./alerts');

const MAX_ATTEMPTS = 5;
const LOCK_MS = 30 * 60 * 1000;

const WEAK = new Set(['123456', '654321', '000000', '111111', '222222', '333333', '444444',
  '555555', '666666', '777777', '888888', '999999', '121212', '112233', '123123']);

function assertStrongPin(pin) {
  if (WEAK.has(pin)) throw badRequest('Please choose a less obvious PIN.', 'WEAK_PIN');
}

async function setPin(userId, pin) {
  assertStrongPin(pin);
  const pinHash = await bcrypt.hash(pin, 10);
  await User.updateOne(
    { _id: userId },
    { $set: { pinHash, pinSet: true, pinFailedAttempts: 0, pinLockedUntil: null } },
  );
}

/**
 * Throws if the PIN is wrong or locked. Counts failures and locks the PIN
 * for 30 minutes after 5 wrong attempts (and alerts admins).
 */
async function verifyPin(userId, pin) {
  const user = await User.findById(userId).select('+pinHash');
  if (!user) throw forbidden();
  if (!user.pinSet || !user.pinHash) {
    throw badRequest('Please set up your payment PIN first.', 'PIN_NOT_SET');
  }
  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
    const mins = Math.ceil((user.pinLockedUntil - Date.now()) / 60000);
    throw locked(`Your PIN is locked. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'PIN_LOCKED');
  }
  const match = await bcrypt.compare(String(pin || ''), user.pinHash);
  if (match) {
    if (user.pinFailedAttempts || user.pinLockedUntil) {
      await User.updateOne({ _id: userId }, { $set: { pinFailedAttempts: 0, pinLockedUntil: null } });
    }
    return true;
  }
  const attempts = (user.pinFailedAttempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await User.updateOne(
      { _id: userId },
      { $set: { pinFailedAttempts: 0, pinLockedUntil: new Date(Date.now() + LOCK_MS) } },
    );
    await raiseAlert({
      type: 'suspicious',
      severity: 'critical',
      title: 'PIN locked',
      body: `${MAX_ATTEMPTS} wrong PIN attempts on ${user.fullName}'s account. PIN locked for 30 minutes.`,
      user: user._id,
    });
    throw locked('Too many wrong PINs. Your PIN is locked for 30 minutes.', 'PIN_LOCKED');
  }
  await User.updateOne({ _id: userId }, { $set: { pinFailedAttempts: attempts } });
  const left = MAX_ATTEMPTS - attempts;
  throw badRequest(`Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} left.`, 'PIN_INVALID');
}

async function unlockPin(userId) {
  await User.updateOne({ _id: userId }, { $set: { pinFailedAttempts: 0, pinLockedUntil: null } });
}

/** Clears the PIN so the user must create a new one. */
async function clearPin(userId) {
  await User.updateOne(
    { _id: userId },
    { $set: { pinHash: null, pinSet: false, pinFailedAttempts: 0, pinLockedUntil: null } },
  );
}

module.exports = { setPin, verifyPin, unlockPin, clearPin, assertStrongPin };
