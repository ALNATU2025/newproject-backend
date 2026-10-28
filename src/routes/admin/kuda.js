// Admin: is Kuda Business connected? Signs in, reads the bank list and
// shows the webhook URL to give Kuda.
//   GET /api/admin/kuda/status
const express = require('express');
const env = require('../../config/env');
const { requirePermission } = require('../../middleware/auth');
const { asyncHandler, ok } = require('../../utils/helpers');
const kuda = require('../../providers/kuda');

const router = express.Router();

router.get(
  '/status',
  requirePermission('settings:read'),
  asyncHandler(async (req, res) => {
    const out = {
      configured: kuda.configured(),
      environment: env.kuda.env,
      addMoney: env.paymentProvider === 'kuda',
      webhookUrl: env.kuda.webhookToken ? `${env.publicUrl || `${req.protocol}://${req.get('host')}`}/api/webhooks/kuda/••••` : null,
    };
    if (!out.configured) return ok(res, out);
    try {
      await kuda.getToken({ fresh: true });
      out.signIn = 'ok';
    } catch (e) {
      out.signIn = e.message;
      return ok(res, out);
    }
    try {
      const banks = await kuda.bankList();
      out.banks = banks.length;
    } catch (e) {
      out.banks = e.message;
    }
    return ok(res, out);
  }),
);

module.exports = router;
