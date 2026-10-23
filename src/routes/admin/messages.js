// Broadcast notifications to users, and the admin alerts feed.
const express = require('express');
const { User, Notification, Broadcast, AdminAlert } = require('../../models');
const { ALERT_TYPES } = require('../../models/constants');
const { requirePermission } = require('../../middleware/auth');
const { validate, z, fields } = require('../../middleware/validate');
const { asyncHandler, ok, pageParams } = require('../../utils/helpers');
const { badRequest, notFound } = require('../../utils/errors');
const { audit } = require('../../services/alerts');
const serialize = require('../../serializers');

const router = express.Router();

const KIND_FOR_TYPE = {
  announcement: 'general',
  promotional: 'promo',
  alert: 'security',
  transaction: 'payment',
  commission: 'commission',
  referral: 'referral',
  welcome: 'general',
  custom: 'general',
};

// ── Broadcasts ─────────────────────────────────────────────

router.get(
  '/broadcasts',
  requirePermission('notifications:send'),
  asyncHandler(async (req, res) => {
    const [recent, totals, activeUsers] = await Promise.all([
      Broadcast.find({}).sort({ createdAt: -1 }).limit(20).populate('sender', 'fullName'),
      Broadcast.aggregate([{ $group: { _id: null, recipients: { $sum: '$recipients' }, count: { $sum: 1 } } }]),
      User.countDocuments({ isActive: true }),
    ]);
    ok(res, {
      sent: (totals[0] && totals[0].recipients) || 0,
      broadcasts: (totals[0] && totals[0].count) || 0,
      activeUsers,
      recent: recent.map((b) => ({
        id: String(b._id),
        title: b.title,
        message: b.message,
        type: b.type,
        audience: b.audience,
        recipients: b.recipients,
        sender: b.sender ? b.sender.fullName : null,
        createdAt: b.createdAt,
      })),
    });
  }),
);

router.post(
  '/broadcasts',
  requirePermission('notifications:send'),
  validate({
    body: z.object({
      title: z.string().trim().min(2, 'Please enter a title').max(60),
      message: z.string().trim().min(2, 'Please enter a message').max(240),
      type: z.enum(Object.keys(KIND_FOR_TYPE)).default('announcement'),
      audience: z.enum(['all', 'selected']),
      userIds: z.array(fields.objectId).max(5000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { title, message, type, audience, userIds } = req.body;
    let ids;
    if (audience === 'all') {
      ids = await User.find({ isActive: true }).distinct('_id');
    } else {
      if (!userIds || !userIds.length) throw badRequest('No users selected.', 'NO_RECIPIENTS');
      ids = await User.find({ _id: { $in: userIds } }).distinct('_id');
    }
    const broadcast = await Broadcast.create({
      sender: req.user._id,
      title,
      message,
      type,
      audience,
      recipients: ids.length,
    });
    const kind = KIND_FOR_TYPE[type];
    for (let i = 0; i < ids.length; i += 1000) {
      // eslint-disable-next-line no-await-in-loop
      await Notification.insertMany(
        ids.slice(i, i + 1000).map((user) => ({ user, title, body: message, kind, broadcast: broadcast._id })),
        { ordered: false },
      );
    }
    // eslint-disable-next-line global-require
    require('../../services/push').pushToUsers(ids, { title, body: message, data: { kind, broadcastId: String(broadcast._id) } }).catch(() => {});
    await audit(req.user._id, 'notification.broadcast', { details: { title, audience, recipients: ids.length } });
    ok(res, { sent: ids.length, broadcastId: String(broadcast._id) }, 201);
  }),
);

// ── Alerts ─────────────────────────────────────────────────

router.get(
  '/alerts',
  requirePermission('alerts:read'),
  validate({
    query: z.object({
      type: z.enum(ALERT_TYPES).optional(),
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 40);
    const filter = req.query.type ? { type: req.query.type } : {};
    const [items, total, unread] = await Promise.all([
      AdminAlert.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'fullName email phone'),
      AdminAlert.countDocuments(filter),
      AdminAlert.countDocuments({ readBy: { $ne: req.user._id } }),
    ]);
    ok(res, {
      items: items.map((a) => serialize.alert(a, req.user._id)),
      total,
      unread,
      page,
      hasMore: skip + items.length < total,
    });
  }),
);

router.post(
  '/alerts/read-all',
  requirePermission('alerts:read'),
  asyncHandler(async (req, res) => {
    await AdminAlert.updateMany({ readBy: { $ne: req.user._id } }, { $addToSet: { readBy: req.user._id } });
    ok(res, { unread: 0 });
  }),
);

router.patch(
  '/alerts/:id/read',
  requirePermission('alerts:read'),
  validate({ params: z.object({ id: fields.objectId }) }),
  asyncHandler(async (req, res) => {
    const a = await AdminAlert.findByIdAndUpdate(
      req.params.id,
      { $addToSet: { readBy: req.user._id } },
      { new: true },
    ).populate('user', 'fullName email phone');
    if (!a) throw notFound('Alert not found.');
    ok(res, serialize.alert(a, req.user._id));
  }),
);

module.exports = router;
