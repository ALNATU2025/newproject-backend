const { api, auth, useDatabase, signUp, readyUser, balanceOf } = require('./helpers');

useDatabase('wallet');

const afterFee = (n) => Math.round((n - Math.floor(n * 1.5) / 100) * 100) / 100;

describe('funding', () => {
  test('bank transfer credits the wallet minus the 1.5% fee', async () => {
    const u = await readyUser({ fund: 10000 });
    const w = await balanceOf(u.token);
    expect(w.balance).toBe(afterFee(10000));
    const home = await api().get('/api/me/home').set(auth(u.token));
    expect(home.body.data.recentTransactions[0].type).toBe('wallet_funding');
    expect(home.body.data.unreadNotifications).toBeGreaterThan(0);
  });

  test('one-time account then webhook credits once', async () => {
    const u = await readyUser();
    const r = await api().post('/api/wallet/fund/one-time').set(auth(u.token)).send({ amount: 2000, pin: u.pin });
    expect(r.status).toBe(200);
    const { reference, accountNumber } = r.body.data.account;
    expect(accountNumber).toMatch(/^\d{10}$/);
    const hook = () =>
      api()
        .post('/api/webhooks/payment')
        .set('x-webhook-secret', 'test-webhook-secret')
        .send({ reference, amount: 2000, providerReference: 'PRV-1' });
    expect((await hook()).body.data.credited).toBe(true);
    expect((await hook()).body.data.credited).toBe(false);
    expect((await balanceOf(u.token)).balance).toBe(afterFee(2000));
    const bad = await api().post('/api/webhooks/payment').send({ reference, amount: 2000 });
    expect(bad.status).toBe(401);
  });

  test('assisted funding stays pending until an admin approves it', async () => {
    const u = await readyUser();
    const admin = await readyUser({ role: 'admin' });
    const r = await api().post('/api/wallet/fund/assisted').set(auth(u.token)).send({ amount: 5000, pin: u.pin });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction.status).toBe('pending');
    expect((await balanceOf(u.token)).balance).toBe(0);
    const approve = await api()
      .patch(`/api/admin/transactions/${r.body.data.transaction.id}/status`)
      .set(auth(admin.token))
      .send({ status: 'success', note: 'Cash received' });
    expect(approve.status).toBe(200);
    expect((await balanceOf(u.token)).balance).toBe(5000);
    const again = await api()
      .patch(`/api/admin/transactions/${r.body.data.transaction.id}/status`)
      .set(auth(admin.token))
      .send({ status: 'success' });
    expect(again.status).toBe(400);
    expect((await balanceOf(u.token)).balance).toBe(5000);
  });

  test('verify-payment finds own top-ups by reference', async () => {
    const u = await readyUser({ fund: 1000 });
    const list = await api().get('/api/wallet/fundings').set(auth(u.token));
    const ref = list.body.data.items[0].reference;
    const r = await api().post('/api/wallet/verify-payment').set(auth(u.token)).send({ reference: ref });
    expect(r.body.data.status).toBe('success');
    const missing = await api().post('/api/wallet/verify-payment').set(auth(u.token)).send({ reference: 'NOPE123456' });
    expect(missing.body.data.status).toBe('not_found');
  });
});

describe('referral bonus', () => {
  test('first deposit of ₦5,000+ pays both people once', async () => {
    const referrer = await readyUser();
    const friend = await readyUser({ referralCode: referrer.user.referralCode });
    await api().post('/api/dev/simulate-transfer').set(auth(friend.token)).send({ amount: 6000 });
    await api().post('/api/dev/simulate-transfer').set(auth(friend.token)).send({ amount: 6000 });
    expect((await balanceOf(friend.token)).commissionBalance).toBe(200);
    expect((await balanceOf(referrer.token)).commissionBalance).toBe(200);
    const ref = await api().get('/api/referrals').set(auth(referrer.token));
    expect(ref.body.data.breakdown.direct).toBe(200);
    expect(ref.body.data.referrals[0].active).toBe(true);
  });
});

describe('send money', () => {
  test('lookup and transfer move money between wallets', async () => {
    const a = await readyUser({ fund: 10000 });
    const b = await signUp();
    const look = await api().post('/api/wallet/transfer/lookup').set(auth(a.token)).send({ phone: b.phone });
    expect(look.body.data.fullName).toBe(b.user.fullName);
    const t = await api()
      .post('/api/wallet/transfer')
      .set(auth(a.token))
      .send({ phone: b.phone, amount: 2500, note: 'Lunch', pin: a.pin });
    expect(t.status).toBe(201);
    expect((await balanceOf(a.token)).balance).toBe(afterFee(10000) - 2500);
    expect((await balanceOf(b.token)).balance).toBe(2500);
    const hist = await api().get('/api/transactions').set(auth(b.token));
    expect(hist.body.data.items[0].type).toBe('transfer_in');
  });

  test('insufficient balance, self transfer and wrong PIN are refused', async () => {
    const a = await readyUser({ fund: 1000 });
    const b = await signUp();
    const tooMuch = await api().post('/api/wallet/transfer').set(auth(a.token)).send({ phone: b.phone, amount: 5000, pin: a.pin });
    expect(tooMuch.status).toBe(402);
    const self = await api().post('/api/wallet/transfer').set(auth(a.token)).send({ phone: a.phone, amount: 100, pin: a.pin });
    expect(self.status).toBe(400);
    const wrongPin = await api().post('/api/wallet/transfer').set(auth(a.token)).send({ phone: b.phone, amount: 100, pin: '000001' });
    expect(wrongPin.status).toBe(400);
    expect(wrongPin.body.code).toBe('PIN_INVALID');
    expect((await balanceOf(a.token)).balance).toBe(afterFee(1000));
  });

  test('parallel transfers cannot overspend', async () => {
    const a = await readyUser({ fund: 1000 }); // 985 after fee
    const b = await signUp();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api().post('/api/wallet/transfer').set(auth(a.token)).send({ phone: b.phone, amount: 300, pin: a.pin }),
      ),
    );
    const okCount = results.filter((r) => r.status === 201).length;
    expect(okCount).toBe(3);
    expect((await balanceOf(a.token)).balance).toBeCloseTo(85, 2);
    expect((await balanceOf(b.token)).balance).toBe(900);
  });
});

describe('transactions', () => {
  test('list with search and filters', async () => {
    const u = await readyUser({ fund: 5000 });
    await api().post('/api/services/airtime').set(auth(u.token)).send({ network: 'mtn', phone: '08031234567', amount: 200, pin: u.pin });
    const all = await api().get('/api/transactions').set(auth(u.token));
    expect(all.body.data.total).toBe(2);
    const air = await api().get('/api/transactions?type=airtime').set(auth(u.token));
    expect(air.body.data.items).toHaveLength(1);
    const q = await api().get('/api/transactions?q=MTN').set(auth(u.token));
    expect(q.body.data.items[0].service).toBe('airtime');
    const one = await api().get(`/api/transactions/${air.body.data.items[0].id}`).set(auth(u.token));
    expect(one.body.data.reference).toBe(air.body.data.items[0].reference);
  });
});
