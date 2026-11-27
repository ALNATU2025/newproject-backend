// Monime (Sierra Leone): instant Orange Money / Afrimoney Add Money and
// transfers to Sierra Leone mobile money. Monime's API is faked here.
const crypto = require('crypto');
const { api, auth, useDatabase, readyUser, balanceOf } = require('./helpers');
const { User, Transaction } = require('../src/models');
const env = require('../src/config/env');
const monime = require('../src/providers/monime');
const { clearPayoutCache } = require('../src/services/payouts');

useDatabase('monime');

const SECRET = 'whsec_test_123';
const calls = [];
const codes = {}; // id → object
const payouts = {}; // id → object
let n = 0;
let payoutMode = 'ok';

function reply(status, body) {
  const text = JSON.stringify(body);
  return { ok: status < 300, status, text: async () => text };
}
async function fakeMonime(url, opts) {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method: opts.method, path: u.pathname + u.search, body, headers: opts.headers });
  const ok = (result) => reply(200, { success: true, messages: [], result });
  if (opts.method === 'GET' && u.pathname === '/v1/momos') {
    return ok([
      { providerId: 'm17', name: 'Orange Money', country: 'SL', status: { active: true }, featureSet: { payout: { canPayTo: true }, payment: { canPayFrom: true } } },
      { providerId: 'm18', name: 'Afrimoney', country: 'SL', status: { active: true }, featureSet: { payout: { canPayTo: true }, payment: { canPayFrom: true } } },
    ]);
  }
  if (opts.method === 'GET' && u.pathname === '/v1/banks') return ok([{ providerId: 'slb001', name: 'Rokel Commercial Bank', status: { active: true } }]);
  if (opts.method === 'POST' && u.pathname === '/v1/payment-codes') {
    if (body.authorizedPhoneNumber && body.authorizedProviders) {
      return reply(400, { success: false, error: { message: 'A payment provider must not be set when a paying phone number is specified.' } });
    }
    n += 1;
    const id = `pmc-${n}`;
    codes[id] = { id, status: 'pending', amount: body.amount, ussdCode: `*715*1*0*${100000 + n}#`, reference: body.reference, metadata: body.metadata, expireTime: '2026-11-26T22:45:00Z' };
    return ok(codes[id]);
  }
  const pc = u.pathname.match(/^\/v1\/payment-codes\/(.+)$/);
  if (pc && opts.method === 'GET') return codes[pc[1]] ? ok(codes[pc[1]]) : reply(404, { success: false, messages: ['not found'] });
  if (pc && opts.method === 'DELETE') {
    codes[pc[1]].status = 'cancelled';
    return ok({});
  }
  if (opts.method === 'POST' && u.pathname === '/v1/payouts') {
    if (payoutMode === 'decline') return reply(400, { success: false, messages: ['Insufficient balance in financial account'] });
    n += 1;
    const id = `pyt-${n}`;
    payouts[id] = { id, status: 'pending', amount: body.amount, destination: body.destination, metadata: body.metadata };
    return ok(payouts[id]);
  }
  const po = u.pathname.match(/^\/v1\/payouts\/(.+)$/);
  if (po) return ok(payouts[po[1]]);
  return reply(404, { success: false, messages: [`unknown ${opts.method} ${u.pathname}`] });
}

