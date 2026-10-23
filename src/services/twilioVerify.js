// Sign-up SMS codes through Twilio Verify (https://www.twilio.com/docs/verify).
// Twilio creates the 6-digit code, texts it and checks it, so no code is
// stored here. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
// TWILIO_VERIFY_SERVICE_SID (Twilio console → Verify → Services).
const env = require('../config/env');
const { badRequest, unavailable, tooMany } = require('../utils/errors');

let fetchImpl = (...a) => fetch(...a);

const configured = () =>
  Boolean(env.twilio.accountSid && env.twilio.authToken && env.twilio.verifyServiceSid);

async function call(path, form) {
  if (!configured()) throw unavailable('SMS codes are not set up on the server.', 'VERIFICATION_NOT_CONFIGURED');
  const url = `https://verify.twilio.com/v2/Services/${env.twilio.verifyServiceSid}/${path}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.twilio.accountSid}:${env.twilio.authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw unavailable('We couldn\'t reach the SMS service. Please try again.', 'SMS_UNAVAILABLE');
  }
  const json = await res.json().catch(() => ({}));
  if (res.ok) return json;
  // Twilio error codes: https://www.twilio.com/docs/api/errors
  const code = Number(json.code);
  if (env.isProd || !env.isTest) console.warn(`[twilio] ${path} failed: HTTP ${res.status} code=${code} ${json.message || ''}`);
  if (code === 60203 || code === 60202 || res.status === 429) {
    throw tooMany('Too many codes requested. Please wait a few minutes, or verify by email instead.');
  }
  if (code === 60200 || code === 21211 || code === 21614) {
    throw badRequest('This phone number can\'t receive SMS codes. Check it, or verify by email instead.', 'INVALID_PHONE');
  }
  if (code === 60410 || code === 60605 || code === 60220) {
    throw badRequest('SMS codes can\'t be sent to this number right now. Please verify by email instead.', 'SMS_BLOCKED');
  }
  if (res.status === 404 || code === 20404) {
    throw badRequest('This code has expired. Tap Resend code for a new one.', 'CODE_EXPIRED');
  }
  if (res.status === 401 || code === 20003) {
    throw unavailable('SMS codes are not set up correctly on the server.', 'VERIFICATION_NOT_CONFIGURED');
  }
  throw unavailable('We couldn\'t send the SMS code. Please try again, or verify by email instead.', 'SMS_UNAVAILABLE');
}

/** Texts a new 6-digit code to [phoneE164]. */
async function sendCode(phoneE164) {
  await call('Verifications', { To: phoneE164, Channel: 'sms' });
}

/** True when [code] is the right one for [phoneE164]. */
async function checkCode(phoneE164, code) {
  const r = await call('VerificationCheck', { To: phoneE164, Code: code });
  return r.status === 'approved';
}

/** For tests: replace the HTTP call. */
function setFetch(fn) {
  fetchImpl = fn;
}

module.exports = { sendCode, checkCode, configured, setFetch };
