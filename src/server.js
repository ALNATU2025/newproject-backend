const env = require('./config/env');
const { connectDb } = require('./config/db');
const { createApp } = require('./app');
const { billProvider } = require('./providers/bill');
const { startPendingSweeper } = require('./services/pendingSweeper');
const { promoteSuperAdmins } = require('./services/bootstrap');
const { mailMethod } = require('./services/mail');

async function main() {
  await connectDb();
  for (const w of env.warnings) console.error(`WARNING: ${w}`);
  if (env.isProd && mailMethod() === 'none') {
    console.error('WARNING: no email service (RESEND_API_KEY or SMTP_*) — sign-up codes cannot be sent.');
  }
  await promoteSuperAdmins().catch((e) => console.error('Super admin promotion failed:', e.message));
  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(
      `Dalabapay API on :${env.port} (${env.nodeEnv}) · bills=${billProvider().environment} · vtpass=${env.vtpass.environment}[${env.vtpass.services.join(',')}] · payments=${env.paymentProvider}`,
    );
  });
  startPendingSweeper();
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
