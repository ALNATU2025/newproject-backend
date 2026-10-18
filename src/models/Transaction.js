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

    // kobo
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

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ user: 1, service: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
