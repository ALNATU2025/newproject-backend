// Errors that map straight to an HTTP status and a message the app can show.

class AppError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
    this.details = details;
  }
}

const badRequest = (msg, code = 'BAD_REQUEST', details) => new AppError(400, msg, code, details);
const unauthorized = (msg = 'Please log in again.', code = 'UNAUTHORIZED') => new AppError(401, msg, code);
const paymentRequired = (msg = 'Insufficient wallet balance. Please fund your wallet.') =>
  new AppError(402, msg, 'INSUFFICIENT_FUNDS');
const forbidden = (msg = 'You do not have access to this.', code = 'FORBIDDEN') => new AppError(403, msg, code);
const notFound = (msg = 'Not found.', code = 'NOT_FOUND') => new AppError(404, msg, code);
const conflict = (msg, code = 'CONFLICT') => new AppError(409, msg, code);
const locked = (msg, code = 'LOCKED') => new AppError(423, msg, code);
const tooMany = (msg = 'Too many attempts. Please try again later.') => new AppError(429, msg, 'RATE_LIMITED');
const unavailable = (msg = 'This service is unavailable right now.', code = 'UNAVAILABLE') =>
  new AppError(503, msg, code);

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  paymentRequired,
  forbidden,
  notFound,
  conflict,
  locked,
  tooMany,
  unavailable,
};
