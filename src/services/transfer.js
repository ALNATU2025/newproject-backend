// Wallet-to-wallet transfers between Dalabapay users.
const { Transaction, User } = require('../models');
const { badRequest, notFound } = require('../utils/errors');
const { makeReference } = require('../utils/helpers');
const { withTransaction } = require('../config/db');
const wallet = require('./wallet');
const { verifyPin } = require('./pin');
const { notify } = require('./notify');
const { getSettings } = require('./settings');
const { assertServiceOpen, assertCanTransact, assertWithinLimits, fmt } = require('./limits');

async function findRecipient({ phone, email }) {
  const query = phone ? { phone } : { email: String(email).toLowerCase() };
  const user = await User.findOne(query).select('fullName phone email isActive');
  if (!user || !user.isActive) {
    throw notFound('No Dalabapay account found with these details.', 'RECIPIENT_NOT_FOUND');
  }
  return user;
}

async function executeTransfer({ sender, recipient, amount, note, pin }) {
  if (String(recipient._id) === String(sender._id)) {
    throw badRequest('You can\'t send money to yourself.', 'SELF_TRANSFER');
  }
  const settings = await getSettings();
  assertServiceOpen('transfer', settings);
  assertCanTransact(sender, settings);
  await assertWithinLimits(sender, 'transfer', amount, settings);
  await verifyPin(sender._id, pin);

  const reference = makeReference('TR');
  const fee = settings.transferFee || 0;

  const { outTxn } = await withTransaction(async (session) => {
    const debited = await wallet.debit(sender._id, amount + fee, { session });
    let credited;
    try {
      credited = await wallet.credit(recipient._id, amount, { session });
    } catch (e) {
      if (!session) await wallet.credit(sender._id, amount + fee); // compensate
      throw e;
    }
    const [o] = await Transaction.create(
      [
        {
          user: sender._id,
          reference,
          type: 'transfer_out',
          direction: 'debit',
          amount,
          fee,
          status: 'success',
          description: `Sent to ${recipient.fullName}`,
          recipient: recipient.phone,
          counterparty: recipient._id,
          balanceBefore: debited.before,
          balanceAfter: debited.after,
          metadata: { note: note || null, recipientName: recipient.fullName },
        },
      ],
      { session },
    );
    await Transaction.create(
      [
        {
          user: recipient._id,
          reference: `${reference}-IN`,
          type: 'transfer_in',
          direction: 'credit',
          amount,
          status: 'success',
          description: `Received from ${sender.fullName}`,
          recipient: sender.phone,
          counterparty: sender._id,
          balanceBefore: credited.before,
          balanceAfter: credited.after,
          relatedTransaction: o._id,
          metadata: { note: note || null, senderName: sender.fullName },
        },
      ],
      { session },
    );
    return { outTxn: o };
  });

  await notify(recipient._id, {
    title: 'Money received',
    body: `${sender.fullName} sent you ${fmt(amount)}.${note ? ` Note: ${note}` : ''}`,
    kind: 'wallet',
  });
  await notify(sender._id, {
    title: 'Money sent',
    body: `You sent ${fmt(amount)} to ${recipient.fullName}.`,
    kind: 'wallet',
    data: { transactionId: String(outTxn._id) },
  });
  return outTxn;
}

module.exports = { findRecipient, executeTransfer };
