// Email one-time codes for registration, password reset and PIN reset.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { Otp } = require('../models');
const { numericCode } = require('../utils/helpers');
const { badRequest, tooMany } = require('../utils/errors');
const { sendMail, isMailConfigured, codeEmail } = require('./mail');

const TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 45 * 1000;
const MAX_ATTEMPTS = 5;

/**
 * Creates (or replaces) a code for this email/purpose and emails it.
 * Returns `{ devCode }` when email isn't configured outside production so
 * the app can be tested without SMTP.
 */
async function issueCode(email, purpose, payload = null) {
  const existing = await Otp.findOne({ email, purpose });
  if (existing && Date.now() - existing.updatedAt.getTime() < RESEND_AFTER_MS) {
    throw tooMany('Please wait a moment before requesting another code.');
  }
  const code = numericCode(6);
  const codeHash = await bcrypt.hash(code, 8);
  await Otp.findOneAndUpdate(
    { email, purpose },
    {
      $set: {
        codeHash,
        attempts: 0,
        payload: payload ?? (existing ? existing.payload : null),
        verifiedToken: null,
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    },
    { upsert: true, new: true },
  );
  const { subject, text } = codeEmail(code, purpose);
  try {
    await sendMail({ to: email, subject, text });
  } catch (err) {
    // Not sent: put things back so the person can try again straight away.
    if (existing) {
      await Otp.updateOne(
        { _id: existing._id },
        {
          $set: {
            codeHash: existing.codeHash,
            attempts: existing.attempts,
            payload: existing.payload,
            verifiedToken: existing.verifiedToken,
            expiresAt: existing.expiresAt,
            updatedAt: new Date(0),
          },
        },
        { timestamps: false },
      );
    } else {
      await Otp.deleteOne({ email, purpose });
    }
    throw err;
  }
  const exposeCode = !env.isProd && !isMailConfigured();
  return exposeCode ? { devCode: code } : {};
}

/** Checks a code. Returns the Otp document (with payload) when correct. */
async function checkCode(email, purpose, code) {
  const otp = await Otp.findOne({ email, purpose });
  if (!otp || otp.expiresAt < new Date()) {
    throw badRequest('This code has expired. Please request a new one.', 'CODE_EXPIRED');
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    throw tooMany('Too many wrong codes. Please request a new one.');
  }
  const okCode = await bcrypt.compare(code, otp.codeHash);
  if (!okCode) {
    otp.attempts += 1;
    await otp.save();
    throw badRequest('Incorrect code. Please check and try again.', 'CODE_INVALID');
  }
  return otp;
}

/** After a correct code, issues a short-lived token for the next step. */
async function markVerified(otp) {
  const token = crypto.randomBytes(24).toString('hex');
  otp.verifiedToken = token;
  otp.expiresAt = new Date(Date.now() + TTL_MS);
  await otp.save();
  return token;
}

async function consumeVerifiedToken(purpose, token) {
  const otp = await Otp.findOne({ purpose, verifiedToken: token });
  if (!otp || otp.expiresAt < new Date()) {
    throw badRequest('This reset link has expired. Please start again.', 'TOKEN_EXPIRED');
  }
  await Otp.deleteOne({ _id: otp._id });
  return otp;
}

async function deleteCode(email, purpose) {
  await Otp.deleteOne({ email, purpose });
}

/**
 * Keeps sign-up details while the person proves their phone with an SMS
 * code sent by Firebase (no email code is sent). Valid for 30 minutes.
 */
async function savePending(email, purpose, payload) {
  const codeHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 4);
  await Otp.findOneAndUpdate(
    { email, purpose },
    { $set: { codeHash, attempts: 0, payload, verifiedToken: null, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } },
    { upsert: true },
  );
}

/** The saved sign-up details, or null when expired / never started. */
async function pendingPayload(email, purpose) {
  const otp = await Otp.findOne({ email, purpose });
  if (!otp || otp.expiresAt < new Date()) return null;
  return otp.payload || null;
}

module.exports = { issueCode, checkCode, markVerified, consumeVerifiedToken, deleteCode, savePending, pendingPayload };
