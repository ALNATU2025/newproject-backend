// Gives an existing account the Super Admin role.
//   npm run make-super-admin -- you@example.com
const { connectDb, disconnectDb } = require('../src/config/db');
const { User } = require('../src/models');

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run make-super-admin -- you@example.com');
    process.exit(1);
  }
  await connectDb();
  const user = await User.findOneAndUpdate({ email }, { $set: { role: 'super', isActive: true, isApproved: true } }, { new: true });
  if (!user) {
    console.error(`No account with email ${email}. Sign up in the app first, then run this again.`);
    await disconnectDb();
    process.exit(1);
  }
  console.log(`${user.fullName} <${user.email}> is now a Super Admin.`);
  await disconnectDb();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectDb().catch(() => {});
  process.exit(1);
});
