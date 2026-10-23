// Sierra Leone accounts: own services, currency (Leones) and funding.
const { api, auth, useDatabase, signUp, readyUser, balanceOf } = require('./helpers');
const { User, Transaction } = require('../src/models');

useDatabase('sl');

async function slUser({ balance = 0, ...rest } = {}) {
  const u = await readyUser({ country: 'SL', ...rest });
  if (balance) await User.updateOne({ _id: u.user.id }, { $set: { balance: balance * 100 } });
  return u;
}

describe('sign-up and profile', () => {
  test('Sierra Leone account: country, currency and local phone', async () => {
    const s = await signUp({ country: 'SL', phone: '+232 76 123 456' });
    expect(s.user.country).toBe('SL');
    expect(s.user.currency).toBe('SLE');
    expect(s.user.currencySymbol).toBe('Le');
    expect(s.user.phone).toBe('076123456');
    // Login with the international form finds the same account.
    const login = await api().post('/api/auth/login').send({ identifier: '23276123456', password: s.password });
    expect(login.status).toBe(200);
  });

  test('accounts without a country stay Nigerian', async () => {
    const s = await signUp();
    expect(s.user.country).toBe('NG');
    expect(s.user.currency).toBe('NGN');
  });

  test('phone must match the chosen country', async () => {
    const r = await api().post('/api/auth/register').send({
      fullName: 'Wrong Phone', email: 'wrongphone@example.com', country: 'SL', phone: '08031234567', password: 'Passw0rdOk',
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Sierra Leone/);
  });

  test('referral codes only work within a country', async () => {
    const ng = await signUp();
    const r = await api().post('/api/auth/register').send({
      fullName: 'Cross Ref', email: 'crossref@example.com', country: 'SL', phone: '077654321', password: 'Passw0rdOk',
      referralCode: ng.user.referralCode,
    });
    expect(r.body.code).toBe('INVALID_REFERRAL');
  });
});

describe('services per country', () => {
  test('Sierra Leone users can\'t use Nigerian services and vice versa', async () => {
    const sl = await slUser();
    const ng = await readyUser();
    const a = await api().get('/api/services/networks').set(auth(sl.token));
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('WRONG_COUNTRY');
    expect((await api().get('/api/services/status').set(auth(sl.token))).status).toBe(200);
    const b = await api().get('/api/services/sl/networks').set(auth(ng.token));
    expect(b.body.code).toBe('WRONG_COUNTRY');
  });

  test('airtime in Leones with Sierra Leone limits', async () => {
    const u = await slUser({ balance: 500 });
    const nets = (await api().get('/api/services/sl/networks').set(auth(u.token))).body.data;
    expect(nets.map((n) => n.id)).toEqual(['africell', 'orange', 'qcell']);
    const r = await api().post('/api/services/sl/airtime').set(auth(u.token))
      .send({ network: 'africell', phone: '076 555 123', amount: 20, pin: u.pin });
    expect(r.status).toBe(201);
    const t = r.body.data.transaction;
    expect(t.status).toBe('success');
    expect(t.currency).toBe('SLE');
    expect(t.recipient).toBe('076555123');
    expect((await balanceOf(u.token)).balance).toBe(480);
    const big = await api().post('/api/services/sl/airtime').set(auth(u.token))
      .send({ network: 'orange', phone: '076555124', amount: 3000, pin: u.pin });
    expect(big.body.code).toBe('LIMIT_PER_TRANSACTION');
    expect(big.body.message).toMatch(/Le 2,000\.00/);
  });

  test('data plans, EDSA (verified meter, token) and TV', async () => {
    const u = await slUser({ balance: 2000 });
    const plans = (await api().get('/api/services/sl/data/plans?network=orange').set(auth(u.token))).body.data;
    const d = await api().post('/api/services/sl/data').set(auth(u.token))
      .send({ network: 'orange', phone: '078111222', planCode: plans[0].code, pin: u.pin });
    expect(d.body.data.transaction.amount).toBe(plans[0].amount);

    const bad = await api().post('/api/services/sl/electricity/verify').set(auth(u.token)).send({ meterNumber: '12345000' });
    expect(bad.body.code).toBe('NOT_FOUND');
    const m = await api().post('/api/services/sl/electricity/verify').set(auth(u.token)).send({ meterNumber: '37012345678' });
    expect(m.body.data.customerName).toBeTruthy();
    const e = await api().post('/api/services/sl/electricity').set(auth(u.token)).send({ meterNumber: '37012345678', amount: 50, pin: u.pin });
    expect(e.body.data.transaction.metadata.token).toBeTruthy();

    const tvPlans = (await api().get('/api/services/sl/cable/plans?provider=gotv').set(auth(u.token))).body.data;
    const v = await api().post('/api/services/sl/cable/verify').set(auth(u.token)).send({ provider: 'gotv', smartcardNumber: '7012345678' });
    expect(v.body.data.customerName).toBeTruthy();
    const c = await api().post('/api/services/sl/cable').set(auth(u.token))
      .send({ provider: 'gotv', smartcardNumber: '7012345678', planCode: tvPlans[0].code, pin: u.pin });
    expect(c.body.data.transaction.status).toBe('success');
  });

  test('provider not connected: clear message, no money moves', async () => {
    const { setBillProvider, createRouter, billProvider } = require('../src/providers/bill');
    const original = billProvider();
    const none = require('../src/providers/bill/none');
    const sim = require('../src/providers/bill/simulator');
    setBillProvider(createRouter({ base: sim, routes: { sl_airtime: none, sl_data: none, sl_electricity: none, sl_cable: none } }));
    try {
      const u = await slUser({ balance: 100 });
      const r = await api().post('/api/services/sl/airtime').set(auth(u.token))
        .send({ network: 'africell', phone: '076555123', amount: 10, pin: u.pin });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('PROVIDER_NOT_CONFIGURED');
      expect((await balanceOf(u.token)).balance).toBe(100);
      const st = (await api().get('/api/services/status').set(auth(u.token))).body.data;
      expect(st.connected.sl_airtime).toBe(false);
    } finally {
      setBillProvider(original);
    }
  });
});

describe('money between users', () => {
  test('transfers stay within a country', async () => {
    const a = await slUser({ balance: 100 });
    const b = await slUser();
    const ng = await readyUser();
    const cross = await api().post('/api/wallet/transfer/lookup').set(auth(a.token)).send({ phone: ng.phone });
    expect(cross.body.code).toBe('RECIPIENT_OTHER_COUNTRY');
    const r = await api().post('/api/wallet/transfer').set(auth(a.token)).send({ phone: b.phone, amount: 30, pin: a.pin });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction.currency).toBe('SLE');
    expect((await balanceOf(b.token)).balance).toBe(30);
  });
});

