// The logged-in user: profile, home screen summary, preferences.
const express = require('express');
const { Transaction, Notification } = require('../models');
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

module.exports = router;
