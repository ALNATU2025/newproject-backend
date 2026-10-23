// Bank and mobile money transfers through Cashwyre, for Sierra Leone
// accounts. Amounts in the API are major units.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { forbidden } = require('../utils/errors');
const cashwyre = require('../providers/cashwyre');
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

/** Countries, and whether bank and/or mobile money transfers work there. */
router.get(
  '/countries',
  asyncHandler(async (req, res) => ok(res, { connected: cashwyre.configured(), countries: cashwyre.configured() ? await payouts.payoutCountries() : [] })),
);

/** Banks (type=bank) or mobile money providers (type=mobile_money). */
router.get(
  '/banks',
  validate({ query: z.object({ country, type: accountType.default('bank') }) }),
  asyncHandler(async (req, res) => ok(res, await payouts.bankList(req.query.country, req.query.type))),
);

/** Account holder's name, where the country supports it. */
router.post(
  '/lookup',
  validate({ body: z.object({ country, bankCode: z.string().trim().min(1), accountNumber }) }),
  asyncHandler(async (req, res) => {
    let accountName = null;
    try {
      accountName = await cashwyre.accountLookup(req.body);
    } catch {
      accountName = null;
    }
    ok(res, { accountName, supported: Boolean(accountName) });
  }),
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
      accountName: z.string().trim().min(2, 'Enter the account holder\'s name').max(100),
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
