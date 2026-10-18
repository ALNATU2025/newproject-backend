const crypto = require('crypto');

/** Wraps an async route handler so thrown errors reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Sends `{ success: true, data }`. */
function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

/** Unique, sortable transaction reference: DP + yyyymmddhhmm + 8 random. */
function makeReference(prefix = 'DP') {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(
    d.getUTCHours(),
  )}${pad(d.getUTCMinutes())}`;
  return `${prefix}${stamp}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Random numeric code of the given length (for email codes). */
function numericCode(length = 6) {
  let s = '';
  while (s.length < length) s += crypto.randomInt(0, 10).toString();
  return s;
}

/** Referral code from the first name + 4 random characters, e.g. ADAEZE7K2Q. */
function referralCodeFor(fullName) {
  const base = String(fullName || 'USER')
    .split(/\s+/)[0]
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, 6) || 'USER';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let tail = '';
  for (let i = 0; i < 4; i++) tail += chars[crypto.randomInt(0, chars.length)];
  return base + tail;
}

/** Start of "today" in Lagos time (UTC+1), as a Date in UTC. */
function startOfLagosDay(date = new Date()) {
  const lagos = new Date(date.getTime() + 60 * 60 * 1000);
  lagos.setUTCHours(0, 0, 0, 0);
  return new Date(lagos.getTime() - 60 * 60 * 1000);
}

/** Start date for a dashboard period. */
function periodStart(period, now = new Date()) {
  const day = startOfLagosDay(now);
  switch (period) {
    case 'today':
      return day;
    case 'week':
      return new Date(day.getTime() - 6 * 86400000);
    case 'month':
      return new Date(day.getTime() - 29 * 86400000);
    case 'year':
      return new Date(day.getTime() - 364 * 86400000);
    case 'all':
      return new Date(0);
    default:
      return day;
  }
}

/** Escapes a string for use inside a RegExp (search boxes). */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pagination params from the query string. */
function pageParams(query, defLimit = 20, maxLimit = 100) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
}

/** Shows only the last 4 characters: ****1234 */
function maskTail(v, keep = 4) {
  const s = String(v || '');
  if (s.length <= keep) return s;
  return '*'.repeat(s.length - keep) + s.slice(-keep);
}

module.exports = {
  asyncHandler,
  ok,
  makeReference,
  numericCode,
  referralCodeFor,
  startOfLagosDay,
  periodStart,
  escapeRegex,
  pageParams,
  maskTail,
};
