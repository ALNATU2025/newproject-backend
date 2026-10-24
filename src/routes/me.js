// The logged-in user: profile, home screen summary, preferences.
const express = require('express');
const { Transaction, Notification, Device } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { getSettings } = require('../services/settings');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);

const { User } = require('../models');
const { badRequest } = require('../utils/errors');

/** The profile photo as a data URI (null when there is none). */
async function avatarOf(userId) {
  const u = await User.findById(userId).select('+avatar avatarUpdatedAt');
  if (!u || !u.avatar) return null;
  const mime = u.avatar.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${u.avatar}`;
}

router.get(
  '/',
  asyncHandler(async (req, res) => ok(res, { ...serialize.user(req.user), avatar: await avatarOf(req.user._id) })),
);

// ── Profile photo ──────────────────────────────────────────

const MAX_AVATAR = 400_000; // base64 characters (~300 KB)

router.put(
  '/avatar',
  validate({ body: z.object({ image: z.string().min(100).max(MAX_AVATAR + 100, 'The photo is too large. Please choose a smaller one.') }) }),
  asyncHandler(async (req, res) => {
    const b64 = req.body.image.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length > MAX_AVATAR) throw badRequest('That photo can\'t be used.', 'INVALID_IMAGE');
    // Only real JPEG or PNG images.
    const head = Buffer.from(b64.slice(0, 16), 'base64');
    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const png = head.slice(0, 4).toString('hex') === '89504e47';
    if (!jpeg && !png) throw badRequest('Please choose a JPEG or PNG photo.', 'INVALID_IMAGE');
    await User.updateOne({ _id: req.user._id }, { $set: { avatar: b64, avatarUpdatedAt: new Date() } });
    ok(res, { avatar: await avatarOf(req.user._id) });
  }),
);

router.delete(
  '/avatar',
  asyncHandler(async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $set: { avatar: null, avatarUpdatedAt: null } });
    ok(res, { avatar: null });
  }),
);

/** Everything the home screen needs in one call. */
router.get(
  '/home',
  asyncHandler(async (req, res) => {
    const [recent, unread, settings] = await Promise.all([
      Transaction.find({ user: req.user._id, wallet: 'main' }).sort({ createdAt: -1 }).limit(5),
      Notification.countDocuments({ user: req.user._id, read: false }),
      getSettings(),
    ]);
    ok(res, {
      user: { ...serialize.user(req.user), avatar: await avatarOf(req.user._id) },
      recentTransactions: recent.map((t) => serialize.transaction(t)),
      unreadNotifications: unread,
      requireApproval: Boolean(settings.requireApproval),
      maintenance: settings.maintenance ? settings.maintenanceMessage : null,
    });
  }),
);

router.patch(
  '/preferences',
  validate({
    body: z.object({
      biometricEnabled: z.boolean().optional(),
      pushEnabled: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (req.body.biometricEnabled !== undefined) req.user.preferences.biometricEnabled = req.body.biometricEnabled;
    if (req.body.pushEnabled !== undefined) req.user.preferences.pushEnabled = req.body.pushEnabled;
    await req.user.save();
    ok(res, serialize.user(req.user));
  }),
);

// ── Phones for push notifications ───────────────────────────

/** Saves this phone's push token (the app calls this after login). */
router.post(
  '/devices',
  validate({ body: z.object({ token: z.string().trim().min(20).max(4096), platform: z.enum(['android', 'ios', 'web']).default('android') }) }),
  asyncHandler(async (req, res) => {
    // A token belongs to one phone; if someone else logs in on it, it moves.
    await Device.updateOne(
      { token: req.body.token },
      { $set: { user: req.user._id, platform: req.body.platform, lastSeenAt: new Date() } },
      { upsert: true },
    );
    // Keep the 5 most recent phones per user.
    const extra = await Device.find({ user: req.user._id }).sort({ lastSeenAt: -1 }).skip(5).select('_id');
    if (extra.length) await Device.deleteMany({ _id: { $in: extra.map((d) => d._id) } });
    ok(res, { registered: true });
  }),
);

/** Stops push to this phone (the app calls this on logout). */
router.post(
  '/devices/remove',
  validate({ body: z.object({ token: z.string().trim().min(20).max(4096) }) }),
  asyncHandler(async (req, res) => {
    await Device.deleteOne({ token: req.body.token, user: req.user._id });
    ok(res, { removed: true });
  }),
);

module.exports = router;
