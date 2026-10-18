// Sends email through SMTP. Without SMTP settings (development) the message
// is printed to the log instead.
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
  return Boolean(env.smtp.host);
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    if (!env.isTest) console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`);
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

module.exports = { sendMail, isMailConfigured, codeEmail };
