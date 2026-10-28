// Sends email through Resend's HTTPS API (RESEND_API_KEY — works on hosts
// that block SMTP ports, e.g. Render's free plan) or SMTP. With neither, in
// development the message is printed to the log; in production nothing is
// logged (codes must never end up in logs).
const nodemailer = require('nodemailer');
const env = require('../config/env');
const { unavailable } = require('../utils/errors');

// The last failed send, for /health and the go-live checklist.
let lastError = null;

// What usually causes each Resend refusal (safe to show publicly).
function hintFor(status, reason) {
  if (status === 401 || /api key/i.test(reason)) return 'RESEND_API_KEY is wrong — copy the key again from Resend';
  if (status === 403 && /testing emails|own email/i.test(reason)) {
    return 'Resend test mode: codes only go to your Resend account email until you verify a domain';
  }
  if (status === 403 && /domain/i.test(reason)) return 'MAIL_FROM uses a domain not verified in Resend — use onboarding@resend.dev or verify the domain';
  if (status === 422 || /from/i.test(reason)) return 'MAIL_FROM is not valid — use: Dalabapay <onboarding@resend.dev>';
  if (status === 429) return 'Resend sending limit reached — try again later';
  return 'Email service refused the message — see the server log';
}

function getLastMailError() {
  return lastError;
}

let transporter = null;

function getTransporter() {
  if (!env.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    });
  }
  return transporter;
}

function isMailConfigured() {
  return Boolean(env.resendApiKey || env.smtp.host);
}

function mailMethod() {
  if (env.resendApiKey) return 'resend';
  if (env.smtp.host) return 'smtp';
  return 'none';
}

function failed(status, reason) {
  const clean = String(reason || '').replace(/\d{4,}/g, '******').slice(0, 300);
  lastError = { status, hint: hintFor(status, clean), at: new Date().toISOString() };
  console.error(`[mail] Email NOT sent (${status || 'network'}): ${clean} → ${lastError.hint}`);
  return unavailable('We couldn\'t send the email code right now. Please try again in a few minutes.', 'EMAIL_FAILED');
}

async function sendWithResend({ to, subject, text, html }) {
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.smtp.from, to: [to], subject, text, html: html || undefined }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw failed(0, `could not reach Resend: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let reason = body;
    try {
      reason = JSON.parse(body).message || body;
    } catch (_) { /* not JSON */ }
    throw failed(res.status, reason);
  }
  lastError = null;
  return { delivered: true };
}

async function sendMail({ to, subject, text, html }) {
  if (env.resendApiKey) return sendWithResend({ to, subject, text, html });
  const t = getTransporter();
  if (!t) {
    if (!env.isTest && !env.isProd) console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`);
    if (env.isProd) console.error(`[mail] No email service configured; could not send "${subject.replace(/\d{4,}/g, '******')}"`);
    return { delivered: false };
  }
  try {
    await t.sendMail({ from: env.smtp.from, to, subject, text, html: html || undefined });
  } catch (err) {
    throw failed(0, `SMTP: ${err.message}`);
  }
  lastError = null;
  return { delivered: true };
}

function codeEmail(code, purpose) {
  const what = {
    register: 'verify your email address',
    reset_password: 'reset your password',
    reset_pin: 'reset your payment PIN',
    new_device: 'confirm it\'s you signing in to Dalabapay on a new device',
  }[purpose];
  return {
    subject: `Your Dalabapay code: ${code}`,
    text: purpose === 'new_device'
      ? `Use ${code} to ${what}. The code expires in 10 minutes.\n\nIf this wasn't you, don't share the code: change your password now, because someone knows it.`
      : `Use ${code} to ${what}. The code expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.`,
  };
}

module.exports = { sendMail, isMailConfigured, mailMethod, codeEmail, getLastMailError };
