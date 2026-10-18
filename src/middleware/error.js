const env = require('../config/env');
const { AppError } = require('../utils/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.details ? { errors: err.details } : {}),
    });
  }
  // Duplicate key (unique index)
  if (err && err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'value';
    const label = { email: 'email address', phone: 'phone number', reference: 'reference' }[field] || field;
    return res.status(409).json({ success: false, code: 'DUPLICATE', message: `This ${label} is already in use.` });
  }
  if (err && err.name === 'CastError') {
    return res.status(400).json({ success: false, code: 'BAD_REQUEST', message: 'Invalid id.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, code: 'BAD_JSON', message: 'Invalid JSON body.' });
  }
  if (!env.isTest) console.error(err);
  return res.status(500).json({
    success: false,
    code: 'SERVER_ERROR',
    message: 'Something went wrong. Please try again.',
    ...(env.isProd ? {} : { detail: err && err.message }),
  });
}

module.exports = { notFoundHandler, errorHandler };
