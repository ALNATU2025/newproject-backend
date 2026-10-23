// Sign up (with email code), login (email or phone), password and PIN.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { User } = require('../models');
const { validate, z, fields } = require('../middleware/validate');
const { requireAuth, signToken } = require('../middleware/auth');
const { asyncHandler, ok, referralCodeFor } = require('../utils/helpers');
const { badRequest, unauthorized, conflict, forbidden } = require('../utils/errors');
const otp = require('../services/otp');
const pinService = require('../services/pin');
const { raiseAlert } = require('../services/alerts');
const { notify } = require('../services/notify');
const serialize = require('../serializers');
const { COUNTRY_CODES, COUNTRIES } = require('../models/constants');
const { normalizePhone, anyLocal, PHONE_HINT, toE164 } = require('../utils/phone');
const { verifyIdToken } = require('../services/firebase');
const twilio = require('../services/twilioVerify');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isTest ? 1000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many attempts. Please try again in a few minutes.' },
});
router.use(authLimiter);

function session(user) {
  return { token: signToken(user), user: serialize.user(user) };
}

async function uniqueReferralCode(fullName) {
  for (let i = 0; i < 6; i++) {
    const code = referralCodeFor(fullName);
    // eslint-disable-next-line no-await-in-loop
    if (!(await User.exists({ referralCode: code }))) return code;
  }
  return `${referralCodeFor(fullName)}${Date.now() % 1000}`;
}

// ── Sign up ────────────────────────────────────────────────

const registerSchema = z
  .object({
    fullName: fields.name,
    email: fields.email,
    // NG or SL; older app versions don't send it and are Nigerian.
    country: z.enum(COUNTRY_CODES).default('NG'),
    phone: z.string().trim().min(6, 'Enter your phone number').max(20),
    password: fields.password,
    referralCode: z.string().trim().toUpperCase().max(20).optional().or(z.literal('')),
  })
  .transform((v, ctx) => {
    const phone = normalizePhone(v.phone, v.country);
    if (!phone) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phone'], message: PHONE_HINT[v.country] });
    return { ...v, phone: phone || v.phone };
  });

/** Step 1: check details and email a 6-digit code. Nothing is saved yet. */
router.post(
  '/register',
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { fullName, email, phone, password, referralCode, country } = req.body;
    if (await User.exists({ email })) throw conflict('This email address is already registered.', 'EMAIL_TAKEN');
    if (await User.exists({ phone })) throw conflict('This phone number is already registered.', 'PHONE_TAKEN');
    let referrerId = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode }).select('_id country');
      if (!referrer) throw badRequest('This referral code doesn\'t exist.', 'INVALID_REFERRAL');
      if ((referrer.country || 'NG') !== country) {
        throw badRequest('This referral code is from another country.', 'INVALID_REFERRAL');
      }
      referrerId = String(referrer._id);
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const payload = { fullName, email, phone, passwordHash, referrerId, country };
    const method = verificationFor(country);
    if (method === 'firebase') {
      // The person picks SMS or email in the app; Firebase sends it and the
      // app comes back with /register/verify-phone or /verify-email-link.
      await otp.savePending(email, 'register', payload);
      return ok(res, {
        email,
        verification: 'choose',
        options: ['sms', 'email_link'],
        phoneE164: toE164(phone, country),
        message: 'Choose how to verify your account.',
      });
    }
    if (method === 'twilio') {
      // Our server texts the code (Twilio Verify); the app shows the code
      // boxes and comes back with /register/verify-sms.
      await otp.savePending(email, 'register', payload);
      let smsError = null;
      try {
        await twilio.sendCode(toE164(phone, country));
      } catch (e) {
        // Don't block sign-up: the app shows why and offers the email link.
        if (!env.firebase.projectId) throw e;
        smsError = e.message;
      }
      return ok(res, {
        email,
        verification: 'sms_code',
        phoneE164: toE164(phone, country),
        emailBackup: Boolean(env.firebase.projectId),
        smsError,
        message: smsError || `We texted a 6-digit code to ${toE164(phone, country)}.`,
      });
    }
    if (method === 'email_link') {
      // The app has Firebase email the verification link and comes back
      // with /register/verify-email-link once it's been tapped.
      await otp.savePending(email, 'register', payload);
      return ok(res, {
        email,
        verification: 'email_link',
        message: `We'll email a verification link to ${email}.`,
      });
    }
    if (method === 'sms') {
      // The app sends the SMS code through Firebase and comes back with
      // /register/verify-phone.
      await otp.savePending(email, 'register', payload);
      return ok(res, {
        email,
        verification: 'sms',
        phoneE164: toE164(phone, country),
        message: `We'll text a 6-digit code to ${toE164(phone, country)}.`,
      });
    }
    const extra = await otp.issueCode(email, 'register', payload);
    ok(res, { email, verification: 'email', message: `We sent a 6-digit code to ${email}.`, ...extra });
  }),
);

