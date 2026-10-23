// Everything under /api/admin needs an admin role; each route then checks
// its own permission (see src/permissions.js).
const express = require('express');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const { ok } = require('../../utils/helpers');
const { permissionsFor } = require('../../permissions');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/me', (req, res) =>
  ok(res, { id: String(req.user._id), fullName: req.user.fullName, role: req.user.role, permissions: permissionsFor(req.user.role) }),
);

router.use('/dashboard', require('./dashboard'));
router.use('/users', require('./users'));
router.use('/kyc', require('./kyc'));
router.use('/cashwyre', require('./cashwyre'));
router.use('/transactions', require('./transactions'));
router.use('/disputes', require('./disputes'));
router.use('/payments', require('./payments'));
router.use('/roles', require('./roles'));
router.use('/', require('./messages'));
router.use('/', require('./settings'));

module.exports = router;
