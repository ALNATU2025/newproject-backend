const mongoose = require('mongoose');
const { NOTIFICATION_KINDS, DISPUTE_TYPES, ALERT_TYPES } = require('./constants');

const User = require('./User');
const Transaction = require('./Transaction');

const { Schema } = mongoose;

/** In-app notification for one user. */
const Notification = mongoose.model(
  'Notification',
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      title: { type: String, required: true },
      body: { type: String, required: true },
      kind: { type: String, enum: NOTIFICATION_KINDS, default: 'general' },
      read: { type: Boolean, default: false, index: true },
      data: { type: Schema.Types.Mixed, default: {} },
      broadcast: { type: Schema.Types.ObjectId, ref: 'Broadcast', default: null },
    },
    { timestamps: true },
  ),
);

/** Dispute raised by a user against one of their transactions. */
const Dispute = mongoose.model(
  'Dispute',
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      transaction: { type: Schema.Types.ObjectId, ref: 'Transaction', required: true, index: true },
      type: { type: String, enum: DISPUTE_TYPES, required: true },
      reason: { type: String, required: true, maxlength: 200 },
      description: { type: String, default: '', maxlength: 2000 },
      status: {
        type: String,
        enum: ['pending', 'investigating', 'resolved', 'rejected'],
        default: 'pending',
        index: true,
      },
      resolution: { type: String, default: null },
      refundAmount: { type: Number, default: 0 },
      resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      resolvedAt: { type: Date, default: null },
    },
    { timestamps: true },
  ),
);

/** One-time codes: email verification, password reset, PIN reset. */
const Otp = mongoose.model(
  'Otp',
  new Schema(
    {
      email: { type: String, required: true, lowercase: true, index: true },
      purpose: { type: String, enum: ['register', 'reset_password', 'reset_pin'], required: true },
      codeHash: { type: String, required: true },
      attempts: { type: Number, default: 0 },
      payload: { type: Schema.Types.Mixed, default: null }, // pending registration
      verifiedToken: { type: String, default: null }, // issued after a correct code
      expiresAt: { type: Date, required: true, index: { expires: 0 } },
    },
    { timestamps: true },
  ),
);

/** Admin activity feed (new users, funding, suspicious activity…). */
const AdminAlert = mongoose.model(
  'AdminAlert',
  new Schema(
    {
      type: { type: String, enum: ALERT_TYPES, required: true, index: true },
      severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
      title: { type: String, required: true },
      body: { type: String, required: true },
      user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      transaction: { type: Schema.Types.ObjectId, ref: 'Transaction', default: null },
      readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    },
    { timestamps: true },
  ),
);

/** Every admin change, for the user history page and accountability. */
const AuditLog = mongoose.model(
  'AuditLog',
  new Schema(
    {
      actor: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      action: { type: String, required: true },
      targetUser: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
      transaction: { type: Schema.Types.ObjectId, ref: 'Transaction', default: null },
      details: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true },
  ),
);

/** A message sent by an admin to many users. */
const Broadcast = mongoose.model(
  'Broadcast',
  new Schema(
    {
      sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      title: { type: String, required: true },
      message: { type: String, required: true },
      type: { type: String, default: 'announcement' },
      audience: { type: String, enum: ['all', 'selected'], required: true },
      recipients: { type: Number, default: 0 },
    },
    { timestamps: true },
  ),
);

/** Single document holding app-wide settings (see services/settings.js). */
const Setting = mongoose.model(
  'Setting',
  new Schema(
    {
      key: { type: String, required: true, unique: true, default: 'global' },
      value: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true, minimize: false },
  ),
);

/**
 * A virtual dollar card issued through Cashwyre. The full card number and
 * CVV are never stored: they're fetched from Cashwyre when the owner asks.
 */
const Card = mongoose.model(
  'Card',
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      // Cashwyre's card code; null until the card has been created.
      cardCode: { type: String, default: null, index: { unique: true, partialFilterExpression: { cardCode: { $type: 'string' } } } },
      status: { type: String, enum: ['creating', 'active', 'frozen', 'terminated', 'failed'], default: 'creating', index: true },
      brand: { type: String, default: 'Visa' },
      name: { type: String, default: '' },
      last4: { type: String, default: null },
      validMonthYear: { type: String, default: null },
      balanceUsd: { type: Number, default: 0 }, // cents
      createTransaction: { type: Schema.Types.ObjectId, ref: 'Transaction', default: null },
      lastSyncedAt: { type: Date, default: null },
      failureReason: { type: String, default: null },
    },
    { timestamps: true },
  ),
);

/**
 * A Sierra Leone customer's request to move up an account level, with the
 * documents for an admin to review. Images are kept as base64 and only
 * loaded when an admin opens the request.
 */
const KycRequest = mongoose.model(
  'KycRequest',
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      tier: { type: Number, enum: [2, 3, 4], required: true },
      status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
      details: { type: Schema.Types.Mixed, default: {} },
      files: {
        type: [{ _id: false, label: String, mime: String, data: String }],
        default: [],
        select: false,
      },
      reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      reviewedAt: { type: Date, default: null },
      rejectionReason: { type: String, default: null },
    },
    { timestamps: true },
  ),
);

/** A phone that receives push notifications (Firebase Cloud Messaging). */
const Device = mongoose.model(
  'Device',
  new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
      token: { type: String, required: true, unique: true },
      platform: { type: String, default: 'android' },
      lastSeenAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
  ),
);

module.exports = {
  KycRequest,
  Device,
  Card,
  User,
  Transaction,
  Notification,
  Dispute,
  Otp,
  AdminAlert,
  AuditLog,
  Broadcast,
  Setting,
};