/** How a sign-up from [country] is verified: sms | email_link | email. */
function verificationFor(country) {
  return country === 'SL' ? env.slSignupVerification : env.signupVerification;
}

/** Creates the account from saved sign-up details and logs in. */
async function createAccount(p, { phoneVerified = false } = {}) {
  if (await User.exists({ $or: [{ email: p.email }, { phone: p.phone }] })) {
    throw conflict('An account with these details already exists. Please log in.', 'ALREADY_REGISTERED');
  }
  const user = await User.create({
    fullName: p.fullName,
    email: p.email,
    phone: p.phone,
    country: p.country === 'SL' ? 'SL' : 'NG',
    passwordHash: p.passwordHash,
    // With SMS sign-up the phone is proven instead of the email.
    emailVerified: !phoneVerified,
    phoneVerified,
    referralCode: await uniqueReferralCode(p.fullName),
    referredBy: p.referrerId || null,
    isApproved: true,
    lastLoginAt: new Date(),
    // Owner accounts listed in SUPER_ADMIN_EMAILS become Super Admin.
    role: env.superAdminEmails.includes(p.email) ? 'super' : 'user',
  });
  await otp.deleteCode(p.email, 'register');
  await raiseAlert({
    type: 'new_user',
    title: 'New user registered',
    body: `${user.fullName} (${user.email}) just signed up.`,
    user: user._id,
  });
  await notify(user._id, {
    title: 'Welcome to Dalabapay',
    body: 'Set up your payment PIN, add money to your wallet and start paying bills in seconds.',
    kind: 'general',
  });
  return user;
}

/** Step 2 (email): correct code → account created and logged in. */
router.post(
  '/register/verify',
  validate({ body: z.object({ email: fields.email, code: fields.code }) }),
  asyncHandler(async (req, res) => {
    const { email, code } = req.body;
    const record = await otp.checkCode(email, 'register', code);
    const p = record.payload;
    if (!p) throw badRequest('Please start sign-up again.', 'CODE_EXPIRED');
    const user = await createAccount(p);
    ok(res, session(user), 201);
  }),
);

/** Step 2 (SMS by our server, Twilio Verify): the code from the SMS. */
router.post(
  '/register/verify-sms',
  validate({ body: z.object({ email: fields.email, code: fields.code }) }),
  asyncHandler(async (req, res) => {
    const { email, code } = req.body;
    const p = await otp.pendingPayload(email, 'register');
    if (!p) throw badRequest('This sign-up has expired. Please start again.', 'CODE_EXPIRED');
    const approved = await twilio.checkCode(toE164(p.phone, p.country), code);
    if (!approved) throw badRequest('Incorrect code. Please check the SMS and try again.', 'CODE_INVALID');
    const user = await createAccount(p, { phoneVerified: true });
    ok(res, session(user), 201);
  }),
);

/**
 * Backup when the SMS doesn't arrive: switch this sign-up to the Firebase
 * email link (the app sends it, then calls /register/verify-email-link).
 */
router.post(
  '/register/use-email',
  validate({ body: z.object({ email: fields.email }) }),
  asyncHandler(async (req, res) => {
    if (!env.firebase.projectId) {
      throw badRequest('Email verification isn\'t available. Please use the SMS code.', 'EMAIL_BACKUP_UNAVAILABLE');
    }
    const p = await otp.pendingPayload(req.body.email, 'register');
    if (!p) throw badRequest('This sign-up has expired. Please start again.', 'CODE_EXPIRED');
    ok(res, { email: p.email, verification: 'email_link' });
  }),
);

/**
 * Step 2 (email link): Firebase emailed a verification link, the person
 * tapped it, and the app sends the Firebase ID token. The token must be for
 * the same email address, marked verified by Firebase.
 */