const sign = (raw, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', SECRET).update(`${t}_${raw}`).digest('base64')}`;
const hook = (event, object) => {
  const raw = JSON.stringify({ apiVersion: 'caph.2025-08-23', event: { id: `wke-${Date.now()}`, name: event, timestamp: `${Math.floor(Date.now() / 1000)}` }, object: { id: object.id, type: event.split('.')[0] }, data: object });
  return api().post('/api/webhooks/monime').set('Content-Type', 'application/json').set('monime-signature', sign(raw)).send(raw);
};

beforeAll(() => {
  Object.assign(env.monime, { accessToken: 'mon_live_token', spaceId: 'spc-test', webhookSecret: SECRET, baseUrl: 'https://api.monime.test', amountUnit: 'minor', mode: 'live' });
  monime.setFetch(fakeMonime);
  clearPayoutCache();
});
afterAll(() => {
  Object.assign(env.monime, { accessToken: '', spaceId: '', webhookSecret: '', mode: 'test' });
  monime.setFetch(null);
});
beforeEach(() => {
  calls.length = 0;
  payoutMode = 'ok';
});

describe('Add Money with Orange Money / Afrimoney', () => {
  test('a code to dial; Monime confirms; the wallet is credited once', async () => {
    const u = await readyUser({ country: 'SL', fullName: 'Aminata Kamara' });
    const t = auth(u.token);
    const opts = (await api().get('/api/wallet/fund/monime').set(t)).body.data;
    expect(opts.available).toBe(true);
    expect(opts.providers).toEqual([{ id: 'm17', name: 'Orange Money' }, { id: 'm18', name: 'Afrimoney' }]);

    const r = await api().post('/api/wallet/fund/monime').set(t).send({ amount: 250, providerId: 'm17', phone: '076 123 456' });
    expect(r.status).toBe(201);
    expect(r.body.data.ussdCode).toMatch(/^\*715\*/);
    expect(r.body.data.transaction.status).toBe('pending');
    const create = calls.find((c) => c.path === '/v1/payment-codes');
    expect(create.body).toEqual(expect.objectContaining({ mode: 'one_time', amount: { currency: 'SLE', value: 25000 }, authorizedProviders: ['m17'], authorizedPhoneNumber: '+23276123456' }));
    expect(create.headers.Authorization).toBe('Bearer mon_live_token');
    expect(create.headers['Monime-Space-Id']).toBe('spc-test');
    expect(create.headers['Idempotency-Key']).toMatch(/^pc-MN/);

    const before = (await balanceOf(u.token)).balance;
    const txn = await Transaction.findById(r.body.data.transaction.id);
    const code = codes[txn.providerReference];

    // Not signed / wrong signature → refused, nothing credited.
    const raw = JSON.stringify({ event: { name: 'payment_code.completed' }, object: { id: code.id }, data: code });
    expect((await api().post('/api/webhooks/monime').set('Content-Type', 'application/json').send(raw)).status).toBe(401);
    expect((await api().post('/api/webhooks/monime').set('Content-Type', 'application/json').set('monime-signature', 't=1,v1=AAAA').send(raw)).status).toBe(401);

    // A webhook claiming "completed" while Monime says pending: not credited.
    const early = await hook('payment_code.completed', { ...code, status: 'completed' });
    expect(early.body.data.result).toBe('pending');

    code.status = 'completed';
    code.processedPaymentData = { amount: { currency: 'SLE', value: 25000 } };
    const done = await hook('payment_code.completed', code);
    expect(done.status).toBe(200);
    expect(done.body.data).toEqual(expect.objectContaining({ matched: true, result: 'success', credited: true }));
    expect((await balanceOf(u.token)).balance).toBeCloseTo(before + 250, 2);
    const again = await hook('payment_code.completed', code);
    expect(again.body.data.result).toBe('success');
    expect((await balanceOf(u.token)).balance).toBeCloseTo(before + 250, 2);
    const st = (await api().get(`/api/wallet/fund/monime/${txn._id}`).set(t)).body.data;
    expect(st.transaction.status).toBe('success');
  });

  test('not paid in time → failed, nothing credited; cancel; checks', async () => {
    const u = await readyUser({ country: 'SL' });
    const t = auth(u.token);
    const r = await api().post('/api/wallet/fund/monime').set(t).send({ amount: 100, providerId: 'm18', phone: '+23277000111' });
    const id = r.body.data.transaction.id;
    codes[(await Transaction.findById(id)).providerReference].status = 'expired';
    expect((await api().get(`/api/wallet/fund/monime/${id}`).set(t)).body.data.transaction.status).toBe('failed');

    const r2 = await api().post('/api/wallet/fund/monime').set(t).send({ amount: 100, providerId: 'm18', phone: '077000111' });
    const c = await api().post(`/api/wallet/fund/monime/${r2.body.data.transaction.id}/cancel`).set(t);
    expect(c.body.data.transaction.status).toBe('failed');
    expect((await balanceOf(u.token)).balance).toBe(0);

    expect((await api().post('/api/wallet/fund/monime').set(t).send({ amount: 100, providerId: 'm99', phone: '077000111' })).body.code).toBe('INVALID_METHOD');
    expect((await api().post('/api/wallet/fund/monime').set(t).send({ amount: 100, providerId: 'm17', phone: '0803111222' })).body.code).toBe('INVALID_PHONE');
    expect((await api().post('/api/wallet/fund/monime').set(t).send({ amount: 1, providerId: 'm17', phone: '077000111' })).body.code).toBe('AMOUNT_OUT_OF_RANGE');
    const ng = await readyUser({});
    expect((await api().post('/api/wallet/fund/monime').set(auth(ng.token)).send({ amount: 100, providerId: 'm17', phone: '077000111' })).status).toBe(403);
  });
});

describe('Transfers to Sierra Leone mobile money through Monime', () => {
  const sl = async (le = 1000) => {
    const u = await readyUser({ country: 'SL' });
    await User.updateOne({ _id: u.user.id }, { $set: { balance: le * 100 } });
    return u;
  };
  const quote = (u, extra = {}) => api().post('/api/payouts/quote').set(auth(u.token)).send({
    country: 'SL', accountType: 'mobile_money', bankCode: 'm17', accountNumber: '076123456', accountName: 'Ibrahim Conteh', amount: 200, ...extra,
  });

  test('Orange Money / Afrimoney listed; paid out from Monime; webhook settles', async () => {
    const u = await sl();
    const c = (await api().get('/api/payouts/countries').set(auth(u.token))).body.data;
    expect(c.countries.find((x) => x.code === 'SL')).toEqual(expect.objectContaining({ provider: 'monime', available: true }));
    const wallets = (await api().get('/api/payouts/banks').query({ country: 'SL', type: 'mobile_money' }).set(auth(u.token))).body.data;
    expect(wallets.map((w) => w.name)).toEqual(['Orange Money', 'Afrimoney']);

    const q = await quote(u);
    expect(q.status).toBe(200);
    const charge = q.body.data.charge; // ₦ amount + Dalabapay's transfer fee % (no Monime fee set)
    expect(charge).toBeGreaterThanOrEqual(200);
    expect(charge).toBeLessThan(210);
    const s = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: q.body.data.quoteToken, pin: u.pin });
    expect(s.status).toBe(201);
    const sent = calls.find((x) => x.path === '/v1/payouts');
    expect(sent.body).toEqual(expect.objectContaining({ amount: { currency: 'SLE', value: 20000 }, destination: { type: 'momo', providerId: 'm17', phoneNumber: '+23276123456' } }));
    const t = await Transaction.findById(s.body.data.transaction.id);
    expect(t.provider).toBe('monime');
    expect(t.status).toBe('pending');
    expect((await balanceOf(u.token)).balance).toBeCloseTo(1000 - charge, 2);

    payouts[t.providerReference].status = 'completed';
    const w = await hook('payout.completed', payouts[t.providerReference]);
    expect(w.body.data).toEqual(expect.objectContaining({ result: 'success' }));
    expect((await Transaction.findById(t._id)).status).toBe('success');
  });

  test('declined or failed: refunded', async () => {
    const u = await sl();
    payoutMode = 'decline';
    const q = await quote(u, { amount: 150 });
    const s = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: q.body.data.quoteToken, pin: u.pin });
    expect(s.body.code).toBe('TRANSFER_DECLINED');
    expect((await balanceOf(u.token)).balance).toBeCloseTo(1000, 2);

    payoutMode = 'ok';
    const q2 = await quote(u, { amount: 120, accountNumber: '077999888' });
    const s2 = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: q2.body.data.quoteToken, pin: u.pin });
    const t = await Transaction.findById(s2.body.data.transaction.id);
    payouts[t.providerReference].status = 'failed';
    payouts[t.providerReference].failureDetail = { code: 'invalid_account', message: 'Wallet not found' };
    await hook('payout.failed', payouts[t.providerReference]);
    const after = await Transaction.findById(t._id);
    expect(after.status).toBe('failed');
    expect(after.metadata.failureReason).toBe('Wallet not found');
    expect((await balanceOf(u.token)).balance).toBeCloseTo(1000, 2);
  });
});

