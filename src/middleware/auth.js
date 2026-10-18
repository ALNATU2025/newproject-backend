const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { User } = require('../models');
const { unauthorized, forbidden } = require('../utils/errors');
const { can } = require('../permissions');

function signToken(user) {
  return jwt.sign({ sub: String(user._id), tv: user.tokenVersion || 0 }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

/** Requires `Authorization: Bearer <token>` and loads req.user. */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();
    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch {
      throw unauthorized('Your session has expired. Please log in again.', 'TOKEN_EXPIRED');
    }
    const user = await User.findById(payload.sub);
    if (!user || (user.tokenVersion || 0) !== payload.tv) {
      throw unauthorized('Your session has expired. Please log in again.', 'TOKEN_EXPIRED');
    }
    if (!user.isActive) {
      throw forbidden('Your account has been deactivated. Please contact support.', 'ACCOUNT_DISABLED');
    }
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/** Requires an admin role that has `permission` (see permissions.js). */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!can(req.user.role, permission)) {
      return next(forbidden('Admin access required for this action.', 'ADMIN_REQUIRED'));
    }
    return next();
  };
}

/** Any admin role. */
function requireAdmin(req, res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.role === 'user') return next(forbidden('Admin access required.', 'ADMIN_REQUIRED'));
  return next();
}

module.exports = { signToken, requireAuth, requirePermission, requireAdmin };
