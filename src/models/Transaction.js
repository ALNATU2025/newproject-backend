const mongoose = require('mongoose');
const { TXN_TYPES, TXN_STATUSES } = require('./constants');

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reference: { type: String, required: true, unique: true },
    type: { type: String, enum: TXN_TYPES, required: true, index: true },
    // Which wallet moved: main balance or commission balance.
    wallet: { type: String, enum: ['main', 'commission'], default: 'main' },
    direction: { type: String, enum: ['credit', 'debit'], required: true },

    // Currency of the amounts (the owner's country currency).
    currency: { type: String, enum: ['NGN', 'SLE'], default: null, index: true },

    // minor units (kobo / cents)
    amount: { type: Number, required: true, min: 0 },
    fee: { type: Number, default: 0 },
    commission: { type: Number, default: 0 }, // paid to the user for this purchase
    platformRevenue: { type: Number, default: 0 }, // Dalabapay margin

    status: { type: String, enum: TXN_STATUSES, default: 'pending', index: true },
    statusBeforeDispute: { type: String, default: null },
    description: { type: String, default: '' },

    // Bill payment details
    service: { type: String, default: null, index: true },
    recipient: { type: String, default: null }, // phone / meter / smartcard / profile
    provider: { type: String, default: null }, // e.g. simulator, vtpass
    providerReference: { type: String, default: null, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    balanceBefore: { type: Number, default: null },
    balanceAfter: { type: Number, default: null },

    counterparty: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    relatedTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    refunded: { type: Boolean, default: false },

    // Admin actions
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    adminNote: { type: String, default: null },
  },
  { timestamps: true },
);

// Every transaction is in its owner's currency; filled in automatically.
transactionSchema.pre('validate', async function setCurrency() {
  if (this.currency || !this.user) return;
  const User = mongoose.model('User');
  const owner = await User.findById(this.user).select('country').session(this.$session() || null).lean();
  this.currency = owner && owner.country === 'SL' ? 'SLE' : 'NGN';
});

// Admins hear about every new credit and debit (push + webhook).
transactionSchema.pre('save', function rememberNew() {
  this.$locals.wasNew = this.isNew;
});
transactionSchema.post('save', function tellAdmins(doc) {
  if (!doc.$locals.wasNew) return;
  // eslint-disable-next-line global-require
  setImmediate(() => require('../services/txnEvents').onNewTransaction(doc).catch(() => {}));
});

// Remember the owner's latest transaction (for "last used" in Admin).
transactionSchema.post('save', function noteLastTransaction(doc) {
  if (!doc || !doc.user || doc.wallet === 'commission' && doc.type === 'commission') return;
  if (['admin_credit', 'admin_debit', 'refund', 'commission', 'referral_bonus'].includes(doc.type)) return;
  mongoose
    .model('User')
    .updateOne({ _id: doc.user, $or: [{ lastTransactionAt: null }, { lastTransactionAt: { $lt: doc.createdAt } }] }, { $set: { lastTransactionAt: doc.createdAt } })
    .catch(() => {});
});

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ user: 1, service: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
