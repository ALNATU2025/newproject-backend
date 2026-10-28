const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');
const env = require('./config/env');

const VERIFY_LABEL = {
  firebase: 'choice: sms or email link (Firebase)',
  twilio: 'sms code (Twilio)',
  email_link: 'email link (Firebase)',
  sms: 'sms (Firebase)',
  email: 'email code',
};
const { notFoundHandler, errorHandler } = require('./middleware/error');

function createApp() {
  const app = express();

  // Behind Render / Railway / Nginx the client IP comes from X-Forwarded-For.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      // Mobile apps send no Origin header; browsers must be on the list
      // (CORS_ORIGINS). The app running in Chrome on your own computer
      // (flutter run -d chrome → http://localhost:<port>) is always allowed.
      // Login uses a Bearer token, not cookies, so this can't be abused
      // by other websites.
      origin: (origin, cb) => {
        if (!origin || env.corsOrigins.includes('*') || env.corsOrigins.includes(origin)) return cb(null, true);
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
        return cb(null, false);
      },
    }),
  );
  // New dollar cards can carry a photo of the ID document.
  app.use('/api/cards', express.json({ limit: '8mb' }));
  // Account level upgrades carry document photos.
  app.use('/api/tiers', express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '200kb' }));
  if (!env.isTest) app.use(morgan(env.isProd ? 'combined' : 'dev'));

  // Plain status for a browser or uptime monitor. No secrets — only yes/no.
  const status = () => {
    const { isMailConfigured, getLastMailError } = require('./services/mail'); // eslint-disable-line global-require
    const mailError = getLastMailError();
    const vt = env.vtpass;
    return {
      status: 'ok',
      mode: env.nodeEnv,
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      signupVerification: {
        nigeria: VERIFY_LABEL[env.signupVerification],
        sierraLeone: VERIFY_LABEL[env.slSignupVerification],
        emailBackup: env.firebase.projectId ? 'Firebase email link' : 'off',
      },
      email: !isMailConfigured()
        ? 'NOT configured — set RESEND_API_KEY'
        : mailError
          ? `configured, but the last email FAILED at ${mailError.at}: ${mailError.hint}`
          : 'configured',
      notifications: {
        push: env.firebase.serviceAccount ? 'on (Firebase Cloud Messaging)' : 'off — set FIREBASE_SERVICE_ACCOUNT',
        adminWebhook: env.adminWebhook.url ? `on${env.adminWebhook.secret ? ' (signed)' : ''}` : 'off — set ADMIN_WEBHOOK_URL',
      },
      cashwyre: {
        keys: env.cashwyre.secretKey && env.cashwyre.businessCode ? 'set' : 'MISSING',
        webhook: env.cashwyre.webhookToken ? 'set' : 'MISSING — set CASHWYRE_WEBHOOK_TOKEN',
      },
      kuda: {
        mode: env.kuda.env,
        keys: env.kuda.email && env.kuda.apiKey && env.kuda.accountNumber ? 'set' : 'MISSING — set KUDA_EMAIL, KUDA_API_KEY, KUDA_ACCOUNT_NUMBER',
        addMoney: env.paymentProvider === 'kuda' ? 'on' : 'off — set PAYMENT_PROVIDER=kuda',
        webhook: env.kuda.webhookToken ? 'set' : 'MISSING — set KUDA_WEBHOOK_TOKEN',
      },
      vtpass: {
        mode: vt.environment,
        keys: vt.apiKey && vt.publicKey && vt.secretKey ? 'set' : 'MISSING',
        services: vt.services,
      },
    };
  };
  app.get('/', (req, res) => res.json({ success: true, data: { name: 'Dalabapay API', ...status() } }));
  app.head('/', (req, res) => res.status(200).end());
  app.get('/health', (req, res) =>
    res.json({
      success: true,
      data: {
        ...status(),
        time: new Date().toISOString(),
      },
    }),
  );

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/me', require('./routes/me'));
  app.use('/api/wallet', require('./routes/wallet'));
  app.use('/api/transactions', require('./routes/transactions'));
  app.use('/api/services/sl', require('./routes/sl'));
  app.use('/api/services', require('./routes/services'));
  app.use('/api/commission', require('./routes/commission'));
  app.use('/api/referrals', require('./routes/referrals'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/disputes', require('./routes/disputes'));
  app.use('/api/kyc', require('./routes/kyc'));
  app.use('/api/tiers', require('./routes/tiers'));
  app.use('/api/payouts', require('./routes/payouts'));
  app.use('/api/cards', require('./routes/cards'));
  app.use('/api/webhooks', require('./routes/webhooks'));
  // Confirm / Cancel links in admin webhook messages (bank top-ups).
  app.use('/api/funding-actions', express.urlencoded({ extended: false, limit: '4kb' }), require('./routes/fundingActions'));
  app.use('/api/admin', require('./routes/admin'));

  if (!env.isProd && env.paymentProvider === 'simulator') {
    app.use('/api/dev', require('./routes/dev'));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