router.post(
  '/register/verify-email-link',
  validate({ body: z.object({ email: fields.email, idToken: z.string().min(20).max(5000) }) }),
  asyncHandler(async (req, res) => {
    const { email, idToken } = req.body;
    const p = await otp.pendingPayload(email, 'register');
    if (!p) throw badRequest('This sign-up has expired. Please start again.', 'CODE_EXPIRED');
    const claims = await verifyIdToken(idToken);
    if (String(claims.email || '').toLowerCase() !== email) {
      throw badRequest('This verification was for a different email address.', 'EMAIL_MISMATCH');
    }
    if (claims.email_verified !== true) {
      throw badRequest('Your email isn\'t verified yet. Tap the link in the email first.', 'EMAIL_NOT_VERIFIED');
    }
    const user = await createAccount(p);
    ok(res, session(user), 201);
  }),
);

/**
 * Step 2 (SMS): the app verified the phone with Firebase (the person typed
 * the SMS code) and sends the Firebase ID token. The token must be for the
 * same phone number given at sign-up.
 */
router.post(
  '/register/verify-phone',
  validate({ body: z.object({ email: fields.email, idToken: z.string().min(20).max(5000) }) }),
  asyncHandler(async (req, res) => {
    const { email, idToken } = req.body;
    const p = await otp.pendingPayload(email, 'register');
    if (!p) throw badRequest('This sign-up has expired. Please start again.', 'CODE_EXPIRED');
    const claims = await verifyIdToken(idToken);
    if (claims.phone_number !== toE164(p.phone, p.country)) {
      throw badRequest('This code was for a different phone number. Please try again.', 'PHONE_MISMATCH');
    }
    const user = await createAccount(p, { phoneVerified: true });
    ok(res, session(user), 201);
  }),
);

router.post(
  '/register/resend',
  validate({ body: z.object({ email: fields.email }) }),
  asyncHandler(async (req, res) => {
    const p = await otp.pendingPayload(req.body.email, 'register');
    const method = p ? verificationFor(p.country) : 'email';
    if (method === 'twilio') {
      await twilio.sendCode(toE164(p.phone, p.country));
      return ok(res, { message: 'A new code is on its way.', verification: 'sms_code', phoneE164: toE164(p.phone, p.country) });
    }
    if (method !== 'email') {
      // Firebase resends the SMS / email link from the app.
      if (!p) throw badRequest('This sign-up has expired. Please start again.', 'CODE_EXPIRED');
      return ok(res, { verification: method, phoneE164: toE164(p.phone, p.country) });
    }
    const extra = await otp.issueCode(req.body.email, 'register');
    ok(res, { message: 'A new code is on its way.', verification: 'email', ...extra });
  }),
);

// ── Login ──────────────────────────────────────────────────

router.post(
  '/login',
  validate({
    body: z.object({
      identifier: z.string().trim().min(3, 'Enter your email or phone number').max(100),
      password: z.string().min(1, 'Enter your password').max(100),
      // The country picked on the login screen (optional for older apps).
      country: z.enum(COUNTRY_CODES).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const id = req.body.identifier.toLowerCase();
    const { country } = req.body;
    const phone = country ? normalizePhone(id, country) || anyLocal(id) : anyLocal(id);
    const query = id.includes('@') ? { email: id } : { phone };
    const user = await User.findOne(query).select('+passwordHash');
    if (user && !user.passwordHash) {
      // A record left by another app in the same database (no passwordHash).
      throw unauthorized(
        'This account was created in the old Dalabapay app and can\'t sign in here. Please create a new account.',
        'LEGACY_ACCOUNT',
      );
    }
    const okPassword = user && (await bcrypt.compare(req.body.password, user.passwordHash));
    if (!okPassword) throw unauthorized('Incorrect email/phone or password.', 'INVALID_CREDENTIALS');
    if (!user.isActive) {
      throw forbidden('Your account has been deactivated. Please contact support.', 'ACCOUNT_DISABLED');
    }
    if (country && (user.country || 'NG') !== country) {
      const name = COUNTRIES[user.country || 'NG'].name;
      throw unauthorized(`This account is registered in ${name}. Select ${name} to log in.`, 'WRONG_COUNTRY');
    }
    user.lastLoginAt = new Date();
    await user.save();
    ok(res, session(user));
  }),
);

// ── Forgot / reset password ────────────────────────────────

router.post(
  '/password/forgot',
  validate({ body: z.object({ email: fields.email }) }),
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    let extra = {};
    // Same answer whether or not the email exists (no account probing).
    if (await User.exists({ email })) extra = await otp.issueCode(email, 'reset_password');
    ok(res, { email, message: `If ${email} has an account, we've sent a 6-digit code.`, ...extra });
  }),
);

