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

router.get(
  '/',
  asyncHandler(async (req, res) => ok(res, serialize.user(req.user))),
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
      user: serialize.user(req.user),
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
