// Sign-ins from a new phone. The app sends a random install id in the
// X-Device-Id header (kept on the phone across logouts). The first time an
// account signs in on an id it hasn't seen, the person and the admins are
// told — unless it is the account's very first device (sign-up).
const crypto = require('crypto');
const { User } = require('../models');
const { notify } = require('./notify');
const { raiseAlert } = require('./alerts');

const MAX_DEVICES = 10;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/** The install id, device name and platform the app sent, if any. */
function deviceFrom(req) {
  const id = String(req.get('X-Device-Id') || '').trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(id)) return null;
  return {
    idHash: sha256(id),
    name: String(req.get('X-Device-Name') || '').trim().slice(0, 60) || 'a new device',
    platform: String(req.get('X-Device-Platform') || '').trim().slice(0, 20),
  };
}

/**
 * Remembers the device of this sign-in. Returns true when it is a new
 * device for an account that already had one (and the alerts went out).
 * Never throws.
 */
async function noteSignIn(userId, req, { how = 'password' } = {}) {
  try {
    const d = deviceFrom(req);
    if (!d) return false;
    const now = new Date();
    // Known device: just bump lastSeenAt.
    const known = await User.updateOne(
      { _id: userId, 'knownDevices.idHash': d.idHash },
      { $set: { 'knownDevices.$.lastSeenAt': now } },
    );
    if (known.matchedCount) return false;

    const user = await User.findById(userId).select('+knownDevices fullName email phone country');
    if (!user) return false;
    const first = !user.knownDevices || user.knownDevices.length === 0;
    const list = [...(user.knownDevices || []), { ...d, firstSeenAt: now, lastSeenAt: now }]
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt))
      .slice(0, MAX_DEVICES);
    await User.updateOne({ _id: userId }, { $set: { knownDevices: list } });
    if (first) return false;

    const where = req.ip ? ` (IP ${req.ip})` : '';
    const when = now.toLocaleString('en-GB', { timeZone: user.country === 'SL' ? 'Africa/Freetown' : 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
    await notify(userId, {
      title: 'New device sign-in',
      body: `Your account was signed in on ${d.name} on ${when}. If this wasn't you, change your password and PIN now.`,
      kind: 'security',
      data: { event: 'new_device' },
    });
    await raiseAlert({
      type: 'new_device',
      severity: 'warning',
      title: `New device sign-in · ${user.country === 'SL' ? 'Sierra Leone' : 'Nigeria'}`,
      body: `${user.fullName} (${user.email || user.phone}) signed in on ${d.name}${d.platform ? ` · ${d.platform}` : ''} with ${how}${where}.`,
      user: userId,
    });
    return true;
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.error('device note failed', e.message);
    return false;
  }
}

/**
 * True when this sign-in must be confirmed with an emailed code: the
 * account already has a known device and this isn't one of them (or the
 * app sent no device id). An account's first device is trusted.
 */
async function needsVerification(userId, req) {
  // eslint-disable-next-line global-require
  const settings = await require('./settings').getSettings();
  if (!settings.deviceCheck || !settings.deviceCheck.enabled) return false;
  const user = await User.findById(userId).select('+knownDevices');
  const known = (user && user.knownDevices) || [];
  if (!known.length) return false;
  const d = deviceFrom(req);
  return !d || !known.some((k) => k.idHash === d.idHash);
}

module.exports = { noteSignIn, deviceFrom, needsVerification };
