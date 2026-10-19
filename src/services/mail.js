// Sends email through Resend's HTTPS API (RESEND_API_KEY — works on hosts
// that block SMTP ports, e.g. Render's free plan) or SMTP. With neither, in
// development the message is printed to the log; in production nothing is
// logged (codes must never end up in logs).
const nodemailer = require('nodemailer');
const env = require('../config/env');

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

async function sendWithResend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.smtp.from, to: [to], subject, text, html: html || undefined }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
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
  await t.sendMail({ from: env.smtp.from, to, subject, text, html: html || undefined });
  return { delivered: true };
}

function codeEmail(code, purpose) {
  const what = {
    register: 'verify your email address',
    reset_password: 'reset your password',
    reset_pin: 'reset your payment PIN',
  }[purpose];
  return {
    subject: `Your Dalabapay code: ${code}`,
    text: `Use ${code} to ${what}. The code expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.`,
  };
}

module.exports = { sendMail, isMailConfigured, mailMethod, codeEmail };
