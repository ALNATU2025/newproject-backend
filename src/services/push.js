// Push notifications to phones through Firebase Cloud Messaging (HTTP v1),
// and the admin webhook. Both are free and fire-and-forget: a failure is
// logged, never thrown, so it can't break a payment.
//
//   FIREBASE_SERVICE_ACCOUNT   enables push (see config/env.js)
//   ADMIN_WEBHOOK_URL          admin events are POSTed here as JSON
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { Device, User } = require('../models');

let fetchImpl = (...a) => fetch(...a);
let accessToken = null;
let accessTokenExpires = 0;
const sent = []; // last messages, for tests

const pushConfigured = () => Boolean(env.firebase.serviceAccount);

async function googleToken() {
  if (accessToken && Date.now() < accessTokenExpires - 60_000) return accessToken;
  const sa = env.firebase.serviceAccount;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    sa.privateKey,
    { algorithm: 'RS256' },
  );
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google token: HTTP ${res.status} ${j.error || ''}`);
  accessToken = j.access_token;
  accessTokenExpires = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return accessToken;
}

/** Strings only: FCM data values must be strings. */
function stringData(data = {}) {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
}

async function sendToTokens(tokens, { title, body, data = {} }) {
  if (!pushConfigured() || !tokens.length) return 0;
  const token = await googleToken();
  const project = env.firebase.serviceAccount.projectId || env.firebase.projectId;
  let delivered = 0;
  await Promise.all(
    tokens.map(async (t) => {
      try {
        const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: t,
              notification: { title: String(title).slice(0, 120), body: String(body).slice(0, 400) },
              data: stringData(data),
              android: { priority: 'high' },
              apns: { payload: { aps: { sound: 'default' } } },
            },
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          delivered += 1;
          sent.push({ token: t, title, body });
          if (sent.length > 50) sent.shift();
          return;
        }
        const j = await res.json().catch(() => ({}));
        const status = j.error && j.error.status;
        // The app was uninstalled or the token is stale: forget it.
        if (res.status === 404 || status === 'NOT_FOUND' || status === 'UNREGISTERED' || (status === 'INVALID_ARGUMENT' && /token/i.test(j.error.message || ''))) {
          await Device.deleteOne({ token: t });
        } else if (!env.isTest) {
          console.warn(`[push] HTTP ${res.status} ${status || ''}`);
        }
      } catch (e) {
        if (!env.isTest) console.warn(`[push] ${e.message}`);
      }
    }),
  );
  return delivered;
}

/** Pushes to every phone of [userId] (unless they turned push off). */
async function pushToUser(userId, message) {
  if (!pushConfigured()) return 0;
  try {
    const user = await User.findById(userId).select('preferences');
    if (!user || (user.preferences && user.preferences.pushEnabled === false)) return 0;
    const tokens = (await Device.find({ user: userId }).select('token')).map((d) => d.token);
    return await sendToTokens(tokens, message);
  } catch (e) {
    if (!env.isTest) console.warn(`[push] ${e.message}`);
    return 0;
  }
}

/** Pushes to many users (e.g. an announcement). */
async function pushToUsers(userIds, message) {
  if (!pushConfigured() || !userIds.length) return 0;
  let total = 0;
  for (let i = 0; i < userIds.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    const tokens = (await Device.find({ user: { $in: userIds.slice(i, i + 500) } }).select('token')).map((d) => d.token);
    // eslint-disable-next-line no-await-in-loop
    total += await sendToTokens(tokens, message).catch(() => 0);
  }
  return total;
}

// ── Admins: push + webhook ─────────────────────────────────

async function postWebhook(payload) {
  const { url, secret } = env.adminWebhook;
  if (!url) return false;
  const body = JSON.stringify({
    ...payload,
    // So Slack ("text") and Discord ("content") show it without set-up.
    text: `*${payload.title}*\n${payload.body}`,
    content: `**${payload.title}**\n${payload.body}`,
  });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Dalabapay-Webhook/1' };
  if (secret) headers['X-Dalabapay-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    sent.push({ webhook: url, ...payload });
    if (sent.length > 50) sent.shift();
    return res.ok;
  } catch (e) {
    if (!env.isTest) console.warn(`[admin webhook] ${e.message}`);
    return false;
  }
}

/**
 * Tells the admins about [event]: a push to every staff phone and a POST
 * to ADMIN_WEBHOOK_URL. Never throws.
 */
async function notifyAdmins({ event, title, body, severity = 'info', data = {} }) {
  const payload = { event, title, body, severity, data, at: new Date().toISOString() };
  try {
    const jobs = [postWebhook(payload)];
    if (pushConfigured()) {
      const staff = await User.find({ role: { $ne: 'user' }, isActive: true }).distinct('_id');
      jobs.push(pushToUsers(staff, { title, body, data: { event, ...data } }));
    }
    await Promise.all(jobs);
  } catch (e) {
    if (!env.isTest) console.warn(`[admin notify] ${e.message}`);
  }
}

/** For tests. */
function setFetch(fn) {
  fetchImpl = fn;
  accessToken = null;
}

module.exports = { pushConfigured, pushToUser, pushToUsers, notifyAdmins, setFetch, sent };
