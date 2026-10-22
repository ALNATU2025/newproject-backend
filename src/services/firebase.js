// Checks Firebase ID tokens (Firebase Phone Auth: the app proves the person
// received the SMS code). Uses Google's public certificates and the project
// ID only — no service-account key needed.
//
// https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { badRequest, unavailable } = require('../utils/errors');

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let certs = null; // { kid: pem }
let certsUntil = 0;
let fetchImpl = (...a) => fetch(...a);

async function publicCerts() {
  if (certs && Date.now() < certsUntil) return certs;
  let res;
  try {
    res = await fetchImpl(CERTS_URL, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    throw unavailable('We couldn\'t check the SMS code right now. Please try again.', 'VERIFICATION_UNAVAILABLE');
  }
  if (!res.ok) throw unavailable('We couldn\'t check the SMS code right now. Please try again.', 'VERIFICATION_UNAVAILABLE');
  certs = await res.json();
  const maxAge = /max-age=(\d+)/.exec((res.headers && res.headers.get && res.headers.get('cache-control')) || '');
  certsUntil = Date.now() + (maxAge ? Number(maxAge[1]) * 1000 : 3600 * 1000);
  return certs;
}

/**
 * Verifies a Firebase ID token and returns its claims
 * ({ sub, phone_number, ... }). Throws a 400 for anything invalid.
 */
async function verifyIdToken(idToken) {
  const projectId = env.firebase.projectId;
  if (!projectId) throw unavailable('SMS verification is not set up on the server.', 'VERIFICATION_NOT_CONFIGURED');
  const invalid = () => badRequest('The SMS verification has expired or is invalid. Please request a new code.', 'INVALID_VERIFICATION');
  const decoded = jwt.decode(String(idToken || ''), { complete: true });
  if (!decoded || !decoded.header || decoded.header.alg !== 'RS256') throw invalid();
  const pem = (await publicCerts())[decoded.header.kid];
  if (!pem) throw invalid();
  let claims;
  try {
    claims = jwt.verify(idToken, pem, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
    });
  } catch {
    throw invalid();
  }
  if (!claims.sub || (claims.auth_time && claims.auth_time * 1000 > Date.now() + 60_000)) throw invalid();
  return claims;
}

/** For tests: replace the HTTP call for the certificates. */
function setCertFetcher(fn) {
  fetchImpl = fn;
  certs = null;
  certsUntil = 0;
}

module.exports = { verifyIdToken, setCertFetcher };
