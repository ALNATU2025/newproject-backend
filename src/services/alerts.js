// Admin alerts (activity feed) and the admin audit log.
const { AdminAlert, AuditLog } = require('../models');

async function raiseAlert({ type, severity = 'info', title, body, user = null, transaction = null }) {
  try {
    return await AdminAlert.create({ type, severity, title, body, user, transaction });
  } catch (e) {
    // Alerts must never break the action that raised them.
    if (process.env.NODE_ENV !== 'test') console.error('alert failed', e.message);
    return null;
  }
}

async function audit(actor, action, { targetUser = null, transaction = null, details = {} } = {}) {
  try {
    return await AuditLog.create({ actor, action, targetUser, transaction, details });
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.error('audit failed', e.message);
    return null;
  }
}

module.exports = { raiseAlert, audit };
