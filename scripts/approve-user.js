// Approves an account from the command line (same as Admin → KYC Review →
// Approve), e.g. for tests or when no admin can log in yet.
//   node scripts/approve-user.js someone@example.com
const { connectDb, disconnectDb } = require('../src/config/db');
const { User } = require('../src/models');

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: node scripts/approve-user.js someone@example.com');
    process.exit(1);
  }
  await connectDb();
  const user = await User.findOneAndUpdate({ email }, { $set: { isApproved: true, approvalNote: null } }, { new: true });
  if (!user) {
    console.error(`No account with email ${email}.`);
    await disconnectDb();
    process.exit(1);
  }
  console.log(`${user.fullName} <${user.email}> is approved.`);
  await disconnectDb();
}

main().catch(async (e) => {
  console.error(e);
  await disconnectDb().catch(() => {});
  process.exit(1);
});
