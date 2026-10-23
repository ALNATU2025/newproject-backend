// Manual KYC review for Sierra Leone: new accounts waiting for approval
// and account-level upgrade requests (with their documents).
//   GET  /api/admin/kyc/summary
//   GET  /api/admin/kyc/requests?status=pending|approved|rejected
//   GET  /api/admin/kyc/requests/:id         (with document images)
//   POST /api/admin/kyc/requests/:id/approve
//   POST /api/admin/kyc/requests/:id/reject  { reason }
// New accounts are approved / rejected with /api/admin/users/:id/approve|reject.
const express = require('express');
const { User, KycRequest } = require('../../models');
const { requirePermission } = require('../../middleware/auth');
const { validate, z, fields } = require('../../middleware/validate');
const { asyncHandler, ok } = require('../../utils/helpers');
const { badRequest, notFound } = require('../../utils/errors');
const { audit } = require('../../services/alerts');
const { notify } = require('../../services/notify');
const serialize = require('../../serializers');

const router = express.Router();
const idParam = validate({ params: z.object({ id: fields.objectId }) });

function row(r, { withFiles = false } = {}) {
  return {
    id: String(r._id),
    tier: r.tier,
    status: r.status,
    details: r.details || {},
    user: r.user && r.user._id ? { ...serialize.userBrief(r.user), tier: r.user.tier || 1, isApproved: r.user.isApproved, balance: (r.user.balance || 0) / 100, createdAt: r.user.createdAt } : null,
    files: withFiles ? (r.files || []).map((f) => ({ label: f.label, mime: f.mime, data: f.data })) : undefined,
    rejectionReason: r.rejectionReason || null,
    reviewedBy: r.reviewedBy && r.reviewedBy.fullName ? r.reviewedBy.fullName : null,
    reviewedAt: r.reviewedAt || null,
    createdAt: r.createdAt,
  };
}

const USER_FIELDS = 'fullName email phone country tier isApproved balance createdAt';

router.get(
  '/summary',
  requirePermission('users:read'),
  asyncHandler(async (req, res) => {
    const [accounts, upgrades] = await Promise.all([
      User.countDocuments({ country: 'SL', isApproved: false, approvalNote: null, role: 'user' }),
      KycRequest.countDocuments({ status: 'pending' }),
    ]);
    ok(res, { accountsToApprove: accounts, upgradesToReview: upgrades });
  }),
);

/** Sierra Leone accounts waiting for approval (and turned-down ones). */
router.get(
  '/accounts',
  requirePermission('users:read'),
  validate({ query: z.object({ status: z.enum(['pending', 'rejected']).default('pending') }) }),
  asyncHandler(async (req, res) => {
    const where = { country: 'SL', isApproved: false, role: 'user', approvalNote: req.query.status === 'pending' ? null : { $ne: null } };
    const users = await User.find(where).sort({ createdAt: -1 }).limit(200);
    ok(res, users.map((u) => serialize.user(u, { admin: true })));
  }),
);

router.get(
  '/requests',
  requirePermission('users:read'),
  validate({ query: z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }) }),
  asyncHandler(async (req, res) => {
    const list = await KycRequest.find({ status: req.query.status })
      .sort({ createdAt: req.query.status === 'pending' ? 1 : -1 })
      .limit(200)
      .populate('user', USER_FIELDS)
      .populate('reviewedBy', 'fullName');
    ok(res, list.map((r) => row(r)));
  }),
);

router.get(
  '/requests/:id',
  requirePermission('users:read'),
  idParam,
  asyncHandler(async (req, res) => {
    const r = await KycRequest.findById(req.params.id).select('+files').populate('user', USER_FIELDS).populate('reviewedBy', 'fullName');
    if (!r) throw notFound('Request not found.');
    await audit(req.user._id, 'kyc.view', { targetUser: r.user && r.user._id, details: { request: String(r._id) } });
    ok(res, row(r, { withFiles: true }));
  }),
);

async function pending(id) {
  const r = await KycRequest.findById(id).populate('user', USER_FIELDS);
  if (!r) throw notFound('Request not found.');
  if (r.status !== 'pending') throw badRequest(`This request was already ${r.status}.`, 'ALREADY_REVIEWED');
  return r;
}

router.post(
  '/requests/:id/approve',
  requirePermission('users:approve'),
  idParam,
  asyncHandler(async (req, res) => {
    const r = await pending(req.params.id);
    const claimed = await KycRequest.findOneAndUpdate(
      { _id: r._id, status: 'pending' },
      { $set: { status: 'approved', reviewedBy: req.user._id, reviewedAt: new Date() } },
      { new: true },
    );
    if (!claimed) throw badRequest('This request was already reviewed.', 'ALREADY_REVIEWED');
    await User.updateOne({ _id: r.user._id }, { $max: { tier: r.tier } });
    await audit(req.user._id, 'kyc.approve', { targetUser: r.user._id, details: { tier: r.tier } });
    await notify(r.user._id, {
      title: `You're now on Tier ${r.tier}`,
      body: `Your Tier ${r.tier} upgrade was approved. Your new limits apply right away.`,
      kind: 'security',
    });
    ok(res, row(await KycRequest.findById(r._id).populate('user', USER_FIELDS).populate('reviewedBy', 'fullName')));
  }),
);

router.post(
  '/requests/:id/reject',
  requirePermission('users:approve'),
  idParam,
  validate({ body: z.object({ reason: z.string().trim().min(3, 'Give a reason').max(300) }) }),
  asyncHandler(async (req, res) => {
    const r = await pending(req.params.id);
    const claimed = await KycRequest.findOneAndUpdate(
      { _id: r._id, status: 'pending' },
      { $set: { status: 'rejected', rejectionReason: req.body.reason, reviewedBy: req.user._id, reviewedAt: new Date() } },
      { new: true },
    );
    if (!claimed) throw badRequest('This request was already reviewed.', 'ALREADY_REVIEWED');
    await audit(req.user._id, 'kyc.reject', { targetUser: r.user._id, details: { tier: r.tier, reason: req.body.reason } });
    await notify(r.user._id, {
      title: `Tier ${r.tier} request not approved`,
      body: `Reason: ${req.body.reason}. You can fix this and send a new request.`,
      kind: 'security',
    });
    ok(res, row(await KycRequest.findById(r._id).populate('user', USER_FIELDS).populate('reviewedBy', 'fullName')));
  }),
);

module.exports = router;
