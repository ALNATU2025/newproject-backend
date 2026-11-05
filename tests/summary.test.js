// The Transactions dashboard: money in / out, by category, over time.
const { api, auth, useDatabase, readyUser, balanceOf } = require('./helpers');
const { User, Transaction } = require('../src/models');

useDatabase('summary');

const sum = (xs, k) => Math.round(xs.reduce((a, x) => a + x[k], 0) * 100) / 100;

test('Nigeria: totals, categories and a daily chart in Naira', async () => {
  const u = await readyUser({ fund: 10000 });
  const t = auth(u.token);
  const funded = (await balanceOf(u.token)).balance;
  expect((await api().post('/api/services/airtime').set(t).send({ network: 'mtn', phone: '08031112222', amount: 1000, pin: u.pin })).status).toBe(201);
  expect((await api().post('/api/services/airtime').set(t).send({ network: 'mtn', phone: '08031112223', amount: 500, pin: u.pin })).status).toBe(201);
  const v = (await api().post('/api/services/cable/verify').set(t).send({ provider: 'gotv', smartcardNumber: '7023456789' })).body.data;
  expect((await api().post('/api/services/cable').set(t).send({
    provider: 'gotv', smartcardNumber: '7023456789', action: 'renew', months: 1, phone: '08031234567', pin: u.pin,
  })).status).toBe(201);
  // A failed one and an old one: counted, but not in the totals.
  await Transaction.create({ user: u.user.id, reference: 'FAILX1', type: 'data', direction: 'debit', amount: 99900, status: 'failed' });
  await Transaction.create({ user: u.user.id, reference: 'OLDX1', type: 'data', direction: 'debit', amount: 50000, status: 'success' });
  await Transaction.collection.updateOne({ reference: 'OLDX1' }, { $set: { createdAt: new Date(Date.now() - 40 * 86400000) } });

  const r = await api().get('/api/transactions/summary').set(t);
  expect(r.status).toBe(200);
  const s = r.body.data;
  expect(s).toEqual(expect.objectContaining({ period: '30d', unit: 'day', currency: 'NGN' }));
  expect(s.moneyIn).toBeCloseTo(funded, 2);
  expect(s.moneyOut).toBeCloseTo(1500 + v.renewalAmount, 2);
  expect(s.net).toBeCloseTo(s.moneyIn - s.moneyOut, 2);
  expect(s.commissionEarned).toBeGreaterThan(0);
  expect(s.counts).toEqual(expect.objectContaining({ success: 4, failed: 1 }));
  const top = Object.fromEntries(s.categories.map((c) => [c.key, c]));
  expect(top.airtime).toEqual(expect.objectContaining({ label: 'Airtime', amount: 1500, count: 2 }));
  expect(top.cable.amount).toBeCloseTo(v.renewalAmount, 2);
  expect(top.data).toBeUndefined();
  expect(sum(s.categories, 'share')).toBeCloseTo(100, 0);
  expect(s.series).toHaveLength(30);
  expect(sum(s.series, 'out')).toBeCloseTo(s.moneyOut, 2);
  expect(sum(s.series, 'in')).toBeCloseTo(s.moneyIn, 2);
  expect(s.series[29].out).toBeCloseTo(s.moneyOut, 2); // all today

  const y = (await api().get('/api/transactions/summary?period=year').set(t)).body.data;
  expect(y.unit).toBe('month');
  expect(y.series).toHaveLength(12);
  expect(y.moneyOut).toBeCloseTo(s.moneyOut + 500, 2); // the 40-day-old one too
  expect(sum(y.series, 'out')).toBeCloseTo(y.moneyOut, 2);

  const w = (await api().get('/api/transactions/summary?period=90d').set(t)).body.data;
  expect(w.unit).toBe('week');
  expect(sum(w.series, 'out')).toBeCloseTo(y.moneyOut, 2);
  const d7 = (await api().get('/api/transactions/summary?period=7d').set(t)).body.data;
  expect(d7.series).toHaveLength(7);
  expect((await api().get('/api/transactions/summary?period=forever').set(t)).status).toBe(400);
});

test('Sierra Leone: in Leones, only their own records', async () => {
  const u = await readyUser({ country: 'SL' });
  await User.updateOne({ _id: u.user.id }, { $set: { balance: 50000 } });
  const r = await api().post('/api/services/sl/airtime').set(auth(u.token))
    .send({ network: 'africell', phone: '076 555 123', amount: 20, pin: u.pin });
  expect(r.status).toBe(201);
  const s = (await api().get('/api/transactions/summary?period=7d').set(auth(u.token))).body.data;
  expect(s.currency).toBe('SLE');
  expect(s.moneyOut).toBe(20);
  expect(s.categories).toEqual([expect.objectContaining({ key: 'airtime', amount: 20, share: 100 })]);
  expect(s.counts.success).toBe(1);
});
