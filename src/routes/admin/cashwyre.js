// Admin: what Cashwyre reports per country (banks, mobile money, your
// wallet balance), to see why a country is or isn't offered.
//   GET /api/admin/cashwyre/coverage
const express = require('express');
const { requirePermission } = require('../../middleware/auth');
const { asyncHandler, ok } = require('../../utils/helpers');
const cashwyre = require('../../providers/cashwyre');
const payouts = require('../../services/payouts');

const router = express.Router();

router.get(
  '/coverage',
  requirePermission('settings:read'),
  asyncHandler(async (req, res) => {
    if (!cashwyre.configured()) return ok(res, { connected: false, countries: [] });
    payouts.clearPayoutCache();
    return ok(res, { connected: true, countries: await payouts.coverage() });
  }),
);

module.exports = router;