test('signature check', () => {
  const raw = '{"a":1}';
  expect(monime.verifySignature(sign(raw), Buffer.from(raw))).toBe(true);
  expect(monime.verifySignature(sign(raw), Buffer.from('{"a":2}'))).toBe(false);
  expect(monime.verifySignature(sign(raw, Math.floor(Date.now() / 1000) - 900), Buffer.from(raw))).toBe(false);
  expect(monime.msisdn('076 123 456')).toBe('+23276123456');
  expect(monime.msisdn('23277000111')).toBe('+23277000111');
});

test('test token (mon_test_): only staff can top up; transfers do not use Monime', async () => {
  const saved = env.monime.accessToken;
  env.monime.accessToken = 'mon_test_abc';
  clearPayoutCache();
  try {
    const customer = await readyUser({ country: 'SL' });
    expect((await api().get('/api/wallet/fund/monime').set(auth(customer.token))).body.data.available).toBe(false);
    expect((await api().post('/api/wallet/fund/monime').set(auth(customer.token)).send({ amount: 50, providerId: 'm17', phone: '076123456' })).status).toBe(403);
    const admin = await readyUser({ country: 'SL', role: 'admin' });
    const o = (await api().get('/api/wallet/fund/monime').set(auth(admin.token))).body.data;
    expect(o).toEqual(expect.objectContaining({ available: true, testMode: true }));
    expect((await api().post('/api/wallet/fund/monime').set(auth(admin.token)).send({ amount: 50, providerId: 'm17', phone: '076123456' })).status).toBe(201);
    expect(monime.testMode()).toBe(true);
  } finally {
    env.monime.accessToken = saved;
    clearPayoutCache();
  }
});

