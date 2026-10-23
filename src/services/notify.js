// In-app notifications for users.
const { Notification } = require('../models');

async function notify(userId, { title, body, kind = 'general', data = {} }) {
  try {
    const n = await Notification.create({ user: userId, title, body, kind, data });
    // Also to the user's phone (push), without waiting for it.
    // eslint-disable-next-line global-require
    require('./push').pushToUser(userId, { title, body, data: { kind, notificationId: String(n._id), ...data } }).catch(() => {});
    return n;
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.error('notify failed', e.message);
    return null;
  }
}

module.exports = { notify };
