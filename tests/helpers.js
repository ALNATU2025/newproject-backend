const request = require('supertest');
const mongoose = require('mongoose');
const { connectDb, disconnectDb } = require('../src/config/db');
const { createApp } = require('../src/app');
const { User } = require('../src/models');
const { clearSettingsCache } = require('../src/services/settings');

const app = createApp();
let counter = 0;

/** Each test file gets its own database. */
function useDatabase(name) {
  beforeAll(async () => {
    const base = process.env.MONGO_URI.replace(/\/[^/?]*(\?|$)/, `/dalabapay_test_${name}$1`);
    await connectDb(base);
    await mongoose.connection.db.dropDatabase();
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  });
  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await disconnectDb();
  });
  beforeEach(() => clearSettingsCache());
}

const api = () => request(app);

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

/** Signs up through the real API (email code flow). Returns { token, user }. */
async function signUp(overrides = {}) {
  counter += 1;
  const n = String(Date.now() + counter).slice(-8);
  const body = {
    fullName: overrides.fullName || `Test User${counter}`,
    email: overrides.email || `user${n}${counter}@example.com`,
    phone: overrides.phone || (overrides.country === 'SL' ? `07${n.slice(-7)}` : `080${n}`),
    password: overrides.password || 'Passw0rdOk',
    referralCode: overrides.referralCode || '',
    ...(overrides.country ? { country: overrides.country } : {}),
  };
  const start = await api().post('/api/auth/register').send(body);
  if (start.status !== 200) throw new Error(`register failed: ${start.status} ${JSON.stringify(start.body)}`);
  const verify = await api()
    .post('/api/auth/register/verify')
    .send({ email: body.email, code: start.body.data.devCode });
  if (verify.status !== 201) throw new Error(`verify failed: ${verify.status} ${JSON.stringify(verify.body)}`);
  return { ...verify.body.data, password: body.password, phone: body.phone, email: body.email };
}

/** Signs up, sets a PIN and optionally funds the wallet (₦). */
async function readyUser({ fund = 0, pin = '135790', role, ...rest } = {}) {
  const s = await signUp(rest);
  await api().post('/api/auth/pin/set').set(auth(s.token)).send({ pin });
  if (fund > 0) {
    await api().post('/api/dev/simulate-transfer').set(auth(s.token)).send({ amount: fund });
  }
  if (role) await User.updateOne({ _id: s.user.id }, { $set: { role } });
  return { ...s, pin };
}

async function balanceOf(token) {
  const r = await api().get('/api/wallet').set(auth(token));
  return r.body.data;
}

module.exports = { app, api, auth, useDatabase, signUp, readyUser, balanceOf };
