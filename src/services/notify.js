// In-app notifications for users.
const { Notification } = require('../models');

async function notify(userId, { title, body, kind = 'general', data = {} }) {
  try {
    return await Notification.create({ user: userId, title, body, kind, data });
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.error('notify failed', e.message);
    return null;
  }
}

module.exports = { notify };
