const mongoose = require('mongoose');
const env = require('./env');

mongoose.set('strictQuery', true);

let supportsTransactions = false;

async function connectDb(uri = env.mongoUri) {
  await mongoose.connect(uri, { autoIndex: true });
  // Multi-document transactions need a replica set (MongoDB Atlas always is).
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    supportsTransactions = Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch {
    supportsTransactions = false;
  }
  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.disconnect();
}

/**
 * Runs `fn(session)` inside a MongoDB transaction when the server supports
 * it; otherwise runs it without one (`session` is undefined). Wallet updates
 * are written as conditional atomic updates, so they stay safe either way.
 */
async function withTransaction(fn) {
  if (!supportsTransactions) return fn(undefined);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = { connectDb, disconnectDb, withTransaction, supportsTransactions: () => supportsTransactions };