test('without MONIME_MODE=live it stays in test mode, whatever the token looks like', async () => {
  env.monime.mode = 'test';
  try {
    expect(monime.testMode()).toBe(true);
    const customer = await readyUser({ country: 'SL' });
    expect((await api().get('/api/wallet/fund/monime').set(auth(customer.token))).body.data.available).toBe(false);
  } finally {
    env.monime.mode = 'live';
  }
});

test('with Cashwyre transfers off: Send shows Sierra Leone (Monime) only; other countries refused', async () => {
  const savedKeys = { ...env.cashwyre };
  Object.assign(env.cashwyre, { secretKey: 'cw-secret', businessCode: 'cw-biz', payouts: false });
  clearPayoutCache();
  try {
    const u = await readyUser({ country: 'SL' });
    await User.updateOne({ _id: u.user.id }, { $set: { balance: 100000 } });
    const c = (await api().get('/api/payouts/countries').set(auth(u.token))).body.data;
    expect(c.connected).toBe(true);
    expect(c.countries.map((x) => x.code)).toEqual(['SL']);
    expect(c.countries[0]).toEqual(expect.objectContaining({ bank: true, mobileMoney: true, provider: 'monime' }));
    const banks = (await api().get('/api/payouts/banks').query({ country: 'SL', type: 'bank' }).set(auth(u.token))).body.data;
    expect(banks.map((b) => b.name)).toEqual(['Rokel Commercial Bank']);
    expect((await api().get('/api/payouts/banks').query({ country: 'GH', type: 'bank' }).set(auth(u.token))).body.data).toEqual([]);
    const gh = await api().post('/api/payouts/quote').set(auth(u.token)).send({
      country: 'GH', accountType: 'mobile_money', bankCode: 'MTN', accountNumber: '0241234567', accountName: 'Kofi', amount: 50,
    });
    expect(gh.status).toBeGreaterThanOrEqual(400);
  } finally {
    Object.assign(env.cashwyre, savedKeys);
    clearPayoutCache();
  }
});

test('token missing a permission: customer gets a friendly message', async () => {
  monime.setFetch(async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ success: false, error: { message: 'Requires the permissions [paymentcode.paymentcodes:create]' } }) }));
  try {
    const u = await readyUser({ country: 'SL' });
    await User.updateOne({ _id: u.user.id }, { $set: { role: 'admin' } });
    const r = await api().post('/api/wallet/fund/monime').set(auth(u.token)).send({ amount: 10, providerId: 'm17', phone: '076123456' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).not.toMatch(/permissions/);
  } finally {
    monime.setFetch(fakeMonime);
  }
});