describe('adding money in Sierra Leone', () => {
  test('"I\'ve paid" → admin approves → wallet credited, no fee', async () => {
    const admin = await readyUser({ role: 'super' });
    await api().patch('/api/admin/settings').set(auth(admin.token)).send({
      slFunding: { methods: [{ id: 'orange', name: 'Orange Money', account: '076000111', accountName: 'Dalabapay SL' }] },
    });
    const u = await slUser();
    const info = (await api().get('/api/wallet/sl-funding').set(auth(u.token))).body.data;
    expect(info.methods).toEqual([expect.objectContaining({ id: 'orange', account: '076000111' })]);
    expect((await api().post('/api/wallet/fund/one-time').set(auth(u.token)).send({ amount: 100, pin: u.pin })).body.code)
      .toBe('WRONG_COUNTRY');

    const req = await api().post('/api/wallet/fund/sl-request').set(auth(u.token))
      .send({ amount: 250, method: 'orange', reference: 'OM12345678', senderNumber: '076222333' });
    expect(req.status).toBe(201);
    const t = req.body.data.transaction;
    expect(t.status).toBe('pending');
    expect(t.currency).toBe('SLE');
    const again = await api().post('/api/wallet/fund/sl-request').set(auth(u.token))
      .send({ amount: 250, method: 'orange', reference: 'OM12345678' });
    expect(again.body.code).toBe('DUPLICATE_REFERENCE');

    const approve = await api().patch(`/api/admin/transactions/${t.id}/status`).set(auth(admin.token))
      .send({ status: 'success', note: 'Seen on Orange Money' });
    expect(approve.status).toBe(200);
    expect((await balanceOf(u.token)).balance).toBe(250);
    const saved = await Transaction.findById(t.id);
    expect(saved.fee).toBe(0);
  });

  test('admin dashboard is per country', async () => {
    const admin = await readyUser({ role: 'super' });
    const sl = (await api().get('/api/admin/dashboard?period=all&country=SL').set(auth(admin.token))).body.data;
    expect(sl.currency).toBe('SLE');
    expect(sl.recentTransactions.every((x) => x.currency === 'SLE')).toBe(true);
    const ng = (await api().get('/api/admin/dashboard?period=all').set(auth(admin.token))).body.data;
    expect(ng.currency).toBe('NGN');
    expect(ng.recentTransactions.every((x) => x.currency === 'NGN')).toBe(true);
  });
});

describe('login with a country', () => {
  test('country picked at login must match the account', async () => {
    const s = await signUp({ country: 'SL', phone: '079123456' });
    const ok = await api().post('/api/auth/login').send({ identifier: '79 123 456', password: s.password, country: 'SL' });
    expect(ok.status).toBe(200);
    const wrong = await api().post('/api/auth/login').send({ identifier: s.email, password: s.password, country: 'NG' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('WRONG_COUNTRY');
    expect(wrong.body.message).toMatch(/Sierra Leone/);
  });

  test('the app in Chrome on localhost is allowed (CORS)', async () => {
    const r = await api().options('/api/auth/login')
      .set('Origin', 'http://localhost:51607')
      .set('Access-Control-Request-Method', 'POST');
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:51607');
    const other = await api().options('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});
