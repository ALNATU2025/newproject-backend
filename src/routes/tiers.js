// Sierra Leone account levels: see the limits and ask for an upgrade.
//   GET  /api/tiers           current tier, limits, usage, requests
//   POST /api/tiers/upgrade   { tier: 2|3|4, ...details, files }
// An admin reviews each request (Admin → KYC Review).
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { badRequest, conflict, forbidden } = require('../utils/errors');
const { KycRequest } = require('../models');
const { getSettings } = require('../services/settings');
const tiers = require('../services/tiers');
const { raiseAlert } = require('../services/alerts');
const { notify } = require('../services/notify');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) =>
  next(req.user.country === 'SL' ? undefined : forbidden('Account levels are for Sierra Leone accounts.', 'WRONG_COUNTRY')),
);

const MAX_IMAGE = 3_000_000; // base64 characters (~2.2 MB)
const image = z
  .string()
  .max(MAX_IMAGE, 'The photo is too large. Please use a smaller one.')
  .transform((v) => v.replace(/^data:[^;]+;base64,/, ''))
  .refine((v) => /^[A-Za-z0-9+/=\s]+$/.test(v) && v.length > 100, 'Add a clear photo');

const DOC_TYPES = { nin: 'NIN', national_id: 'National ID card', passport: 'Passport', voters_card: "Voter's card", drivers_licence: "Driver's licence" };

const upgradeBody = z.discriminatedUnion('tier', [
  z.object({
    tier: z.literal(2),
    docType: z.enum(Object.keys(DOC_TYPES)),
    docNumber: z.string().trim().min(4, 'Enter the document number').max(40),
    front: image,
    back: image.optional(),
    selfie: image.optional(),
  }),
  z.object({
    tier: z.literal(3),
    bankName: z.string().trim().min(2, 'Enter the bank name').max(80),
    accountNumber: z.string().trim().regex(/^[0-9 -]{6,24}$/, 'Enter a valid account number'),
    accountName: z.string().trim().min(2, 'Enter the account name').max(100),
    statement: image.optional(),
  }),
  z.object({
    tier: z.literal(4),
    businessName: z.string().trim().min(2, 'Enter the business name').max(120),
    registrationNumber: z.string().trim().min(3, 'Enter the registration / licence number').max(60),
    businessAddress: z.string().trim().min(5, 'Enter the business address').max(200),
    licence: image,
  }),
]);

function publicRequest(r) {
  return {
    id: String(r._id),
    tier: r.tier,
    status: r.status,
    rejectionReason: r.rejectionReason || null,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt || null,
  };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const [requests, spent] = await Promise.all([
      KycRequest.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(20),
      tiers.spentToday(req.user._id),
    ]);
    const tier = tiers.tierOf(req.user);
    const limits = tiers.tierLimits(settings, tier);
    ok(res, {
      ...tiers.describe(req.user, settings),
      approvalNote: req.user.approvalNote || null,
      spentToday: spent / 100,
      leftToday: limits.daily == null ? null : Math.max(0, limits.daily - spent) / 100,
      balance: (req.user.balance || 0) / 100,
      requests: requests.map(publicRequest),
      docTypes: Object.entries(DOC_TYPES).map(([id, name]) => ({ id, name })),
    });
  }),
);

router.post(
  '/upgrade',
  validate({ body: upgradeBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const current = tiers.tierOf(req.user);
    if (!req.user.isApproved) throw forbidden('Your account must be approved before you can upgrade.', 'ACCOUNT_PENDING_APPROVAL');
    if (b.tier <= current) throw badRequest(`You're already on Tier ${current}.`, 'ALREADY_ON_TIER');
    if (b.tier !== current + 1) throw badRequest(`Complete Tier ${current + 1} first.`, 'TIER_ORDER');
    if (await KycRequest.exists({ user: req.user._id, status: 'pending' })) {
      throw conflict('Your last upgrade request is still being reviewed.', 'REQUEST_PENDING');
    }
    let details;
    let files;
    if (b.tier === 2) {
      details = { docType: b.docType, docTypeName: DOC_TYPES[b.docType], docNumber: b.docNumber };
      files = [
        { label: 'Document (front)', data: b.front },
        ...(b.back ? [{ label: 'Document (back)', data: b.back }] : []),
        ...(b.selfie ? [{ label: 'Selfie', data: b.selfie }] : []),
      ];
    } else if (b.tier === 3) {
      details = { bankName: b.bankName, accountNumber: b.accountNumber.replace(/[\s-]/g, ''), accountName: b.accountName };
      files = b.statement ? [{ label: 'Bank statement / proof', data: b.statement }] : [];
    } else {
      details = { businessName: b.businessName, registrationNumber: b.registrationNumber, businessAddress: b.businessAddress };
      files = [{ label: 'Business licence', data: b.licence }];
    }
    const r = await KycRequest.create({
      user: req.user._id,
      tier: b.tier,
      details,
      files: files.map((f) => ({ ...f, mime: 'image/jpeg' })),
    });
    await raiseAlert({
      type: 'kyc',
      severity: 'warning',
      title: `Tier ${b.tier} upgrade to review`,
      body: `${req.user.fullName} (${req.user.phone}) asked for Tier ${b.tier}. Review it in Admin → KYC Review.`,
      user: req.user._id,
    });
    await notify(req.user._id, {
      title: 'Upgrade request received',
      body: `We're reviewing your Tier ${b.tier} request. We'll let you know when it's done.`,
      kind: 'security',
    });
    ok(res, publicRequest(r), 201);
  }),
);

module.exports = router;
