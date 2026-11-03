// Extra protection for every API request:
//   - noStore:    API answers (balances, receipts) are never cached by
//                 browsers or proxies.
//   - rejectOperators: request bodies / query strings may not carry MongoDB
//                 operators ($ne, $gt…) or dotted keys — blocks NoSQL
//                 injection even on routes without a schema.
//   - apiLimiter: a per-IP ceiling on all API calls (routes add their own,
//                 stricter limits for login, codes and transfers).
const rateLimit = require('express-rate-limit');
const env = require('../config/env');

function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

const MAX_DEPTH = 12;
function unsafe(value, depth = 0) {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(value)) return value.some((v) => unsafe(v, depth + 1));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype') return true;
      if (unsafe(v, depth + 1)) return true;
    }
  }
  return false;
}

function rejectOperators(req, res, next) {
  if (unsafe(req.body) || unsafe(req.query) || unsafe(req.params)) {
    return res.status(400).json({ success: false, code: 'INVALID_INPUT', message: 'The request contains characters that aren\'t allowed.' });
  }
  return next();
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.isTest ? 100000 : 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again in a minute.' },
  // Provider webhooks come from a few IPs in bursts; they have their own checks.
  skip: (req) => req.originalUrl.startsWith('/api/webhooks') || req.originalUrl.startsWith('/api/funding-actions'),
});

/** URL for request logs with secret path tokens hidden. */
function safeUrl(req) {
  return String(req.originalUrl || req.url || '')
    .replace(/(\/api\/(?:funding-actions|webhooks\/(?:kuda|cashwyre)))\/[^/?\s]+/g, '$1/[hidden]')
    .replace(/([?&](?:token|key|secret|password|pin)=)[^&\s]+/gi, '$1[hidden]');
}

module.exports = { noStore, rejectOperators, apiLimiter, safeUrl, unsafe };