router.post(
  '/password/verify-code',
  validate({ body: z.object({ email: fields.email, code: fields.code }) }),
  asyncHandler(async (req, res) => {
    const record = await otp.checkCode(req.body.email, 'reset_password', req.body.code);
    const resetToken = await otp.markVerified(record);
    ok(res, { resetToken });
  }),
);

router.post(
  '/password/reset',
  validate({ body: z.object({ resetToken: z.string().min(10), password: fields.password }) }),
  asyncHandler(async (req, res) => {
    const record = await otp.consumeVerifiedToken('reset_password', req.body.resetToken);
    const passwordHash = await bcrypt.hash(req.body.password, 10);
    const user = await User.findOneAndUpdate(
      { email: record.email },
      { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
      { new: true },
    );
    if (!user) throw badRequest('Account not found.');
    await notify(user._id, {
      title: 'Password changed',
      body: 'Your password was reset. If this wasn\'t you, contact support immediately.',
      kind: 'security',
    });
    ok(res, { message: 'Password reset. You can now log in with your new password.' });
  }),
);

router.post(
  '/password/change',
  requireAuth,
  validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: fields.password }) }),
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!user.passwordHash || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) {
      throw badRequest('Your current password is incorrect.', 'WRONG_PASSWORD');
    }
    if (await bcrypt.compare(req.body.newPassword, user.passwordHash)) {
      throw badRequest('Please choose a password you haven\'t used before.', 'SAME_PASSWORD');
    }
    user.passwordHash = await bcrypt.hash(req.body.newPassword, 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await notify(user._id, { title: 'Password changed', body: 'Your password was changed.', kind: 'security' });
    // New token because the old one is now invalid.
    ok(res, session(user));
  }),
);

// ── Payment PIN ────────────────────────────────────────────

router.post(
  '/pin/set',
  requireAuth,
  validate({ body: z.object({ pin: fields.pin }) }),
  asyncHandler(async (req, res) => {
    if (req.user.pinSet) throw conflict('You already have a PIN. Use Change PIN instead.', 'PIN_ALREADY_SET');
    await pinService.setPin(req.user._id, req.body.pin);
    ok(res, { message: 'Your payment PIN is set.' });
  }),
);

router.post(
  '/pin/change',
  requireAuth,
  validate({ body: z.object({ currentPin: fields.pin, newPin: fields.pin }) }),
  asyncHandler(async (req, res) => {
    await pinService.verifyPin(req.user._id, req.body.currentPin);
    if (req.body.currentPin === req.body.newPin) {
      throw badRequest('New PIN must be different from your current PIN.', 'SAME_PIN');
    }
    await pinService.setPin(req.user._id, req.body.newPin);
    await notify(req.user._id, { title: 'PIN changed', body: 'Your payment PIN was changed.', kind: 'security' });
    ok(res, { message: 'Your payment PIN has been updated.' });
  }),
);

/** Checks the PIN (used for "unlock with PIN"). */
router.post(
  '/pin/verify',
  requireAuth,
  validate({ body: z.object({ pin: fields.pin }) }),
  asyncHandler(async (req, res) => {
    await pinService.verifyPin(req.user._id, req.body.pin);
    ok(res, { valid: true });
  }),
);

router.post(
  '/pin/forgot',
  requireAuth,
  asyncHandler(async (req, res) => {
    const extra = await otp.issueCode(req.user.email, 'reset_pin');
    ok(res, { message: `We sent a 6-digit code to ${req.user.email}.`, ...extra });
  }),
);

router.post(
  '/pin/reset',
  requireAuth,
  validate({ body: z.object({ code: fields.code, newPin: fields.pin }) }),
  asyncHandler(async (req, res) => {
    await otp.checkCode(req.user.email, 'reset_pin', req.body.code);
    await pinService.setPin(req.user._id, req.body.newPin);
    await otp.deleteCode(req.user.email, 'reset_pin');
    await notify(req.user._id, { title: 'PIN reset', body: 'Your payment PIN was reset.', kind: 'security' });
    ok(res, { message: 'Your payment PIN has been reset.' });
  }),
);

module.exports = router;
