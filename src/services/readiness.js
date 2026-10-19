// Go-live checklist shown in the admin console (Provider Settings) and at
// GET /api/admin/readiness. Each check: ok | warn | fail.
const mongoose = require('mongoose');
const env = require('../config/env');
const { supportsTransactions } = require('../config/db');
const { mailMethod } = require('./mail');
const { billProvider } = require('../providers/bill');
const { paymentProvider } = require('../providers/payment');
const { getSettings } = require('./settings');
const { User } = require('../models');

async function readiness() {
  const checks = [];
  const add = (key, label, status, detail) => checks.push({ key, label, status, detail });

  add('environment', 'Server mode', env.isProd ? 'ok' : 'warn',
    env.isProd ? 'production' : `${env.nodeEnv} — set NODE_ENV=production for real money`);

  const dbUp = mongoose.connection.readyState === 1;
  add('database', 'Database', dbUp ? (supportsTransactions() ? 'ok' : 'warn') : 'fail',
    !dbUp ? 'Not connected' : supportsTransactions() ? 'Connected (replica set, transactions on)' : 'Connected without transactions — use MongoDB Atlas');

  const weakJwt = env.jwtSecret.length < 32 || /change-me|dev-only/.test(env.jwtSecret);
  add('jwt', 'Login secret (JWT_SECRET)', weakJwt ? 'fail' : 'ok',
    weakJwt ? 'Use a long random value (at least 32 characters)' : 'Set');

  const mail = mailMethod();
  add('email', 'Email for sign-up codes', mail === 'none' ? 'fail' : 'ok',
    mail === 'none' ? 'Set RESEND_API_KEY (recommended on Render) or SMTP_* — nobody can sign up without codes' : `Sending with ${mail} as ${env.smtp.from}`);

  const vt = env.vtpass;
  const keys = Boolean(vt.apiKey && vt.publicKey && vt.secretKey);
  add('vtpass_keys', 'VTpass API keys', keys ? 'ok' : 'fail', keys ? 'Set' : 'Set VTPASS_API_KEY, VTPASS_PUBLIC_KEY and VTPASS_SECRET_KEY');
  add('vtpass_env', 'VTpass mode', vt.environment === 'live' ? 'ok' : 'warn',
    vt.environment === 'live' ? 'LIVE — real money' : 'sandbox — test money only; set VTPASS_ENV=live');
  add('vtpass_services', 'Services on VTpass', vt.services.length ? 'ok' : 'fail',
    vt.services.length ? vt.services.join(', ') : 'Set VTPASS_SERVICES=cable,international');

  const bp = billProvider();
  if (keys && vt.services.length) {
    const h = await bp.health().catch((e) => ({ ok: false, message: e.message }));
    add('vtpass_reach', 'VTpass connection', h.ok ? 'ok' : 'fail', h.message);
    let bal = null;
    try {
      bal = await bp.balance();
    } catch {
      bal = null;
    }
    const s = await getSettings();
    if (bal !== null) {
      add('vtpass_balance', 'VTpass wallet', bal >= s.lowBalanceThreshold ? 'ok' : 'warn',
        `₦${(bal / 100).toLocaleString('en-NG')}${bal < s.lowBalanceThreshold ? ' — top up on vtpass.com before testing' : ''}`);
    }
  }

  const map = bp.serviceMap ? bp.serviceMap() : {};
  const fake = Object.entries(map).filter(([, v]) => v.provider === 'simulator').map(([k]) => k);
  const off = Object.entries(map).filter(([, v]) => !v.configured).map(([k]) => k);
  if (fake.length) {
    add('simulator', 'Simulated services', env.isProd ? 'fail' : 'warn', `${fake.join(', ')} are simulated — no real delivery`);
  }
  add('other_services', 'Services not connected', off.length ? 'warn' : 'ok',
    off.length ? `${off.join(', ')} show "not connected" to customers — switch them off in Service Controls` : 'None');

  const pay = paymentProvider();
  add('funding', 'Wallet funding', pay.isConfigured() && pay.name !== 'simulator' ? 'ok' : 'warn',
    pay.isConfigured() && pay.name !== 'simulator'
      ? pay.name
      : 'No bank-transfer provider yet: fund wallets from the admin console (Fund Wallet / Self Fund) for testing');

  const supers = await User.countDocuments({ role: 'super', isActive: true });
  add('admin', 'Super Admin account', supers > 0 ? 'ok' : 'fail',
    supers > 0 ? `${supers} active` : 'Sign up, then set SUPER_ADMIN_EMAILS=you@example.com and restart');

  for (const w of env.warnings) add('startup', 'Start-up warning', 'fail', w);

  return { ready: checks.every((c) => c.status !== 'fail'), checks };
}

module.exports = { readiness };
