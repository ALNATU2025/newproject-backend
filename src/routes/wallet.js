// Wallet: balance, adding money, sending money, checking a transfer.
const express = require('express');
const { Transaction } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { validate, z, fields } = require('../middleware/validate');
const { asyncHandler, ok, makeReference } = require('../utils/helpers');
const { toKobo, toNaira, percentOf } = require('../utils/money');
const { badRequest } = require('../utils/errors');
const { paymentProvider } = require('../providers/payment');
const { verifyPin } = require('../services/pin');
const { getSettings } = require('../services/settings');
const { raiseAlert } = require('../services/alerts');
const { creditDeposit } = require('../services/funding');
const { findRecipient, executeTransfer } = require('../services/transfer');
const { fmt } = require('../services/limits');
const serialize = require('../serializers');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    ok(res, {
      balance: toNaira(req.user.balance),
      commissionBalance: toNaira(req.user.commissionBalance),
      dedicatedAccount: serialize.user(req.user).dedicatedAccount,
      kycStatus: req.user.kyc.status,
      fundingFeePercent: settings.fundingFeePercent,
      minFunding: toNaira(settings.minFunding),
      maxFunding: toNaira(settings.maxFunding),
      bankTransferAvailable: paymentProvider().isConfigured(),
    });
  }),
);

async function checkFundingAmount(amount) {
  const s = await getSettings();
  if (amount < s.minFunding || amount > s.maxFunding) {
    throw badRequest(`Enter an amount between ${fmt(s.minFunding)} and ${fmt(s.maxFunding)}.`, 'AMOUNT_OUT_OF_RANGE');
  }
  return s;
}

/** One-time account for an exact amount (expires after 30 minutes). */
router.post(
  '/fund/one-time',
  validate({ body: z.object({ amount: fields.amount, pin: fields.pin }) }),
  asyncHandler(async (req, res) => {
    const amount = toKobo(req.body.amount);
    const settings = await checkFundingAmount(amount);
    await verifyPin(req.user._id, req.body.pin);
    const reference = makeReference('WF');
    const account = await paymentProvider().createOneTimeAccount({ user: req.user, reference, amount });
    const fee = percentOf(amount, settings.fundingFeePercent);
    const txn = await Transaction.create({
      user: req.user._id,
      reference,
      type: 'wallet_funding',
      direction: 'credit',
      amount,
      fee,
      status: 'pending',
      description: 'Wallet top-up · One-time account',
      metadata: {
        method: 'one_time',
        accountNumber: account.accountNumber,
        bankName: account.bankName,
        accountName: account.accountName,
        expiresAt: account.expiresAt,
      },
    });
    ok(res, {
      transaction: serialize.transaction(txn),
      account: {
        bankName: account.bankName,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        amountToPay: toNaira(amount),
        fee: toNaira(fee),
        youReceive: toNaira(amount - fee),
        reference,
        expiresAt: account.expiresAt,
      },
    });
  }),
);

/** Ask the team to fund the wallet manually (admin approves it). */
router.post(
  '/fund/assisted',
  validate({ body: z.object({ amount: fields.amount, pin: fields.pin, note: z.string().max(200).optional() }) }),
  asyncHandler(async (req, res) => {
    const amount = toKobo(req.body.amount);
    await checkFundingAmount(amount);
    await verifyPin(req.user._id, req.body.pin);
    const txn = await Transaction.create({
      user: req.user._id,
      reference: makeReference('AF'),
      type: 'wallet_funding',
      direction: 'credit',
      amount,
      status: 'pending',
      description: 'Wallet top-up · Assisted',
      metadata: { method: 'assisted', note: req.body.note || null },
    });
    await raiseAlert({
      type: 'wallet',
      severity: 'warning',
      title: 'Assisted funding requested',
      body: `${req.user.fullName} asked for help funding ${fmt(amount)}. Approve it in Status Update once paid.`,
      user: req.user._id,
      transaction: txn._id,
    });
    ok(res, { transaction: serialize.transaction(txn) }, 201);
  }),
);

/** Find who you're sending to (shows their name before you pay). */
router.post(
  '/transfer/lookup',
  validate({
    body: z
      .object({ phone: fields.phone.optional(), email: fields.email.optional() })
      .refine((v) => v.phone || v.email, { message: 'Enter a phone number or email' }),
  }),
  asyncHandler(async (req, res) => {
    const recipient = await findRecipient(req.body);
    if (String(recipient._id) === String(req.user._id)) {
      throw badRequest('This is your own account.', 'SELF_TRANSFER');
    }
    ok(res, { fullName: recipient.fullName });
  }),
);

router.post(
  '/transfer',
  validate({
    body: z
      .object({
        phone: fields.phone.optional(),
        email: fields.email.optional(),
        amount: fields.amount,
        note: z.string().trim().max(60).optional(),
        pin: fields.pin,
      })
      .refine((v) => v.phone || v.email, { message: 'Enter a phone number or email' }),
  }),
  asyncHandler(async (req, res) => {
    const recipient = await findRecipient(req.body);
    const txn = await executeTransfer({
      sender: req.user,
      recipient,
      amount: toKobo(req.body.amount),
      note: req.body.note,
      pin: req.body.pin,
    });
    ok(res, { transaction: serialize.transaction(txn) }, 201);
  }),
);

/** "Transfer hasn't arrived?" — look up a funding payment by reference. */
router.post(
  '/verify-payment',
  validate({ body: z.object({ reference: z.string().trim().min(6, 'Reference is too short').max(80) }) }),
  asyncHandler(async (req, res) => {
    const ref = req.body.reference;
    const txn = await Transaction.findOne({
      user: req.user._id,
      type: 'wallet_funding',
      $or: [{ reference: ref }, { providerReference: ref }],
    });
    if (!txn) return ok(res, { status: 'not_found', transaction: null });
    if (txn.status === 'pending' && txn.metadata && txn.metadata.method === 'one_time') {
      const result = await paymentProvider().verifyTransfer(txn.reference);
      if (result.status === 'success') {
        const { transaction } = await creditDeposit({
          userId: req.user._id,
          amount: result.amount || txn.amount,
          method: 'one_time',
          providerReference: result.providerReference || null,
          pendingTxn: txn,
        });
        return ok(res, { status: 'success', transaction: serialize.transaction(transaction) });
      }
    }
    return ok(res, { status: txn.status, transaction: serialize.transaction(txn) });
  }),
);

/** Recent top-ups for the validation screen. */
router.get(
  '/fundings',
  asyncHandler(async (req, res) => {
    const items = await Transaction.find({ user: req.user._id, type: 'wallet_funding' })
      .sort({ createdAt: -1 })
      .limit(10);
    const [verified, pending] = await Promise.all([
      Transaction.countDocuments({ user: req.user._id, type: 'wallet_funding', status: 'success' }),
      Transaction.countDocuments({ user: req.user._id, type: 'wallet_funding', status: 'pending' }),
    ]);
    ok(res, { items: items.map((t) => serialize.transaction(t)), verified, pending });
  }),
);

module.exports = router;
