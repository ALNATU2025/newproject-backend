const env = require('./config/env');
const { connectDb } = require('./config/db');
const { createApp } = require('./app');
const { billProvider } = require('./providers/bill');
const { startPendingSweeper } = require('./services/pendingSweeper');

async function main() {
  await connectDb();
  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(
      `Dalabapay API on :${env.port} (${env.nodeEnv}) · bills=${billProvider().environment} · payments=${env.paymentProvider}`,
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
