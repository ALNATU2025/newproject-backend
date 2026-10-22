const mongoose = require('mongoose');
const { ROLES, COUNTRY_CODES } = require('./constants');

const limitSchema = new mongoose.Schema(
  {
    // kobo; null = unlimited
    perTxn: { type: Number, default: null },
    daily: { type: Number, default: null },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    emailVerified: { type: Boolean, default: false },

    // NG or SL. Decides the services, currency and dashboard the user sees.
    // Accounts made before countries existed are Nigerian.
    country: { type: String, enum: COUNTRY_CODES, default: 'NG', index: true },

    role: { type: String, enum: ROLES, default: 'user', index: true },
    isActive: { type: Boolean, default: true },
    isApproved: { type: Boolean, default: true },

    // Payment PIN (6 digits, hashed). Locked for 30 min after 5 wrong tries.
    pinHash: { type: String, default: null, select: false },
    pinSet: { type: Boolean, default: false },
    pinFailedAttempts: { type: Number, default: 0 },
    pinLockedUntil: { type: Date, default: null },

    // Wallets in kobo. Never go below 0 (enforced by conditional updates).
    balance: { type: Number, default: 0, min: 0 },
    commissionBalance: { type: Number, default: 0, min: 0 },
    lifetimeCommission: { type: Number, default: 0 },
    commissionWithdrawn: { type: Number, default: 0 },

    referralCode: { type: String, unique: true, sparse: true, uppercase: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    referralEarnings: {
      direct: { type: Number, default: 0 },
      indirect: { type: Number, default: 0 },
      welcome: { type: Number, default: 0 },
    },
    firstDepositRewarded: { type: Boolean, default: false },

    kyc: {
      status: { type: String, enum: ['none', 'pending', 'verified', 'rejected'], default: 'none' },
      idType: { type: String, enum: ['bvn', 'nin', null], default: null },
      idLast4: { type: String, default: null },
      dateOfBirth: { type: String, default: null },
      gender: { type: String, default: null },
      address: { type: String, default: null },
      submittedAt: { type: Date, default: null },
      verifiedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null },
    },
    dedicatedAccount: {
      accountNumber: { type: String, default: null },
      accountName: { type: String, default: null },
      bankName: { type: String, default: null },
      providerRef: { type: String, default: null },
    },

    preferences: {
      biometricEnabled: { type: Boolean, default: false },
      pushEnabled: { type: Boolean, default: true },
    },

    // Per-user overrides of the system default limits, keyed by service.
    limits: { type: Map, of: limitSchema, default: undefined },

    // Bumped on password change / admin logout so old tokens stop working.
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ 'dedicatedAccount.accountNumber': 1 }, { sparse: true });

userSchema.methods.isPinLocked = function isPinLocked() {
  return Boolean(this.pinLockedUntil && this.pinLockedUntil > new Date());
};

userSchema.methods.isAdmin = function isAdmin() {
  return this.role !== 'user';
};

module.exports = mongoose.model('User', userSchema);
