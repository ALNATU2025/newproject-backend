// Admin Control: who has which admin role (Super Admin only).
const express = require('express');
const { User } = require('../../models');
const { requirePermission } = require('../../middleware/auth');
const { validate, z, fields } = require('../../middleware/validate');
const { asyncHandler, ok } = require('../../utils/helpers');
const { badRequest, notFound } = require('../../utils/errors');
const { audit } = require('../../services/alerts');
const { notify } = require('../../services/notify');
const { PERMISSIONS } = require('../../permissions');
const serialize = require('../../serializers');

const router = express.Router();
router.use(requirePermission('roles:manage'));

const ADMIN_ROLES = ['support', 'finance', 'admin', 'super'];
const LABEL = { user: 'User', support: 'Support Agent', finance: 'Finance Officer', admin: 'Administrator', super: 'Super Admin' };

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [admins, regular] = await Promise.all([
      User.find({ role: { $in: ADMIN_ROLES } }).sort({ role: 1, fullName: 1 }),
      User.countDocuments({ role: 'user' }),
    ]);
    ok(res, {
      admins: admins.map((u) => serialize.user(u, { admin: true })),
      regularUsers: regular,
      roles: ADMIN_ROLES.map((r) => ({
        id: r,
        label: LABEL[r],
        permissions: Object.keys(PERMISSIONS).filter((p) => PERMISSIONS[p].includes(r)),
      })),
    });
  }),
);

async function setRole(actor, target, role) {
  if (String(target._id) === String(actor._id)) {
    throw badRequest('You can\'t change your own role.', 'SELF_ACTION');
  }
  if (target.role === 'super' && role !== 'super') {
    const supers = await User.countDocuments({ role: 'super', isActive: true });
    if (supers <= 1) throw badRequest('There must be at least one Super Admin.', 'LAST_SUPER_ADMIN');
  }
  const from = target.role;
  target.role = role;
  await target.save();
  await audit(actor._id, 'role.change', { targetUser: target._id, details: { from, to: role } });
  await notify(target._id, {
    title: 'Your access changed',
    body: role === 'user' ? 'Your admin access has been removed.' : `You are now a ${LABEL[role]}.`,
    kind: 'security',
  });
  return target;
}

/** Give a role by user id or email. */
router.post(
  '/',
  validate({
    body: z
      .object({
        userId: fields.objectId.optional(),
        email: fields.email.optional(),
        role: z.enum(['user', ...ADMIN_ROLES]),
      })
      .refine((v) => v.userId || v.email, { message: 'Enter a user email' }),
  }),
  asyncHandler(async (req, res) => {
    const target = await User.findOne(req.body.userId ? { _id: req.body.userId } : { email: req.body.email });
    if (!target) throw notFound('User with this email not found.', 'USER_NOT_FOUND');
    if (target.role === req.body.role) {
      throw badRequest(`This user is already ${LABEL[req.body.role]}.`, 'NO_CHANGE');
    }
    await setRole(req.user, target, req.body.role);
    ok(res, serialize.user(target, { admin: true }));
  }),
);

module.exports = router;
