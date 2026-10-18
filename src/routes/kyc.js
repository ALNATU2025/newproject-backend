// KYC: BVN or NIN + details → personal funding account number.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { conflict } = require('../utils/errors');
const { paymentProvider } = require('../providers/payment');
const { raiseAlert } = require('../services/alerts');
const { notify } = require('../services/notify');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const u = serialize.user(req.user);
    ok(res, { status: u.kyc.status, kyc: u.kyc, dedicatedAccount: u.dedicatedAccount });
  }),
);

router.post(
  '/',
  validate({
    body: z
      .object({
        bvn: z.string().trim().regex(/^\d{11}$/, 'BVN must be exactly 11 digits').optional().or(z.literal('')),
        nin: z.string().trim().regex(/^\d{11}$/, 'NIN must be 11 digits').optional().or(z.literal('')),
        dateOfBirth: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, 'Use DD/MM/YYYY'),
        gender: z.enum(['Male', 'Female']),
        address: z.string().trim().min(5, 'Enter your residential address').max(200),
      })
      .refine((v) => v.bvn || v.nin, { message: 'Please provide either a valid BVN or NIN' }),
  }),
  asyncHandler(async (req, res) => {
    const user = req.user;
    if (user.dedicatedAccount && user.dedicatedAccount.accountNumber) {
      throw conflict('You already have a funding account.', 'ALREADY_VERIFIED');
    }
    const idType = req.body.bvn ? 'bvn' : 'nin';
    const idNumber = req.body.bvn || req.body.nin;
    Object.assign(user.kyc, {
      status: 'pending',
      idType,
      idLast4: idNumber.slice(-4),
      dateOfBirth: req.body.dateOfBirth,
      gender: req.body.gender,
      address: req.body.address,
      submittedAt: new Date(),
      rejectionReason: null,
    });
    await user.save();

    const provider = paymentProvider();
    if (provider.isConfigured()) {
      // The ID number is sent to the provider only, never stored.
      const account = await provider.createDedicatedAccount(user, { idType, idNumber, ...req.body });
      user.dedicatedAccount = account;
      user.kyc.status = 'verified';
      user.kyc.verifiedAt = new Date();
      await user.save();
      await notify(user._id, {
        title: 'Funding account ready',
        body: `Transfer to ${account.accountNumber} (${account.bankName}) to fund your wallet.`,
        kind: 'wallet',
      });
    } else {
      await raiseAlert({
        type: 'new_user',
        title: 'KYC submitted',
        body: `${user.fullName} submitted KYC (${idType.toUpperCase()}). Funding accounts will be created once the payment provider is connected.`,
        user: user._id,
      });
    }
    const u = serialize.user(user);
    ok(res, { status: u.kyc.status, kyc: u.kyc, dedicatedAccount: u.dedicatedAccount }, 201);
  }),
);

module.exports = router;
