// Loads and checks environment variables once, so the rest of the code reads
// from `env` instead of process.env.
require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

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
    from: process.env.MAIL_FROM || 'Dalabapay <no-reply@dalabapay.com>',
  },

  billProvider: (process.env.BILL_PROVIDER || (isProd ? 'none' : 'simulator')).toLowerCase(),
  paymentProvider: (process.env.PAYMENT_PROVIDER || (isProd ? 'none' : 'simulator')).toLowerCase(),
  webhookSecret: process.env.WEBHOOK_SECRET || (isProd ? '' : 'dev-webhook-secret'),
};

if (isProd && env.jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

module.exports = env;
