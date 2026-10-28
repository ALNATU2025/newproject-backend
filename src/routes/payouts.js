// Bank and mobile money transfers through Cashwyre, for Sierra Leone
// accounts. Amounts in the API are major units.
const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { forbidden } = require('../utils/errors');
const cashwyre = require('../providers/cashwyre');
const kuda = require('../providers/kuda');
const payouts = require('../services/payouts');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);
// Sierra Leone accounts only (they can send to any supported country).
router.use((req, res, next) =>
  next(req.user.country === 'SL' ? undefined : forbidden('Bank and mobile money transfers are for Sierra Leone accounts.', 'WRONG_COUNTRY')),
);

const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Choose a country');
const accountType = z.enum(['bank', 'mobile_money']);
const accountNumber = z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\+?\d{5,20}$/, 'Enter a valid account or mobile money number'));

// Stops scripts from checking thousands of account numbers (name lookups)
// or hammering prices, per signed-in user.
const perUser = (limit, windowMin) =>
  rateLimit({
    windowMs: windowMin * 60 * 1000,
    limit: env.isTest ? 10_000 : limit,
    keyGenerator: (req) => String(req.user._id),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please wait a few minutes and try again.' },
  });
router.use('/lookup', perUser(40, 10));
router.use(['/quote', '/fee'], perUser(60, 10));
router.use('/send', perUser(10, 10));

/** Countries, and whether bank and/or mobile money transfers work there. */
router.get(
  '/countries',
  asyncHandler(async (req, res) => {
    const connected = cashwyre.configured() || kuda.configured();
    ok(res, { connected, countries: connected ? await payouts.payoutCountries() : [] });
  }),
);

/** Banks (type=bank) or mobile money providers (type=mobile_money). */
router.get(
  '/banks',
  validate({ query: z.object({ country, type: accountType.default('bank') }) }),
  asyncHandler(async (req, res) => ok(res, await payouts.bankList(req.query.country, req.query.type))),
);

/** Account holder's name, where the bank / provider supports it. */
router.post(
  '/lookup',
  validate({ body: z.object({ country, bankCode: z.string().trim().min(1), accountNumber }) }),
  asyncHandler(async (req, res) => {
    const r = await payouts.lookupName(req.body);
    ok(res, { ...r, supported: r.verified });
  }),
);

/** Fee and rate preview while the customer types the amount. */
router.post(
  '/fee',
  // amount: what the recipient gets (their currency); or sendAmount: what
  // the sender pays in total (Leones), and the recipient's amount is worked out.
  validate({
    body: z
      .object({ country, amount: fields.amount.optional(), sendAmount: fields.amount.optional(), accountType: accountType.optional() })
      .refine((b) => b.amount !== undefined || b.sendAmount !== undefined, { message: 'Enter an amount', path: ['amount'] }),
  }),
  asyncHandler(async (req, res) => ok(res, await payouts.preview(req.user, req.body))),
);

/** What the transfer costs in the sender's currency, with a 10-minute quote. */
router.post(
  '/quote',
  validate({
    body: z.object({
      country,
      accountType,
      bankCode: z.string().trim().min(1),
      accountNumber,
      accountName: z.string().trim().min(2, 'Enter the account holder\'s name').max(100).optional(),
      amount: fields.amount,
      narration: z.string().trim().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => ok(res, await payouts.quote(req.user, req.body))),
);

router.post(
  '/send',
  validate({ body: z.object({ quoteToken: z.string().min(20), pin: fields.pin }) }),
  asyncHandler(async (req, res) => {
    const txn = await payouts.send(req.user, req.body);
    ok(res, { transaction: serialize.transaction(txn) }, 201);
  }),
);

module.exports = router;
