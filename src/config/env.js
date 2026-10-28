// Loads and checks environment variables once, so the rest of the code reads
// from `env` instead of process.env.
require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

/**
 * The simulator fakes payments, so it is refused in production (it would
 * take real wallet money for airtime that never arrives) unless
 * ALLOW_SIMULATOR_IN_PRODUCTION=true is set on purpose.
 */
const startupWarnings = [];
// Values pasted into a dashboard often carry spaces or quotes.
function clean(v) {
  return String(v || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

/** A sign-up method that is actually usable with the settings given. */
function signupMethod(value, fallback) {
  const v = clean(value).toLowerCase();
  const firebase = Boolean(clean(process.env.FIREBASE_PROJECT_ID));
  const twilio = Boolean(
    clean(process.env.TWILIO_ACCOUNT_SID) && clean(process.env.TWILIO_AUTH_TOKEN) && clean(process.env.TWILIO_VERIFY_SERVICE_SID),
  );
  if (v === 'twilio' && twilio) return 'twilio';
  if (v === 'firebase' && firebase) return 'firebase';
  if ((v === 'sms' || v === 'email_link') && firebase) return v;
  if (v === 'email') return 'email';
  return fallback;
}

function safeProvider(name) {
  const v = (process.env[name] || (isProd ? 'none' : 'simulator')).toLowerCase();
  if (isProd && v === 'simulator' && process.env.ALLOW_SIMULATOR_IN_PRODUCTION !== 'true') {
    startupWarnings.push(`${name}=simulator is not allowed in production; using "none" instead.`);
    return 'none';
  }
  return v;
}

function required(name, fallback) {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined && !isProd) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

const env = {
  nodeEnv,
  isProd,
  isTest,
  port: Number(process.env.PORT || 4000),
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  mongoUri: required('MONGO_URI', 'mongodb://127.0.0.1:27017/dalabapay'),

  jwtSecret: required('JWT_SECRET', 'dev-only-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: clean(process.env.MAIL_FROM) || 'Dalabapay <no-reply@dalabapay.com>',
  },

  resendApiKey: clean(process.env.RESEND_API_KEY),

  billProvider: safeProvider('BILL_PROVIDER'),
  paymentProvider: safeProvider('PAYMENT_PROVIDER'),
  // Sierra Leone bill provider (airtime, data, EDSA, TV). "none" until the
  // provider's API is connected.
  slProvider: safeProvider('SL_PROVIDER'),

  // Sign-up verification (SIGNUP_VERIFICATION, per country with
  // SL_SIGNUP_VERIFICATION):
  //   firebase   the person chooses: SMS code (Firebase Phone Auth) or
  //              email link (Firebase) — no other service needed
  //   twilio     6-digit SMS code sent and checked by Twilio Verify (server)
  //   email_link Firebase emails a verification link
  //   sms        6-digit SMS code by Firebase Phone Auth (in the app)
  //   email      6-digit email code (Resend/SMTP)
  // With Twilio, "Verify by email instead" (Firebase link) is offered as a
  // backup when FIREBASE_PROJECT_ID is set.
  firebase: {
    projectId: clean(process.env.FIREBASE_PROJECT_ID),
    // Push notifications: the service account JSON from Firebase console →
    // Project settings → Service accounts → Generate new private key.
    // Paste the whole JSON (or it base64-encoded).
    serviceAccount: (() => {
      const raw = clean(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (!raw) return null;
      try {
        const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        const j = JSON.parse(text);
        if (!j.client_email || !j.private_key) throw new Error('missing client_email / private_key');
        return { projectId: j.project_id, clientEmail: j.client_email, privateKey: j.private_key.replace(/\\n/g, '\n') };
      } catch (e) {
        startupWarnings.push(`FIREBASE_SERVICE_ACCOUNT is not valid JSON (${e.message}); push notifications are off.`);
        return null;
      }
    })(),
  },

  // Admin notifications to another system (Slack, Discord, Zapier, Make,
  // your own server…): every admin alert, new sign-up, transaction and
  // suspicious activity is POSTed as JSON. With ADMIN_WEBHOOK_SECRET the
  // body is signed: header X-Dalabapay-Signature = sha256=<HMAC hex>.
  // This server's public address, for links in admin webhook messages
  // (Render sets RENDER_EXTERNAL_URL itself).
  publicUrl: clean(process.env.PUBLIC_URL) || clean(process.env.RENDER_EXTERNAL_URL),
  adminWebhook: {
    url: clean(process.env.ADMIN_WEBHOOK_URL),
    secret: clean(process.env.ADMIN_WEBHOOK_SECRET),
  },
  twilio: {
    accountSid: clean(process.env.TWILIO_ACCOUNT_SID),
    authToken: clean(process.env.TWILIO_AUTH_TOKEN),
    verifyServiceSid: clean(process.env.TWILIO_VERIFY_SERVICE_SID),
  },
  signupVerification: signupMethod(process.env.SIGNUP_VERIFICATION, 'email'),
  slSignupVerification: signupMethod(
    process.env.SL_SIGNUP_VERIFICATION || process.env.SIGNUP_VERIFICATION,
    clean(process.env.FIREBASE_PROJECT_ID) ? 'email_link' : 'email',
  ),

  // Emails promoted to Super Admin at start-up and when they sign up
  // (for hosts without a shell). Comma-separated.
  superAdminEmails: (process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  warnings: [],
  // VTpass (https://vtpass.com/documentation). Keys come from your VTpass
  // profile → API Keys. VTPASS_SERVICES lists the services sent to VTpass;
  // the rest use BILL_PROVIDER.
  vtpass: {
    apiKey: process.env.VTPASS_API_KEY || '',
    publicKey: process.env.VTPASS_PUBLIC_KEY || '',
    secretKey: process.env.VTPASS_SECRET_KEY || '',
    environment: (process.env.VTPASS_ENV || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox',
    services: (process.env.VTPASS_SERVICES || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    timeoutMs: Number(process.env.VTPASS_TIMEOUT_MS || 45000),
  },
  webhookSecret: process.env.WEBHOOK_SECRET || (isProd ? '' : 'dev-webhook-secret'),

  // Cashwyre (https://business.cashwyre.com/doc/api): bank and mobile
  // money transfers to other countries, and virtual dollar cards.
  //   CASHWYRE_SECRET_KEY     Settings → API keys (secret key)
  //   CASHWYRE_BUSINESS_CODE  Settings → business code (also the appId)
  //   CASHWYRE_WEBHOOK_TOKEN  any long random text you choose; the webhook
  //                           URL you give Cashwyre ends with it
  //   CASHWYRE_FX_FALLBACK    optional "NGN=1600,SLE=24" ($1 in each
  //                           currency) used when Cashwyre has no rate
  cashwyre: {
    secretKey: clean(process.env.CASHWYRE_SECRET_KEY),
    businessCode: clean(process.env.CASHWYRE_BUSINESS_CODE),
    baseUrl: clean(process.env.CASHWYRE_BASE_URL) || 'https://businessapi.cashwyre.com/api/v1.0',
    webhookToken: clean(process.env.CASHWYRE_WEBHOOK_TOKEN),
    // Which of your Cashwyre wallets pays a transfer to another country.
    // Which Cashwyre wallet pays a transfer is fixed in services/payouts.js
    // (Nigeria from NGN, everything else from SLE).
    fxFallback: Object.fromEntries(
      clean(process.env.CASHWYRE_FX_FALLBACK)
        .split(',')
        .map((p) => p.split('=').map((s) => s.trim()))
        .filter(([k, v]) => k && Number(v) > 0)
        .map(([k, v]) => [k.toUpperCase(), Number(v)]),
    ),
    timeoutMs: Number(process.env.CASHWYRE_TIMEOUT_MS || 45000),
  },
};

env.warnings = startupWarnings;

if (isProd && env.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

module.exports = env;
