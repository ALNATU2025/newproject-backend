const express = require('express');
const { Notification } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok, pageParams } = require('../utils/helpers');
const { notFound } = require('../utils/errors');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 30);
    const filter = { user: req.user._id };
    const [items, total, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
      Notification.countDocuments({ ...filter, read: false }),
    ]);
    ok(res, { items: items.map(serialize.notification), total, unread, page, hasMore: skip + items.length < total });
  }),
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await Notification.updateMany({ user: req.user._id, read: false }, { $set: { read: true } });
    ok(res, { unread: 0 });
  }),
);

router.patch(
  '/:id/read',
  validate({ params: z.object({ id: fields.objectId }) }),
  asyncHandler(async (req, res) => {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { read: true } },
      { new: true },
    );
    if (!n) throw notFound('Notification not found.');
    ok(res, serialize.notification(n));
  }),
);

router.delete(
  '/:id',
  validate({ params: z.object({ id: fields.objectId }) }),
  asyncHandler(async (req, res) => {
    const r = await Notification.deleteOne({ _id: req.params.id, user: req.user._id });
    if (!r.deletedCount) throw notFound('Notification not found.');
    ok(res, { deleted: true });
  }),
);

module.exports = router;
