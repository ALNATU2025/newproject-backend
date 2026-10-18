// Role-based access for the admin console.
//   support  – view users/transactions, handle disputes
//   finance  – + fund wallets, refunds, verify payments, revenue
//   admin    – + edit users, change statuses, notifications, settings, limits
//   super    – everything, including roles and self-funding

const PERMISSIONS = {
  'dashboard:read': ['support', 'finance', 'admin', 'super'],
  'users:read': ['support', 'finance', 'admin', 'super'],
  'users:write': ['admin', 'super'],
  'users:approve': ['admin', 'super'],
  'users:pin': ['support', 'admin', 'super'],
  'transactions:read': ['support', 'finance', 'admin', 'super'],
  'transactions:status': ['admin', 'super'],
  'transactions:export': ['finance', 'admin', 'super'],
  'disputes:manage': ['support', 'finance', 'admin', 'super'],
  'refunds:process': ['finance', 'admin', 'super'],
  'wallet:fund': ['finance', 'admin', 'super'],
  'wallet:self-fund': ['super'],
  'payments:verify': ['finance', 'admin', 'super'],
  'notifications:send': ['admin', 'super'],
  'alerts:read': ['support', 'finance', 'admin', 'super'],
  'roles:manage': ['super'],
  'settings:read': ['support', 'finance', 'admin', 'super'],
  'settings:write': ['admin', 'super'],
  'commission:read': ['finance', 'admin', 'super'],
  'commission:write': ['admin', 'super'],
  'limits:read': ['support', 'finance', 'admin', 'super'],
  'limits:write': ['admin', 'super'],
  'provider:manage': ['admin', 'super'],
};

function can(role, permission) {
  const roles = PERMISSIONS[permission];
  return Boolean(roles && roles.includes(role));
}

function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => can(role, p));
}

module.exports = { PERMISSIONS, can, permissionsFor };
