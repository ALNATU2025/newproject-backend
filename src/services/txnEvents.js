// Tells admins (push + webhook) about each new transaction, credit or
// debit. Switch off in Admin → Settings (adminNotify.transactions).
const { User } = require('../models');
const { formatMoney } = require('../utils/money');
const { getSettings } = require('./settings');
const { notifyAdmins } = require('./push');

async function onNewTransaction(t) {
  const settings = await getSettings();
  if (!settings.adminNotify || settings.adminNotify.transactions === false) return;
  const user = await User.findById(t.user).select('fullName country');
  const credit = t.direction === 'credit';
  const amount = formatMoney(t.amount, t.currency || (user && user.country === 'SL' ? 'SLE' : 'NGN'));
  await notifyAdmins({
    event: credit ? 'transaction.credit' : 'transaction.debit',
    title: `${credit ? 'Credit' : 'Debit'} ${amount} · ${t.status}`,
    body: `${user ? user.fullName : 'A user'}: ${t.description || t.type} (${t.reference})`,
    data: {
      transactionId: String(t._id),
      reference: t.reference,
      type: t.type,
      direction: t.direction,
      status: t.status,
      amount: t.amount / 100,
      currency: t.currency,
      userId: String(t.user),
    },
  });
}

module.exports = { onNewTransaction };
