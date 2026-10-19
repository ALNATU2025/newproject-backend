// Start-up tasks: promote owner accounts listed in SUPER_ADMIN_EMAILS.
const env = require('../config/env');
const { User } = require('../models');

async function promoteSuperAdmins() {
  if (!env.superAdminEmails.length) return 0;
  const r = await User.updateMany(
    { email: { $in: env.superAdminEmails }, role: { $ne: 'super' } },
    { $set: { role: 'super', isActive: true, isApproved: true } },
  );
  if (r.modifiedCount) console.log(`Promoted ${r.modifiedCount} account(s) to Super Admin from SUPER_ADMIN_EMAILS`);
  return r.modifiedCount;
}

module.exports = { promoteSuperAdmins };
