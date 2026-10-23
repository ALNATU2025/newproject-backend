// Virtual dollar cards through Cashwyre. Prices are shown in the
// customer's currency; card balances are in US dollars.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const { forbidden } = require('../utils/errors');
const { getSettings } = require('../services/settings');
const cards = require('../services/cards');
const serialize = require('../serializers');
const { Transaction } = require('../models');

const router = express.Router();
router.use(requireAuth);
// Sierra Leone accounts only.
router.use((req, res, next) =>
  next(req.user.country === 'SL' ? undefined : forbidden('Dollar cards are for Sierra Leone accounts.', 'WRONG_COUNTRY')),
);

const usd = z.coerce.number({ invalid_type_error: 'Enter an amount in dollars' }).positive('Enter an amount in dollars').max(10_000);
const idParam = validate({ params: z.object({ id: fields.objectId }) });

/** Limits, fees and the ID types this country accepts. */
router.get('/config', asyncHandler(async (req, res) => ok(res, cards.config(req.user, await getSettings()))));

/** Price in the customer's currency for create / topup / withdraw. */
router.get(
  '/quote',
  validate({ query: z.object({ action: z.enum(['create', 'topup', 'withdraw']), amountUsd: usd }) }),
  asyncHandler(async (req, res) => ok(res, cards.publicPrice(await cards.price(req.user, req.query.action, req.query.amountUsd)))),
);

router.get('/', asyncHandler(async (req, res) => ok(res, (await cards.list(req.user)).map(serialize.card))));

router.post(
  '/',
  validate({
    body: z.object({
      amountUsd: usd,
      brand: z.enum(['Visa', 'Mastercard']).default('Visa'),
      cardName: z.string().trim().min(2).max(40).optional(),
      dateOfBirth: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth'),
      homeAddressNumber: z.string().trim().min(1, 'Enter your house number').max(20),
      homeAddress: z.string().trim().min(5, 'Enter your home address').max(200),
      idType: z.string().trim().min(2),
      idNumber: z.string().trim().min(4, 'Enter your ID number').max(30),
      idImageBase64: z.string().max(6_000_000, 'The ID photo is too large').optional(),
      pin: fields.pin,
    }),
  }),
  asyncHandler(async (req, res) => {
    const card = await cards.create(req.user, req.body);
    const txn = await Transaction.findById(card.createTransaction);
    ok(res, { card: serialize.card(card), transaction: serialize.transaction(txn) }, 201);
  }),
);

router.post(
  '/:id/reveal',
  idParam,
  validate({ body: z.object({ pin: fields.pin }) }),
  asyncHandler(async (req, res) => ok(res, await cards.reveal(req.user, req.params.id, req.body.pin))),
);

router.post(
  '/:id/topup',
  idParam,
  validate({ body: z.object({ amountUsd: usd, pin: fields.pin }) }),
  asyncHandler(async (req, res) => ok(res, { transaction: serialize.transaction(await cards.topup(req.user, req.params.id, req.body)) }, 201)),
);

router.post(
  '/:id/withdraw',
  idParam,
  validate({ body: z.object({ amountUsd: usd, pin: fields.pin }) }),
  asyncHandler(async (req, res) => ok(res, { transaction: serialize.transaction(await cards.withdraw(req.user, req.params.id, req.body)) }, 201)),
);

router.post('/:id/freeze', idParam, asyncHandler(async (req, res) => ok(res, serialize.card(await cards.setFrozen(req.user, req.params.id, true)))));
router.post('/:id/unfreeze', idParam, asyncHandler(async (req, res) => ok(res, serialize.card(await cards.setFrozen(req.user, req.params.id, false)))));

router.get('/:id/transactions', idParam, asyncHandler(async (req, res) => ok(res, await cards.history(req.user, req.params.id))));

module.exports = router;
