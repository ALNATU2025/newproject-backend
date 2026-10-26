const { api, auth, useDatabase, readyUser, signUp, balanceOf } = require('./helpers');

useDatabase('admin');

async function setup() {
  const superAdmin = await readyUser({ role: 'super' });
  const support = await readyUser({ role: 'support' });
  const customer = await readyUser({ fund: 10000 });
  return { superAdmin, support, customer };
}

describe('access control', () => {
  test('customers cannot use admin routes; roles limit actions', async () => {
    const { support, customer } = await setup();
    expect((await api().get('/api/admin/dashboard').set(auth(customer.token))).status).toBe(403);
    expect((await api().get('/api/admin/dashboard').set(auth(support.token))).status).toBe(200);
    // support can read users but not credit wallets
    expect((await api().get('/api/admin/users').set(auth(support.token))).status).toBe(200);
    const credit = await api()
      .post(`/api/admin/users/${customer.user.id}/wallet`)
      .set(auth(support.token))
      .send({ action: 'credit', amount: 100, reason: 'Bonus / Goodwill' });
    expect(credit.status).toBe(403);
    const me = await api().get('/api/admin/me').set(auth(support.token));
    expect(me.body.data.permissions).toContain('disputes:manage');
  });
});

describe('dashboard and users', () => {
  test('dashboard numbers, user list and filters', async () => {
    const { superAdmin } = await setup();
    const d = await api().get('/api/admin/dashboard?period=week').set(auth(superAdmin.token));
    expect(d.status).toBe(200);
    expect(d.body.data.totalUsers).toBeGreaterThanOrEqual(3);
    expect(d.body.data.volume7d).toHaveLength(7);
    const list = await api().get('/api/admin/users?filter=admins').set(auth(superAdmin.token));
    expect(list.body.data.items.every((u) => u.role !== 'user')).toBe(true);
    expect(list.body.data.counts.all).toBeGreaterThanOrEqual(3);
  });

  test('credit, debit, edit, deactivate, approve, PIN unlock/reset, history', async () => {
    const { superAdmin, customer } = await setup();
    const a = auth(superAdmin.token);
    const id = customer.user.id;
    const c = await api().post(`/api/admin/users/${id}/wallet`).set(a).send({ action: 'credit', amount: 500, reason: 'Bonus / Goodwill' });
    expect(c.status).toBe(200);
    expect((await balanceOf(customer.token)).balance).toBe(9850 + 500);
    const tooMuch = await api().post(`/api/admin/users/${id}/wallet`).set(a).send({ action: 'debit', amount: 999999, reason: 'Fraud / Suspicious Activity' });
    expect(tooMuch.status).toBe(402);
    const d = await api().post(`/api/admin/users/${id}/wallet`).set(a).send({ action: 'debit', amount: 350, reason: 'Correcting overcharged amount' });
    expect(d.status).toBe(200);
    expect((await balanceOf(customer.token)).balance).toBe(10000);

    const edit = await api().patch(`/api/admin/users/${id}`).set(a).send({ fullName: 'Renamed Person' });
    expect(edit.body.data.fullName).toBe('Renamed Person');

    // PIN lock then unlock
    for (let i = 0; i < 5; i++) {
      await api().post('/api/auth/pin/verify').set(auth(customer.token)).send({ pin: '000001' });
    }
    expect((await api().get(`/api/admin/users/${id}`).set(a)).body.data.pinLocked).toBe(true);
    await api().post(`/api/admin/users/${id}/pin/unlock`).set(a);
    expect((await api().post('/api/auth/pin/verify').set(auth(customer.token)).send({ pin: customer.pin })).status).toBe(200);
    const reset = await api().post(`/api/admin/users/${id}/pin/reset`).set(a);
    expect(reset.body.data.pinSet).toBe(false);

    const hist = await api().get(`/api/admin/users/${id}/history`).set(a);
    expect(hist.body.data.activity.length).toBeGreaterThanOrEqual(4);
    expect(hist.body.data.transactions.length).toBeGreaterThanOrEqual(3);

    const off = await api().patch(`/api/admin/users/${id}`).set(a).send({ isActive: false });
    expect(off.body.data.isActive).toBe(false);
    expect((await api().get('/api/me').set(auth(customer.token))).status).toBe(401);
    const self = await api().patch(`/api/admin/users/${superAdmin.user.id}`).set(a).send({ isActive: false });
    expect(self.status).toBe(400);
  });
});

describe('transactions, refunds and disputes', () => {
  test('mark pending payment failed refunds once', async () => {
    const { superAdmin, customer } = await setup();
    const p = await api().post('/api/services/airtime').set(auth(customer.token)).send({ network: 'mtn', phone: '08039999999', amount: 800, pin: customer.pin });
    const id = p.body.data.transaction.id;
    expect((await balanceOf(customer.token)).balance).toBe(9850 - 800);
    const fail = await api().patch(`/api/admin/transactions/${id}/status`).set(auth(superAdmin.token)).send({ status: 'failed', note: 'Provider error' });
    expect(fail.status).toBe(200);
    expect(fail.body.data.refunded).toBe(true);
    expect((await balanceOf(customer.token)).balance).toBe(9850);
    const refundAgain = await api().post(`/api/admin/transactions/${id}/refund`).set(auth(superAdmin.token)).send({});
    expect(refundAgain.status).toBe(409);
    expect((await balanceOf(customer.token)).balance).toBe(9850);
  });

  test('pending payment marked success pays commission; list, filter, export', async () => {
    const { superAdmin, customer } = await setup();
    const p = await api().post('/api/services/airtime').set(auth(customer.token)).send({ network: 'mtn', phone: '08049999999', amount: 1000, pin: customer.pin });
    const ok = await api().patch(`/api/admin/transactions/${p.body.data.transaction.id}/status`).set(auth(superAdmin.token)).send({ status: 'success' });
    expect(ok.body.data.status).toBe('success');
    expect((await balanceOf(customer.token)).commissionBalance).toBe(20);
    const list = await api().get('/api/admin/transactions?service=airtime&sort=highest').set(auth(superAdmin.token));
    expect(list.body.data.items[0].user.fullName).toBeTruthy();
    const search = await api().get(`/api/admin/transactions?q=${encodeURIComponent(customer.email)}`).set(auth(superAdmin.token));
    expect(search.body.data.total).toBeGreaterThanOrEqual(2);
    const csv = await api().get('/api/admin/transactions/export.csv').set(auth(superAdmin.token));
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toMatch(/^Date,Reference/);
  });

  test('user dispute → admin approves with refund; reject restores status', async () => {
    const { superAdmin, support, customer } = await setup();
    const p1 = await api().post('/api/services/airtime').set(auth(customer.token)).send({ network: 'glo', phone: '08051111111', amount: 700, pin: customer.pin });
    const p2 = await api().post('/api/services/airtime').set(auth(customer.token)).send({ network: 'glo', phone: '08051111112', amount: 400, pin: customer.pin });
    const eligible = await api().get('/api/disputes/eligible').set(auth(customer.token));
    expect(eligible.body.data.length).toBe(2);
    const d1 = await api().post('/api/disputes').set(auth(customer.token)).send({ transactionId: p1.body.data.transaction.id, type: 'service_not_delivered', reason: 'Airtime not received' });
    expect(d1.status).toBe(201);
    const dup = await api().post('/api/disputes').set(auth(customer.token)).send({ transactionId: p1.body.data.transaction.id, type: 'other', reason: 'again' });
    expect(dup.status).toBe(409);
    const d2 = await api().post('/api/disputes').set(auth(customer.token)).send({ transactionId: p2.body.data.transaction.id, type: 'other', reason: 'Wrong number' });
    const before = (await balanceOf(customer.token)).balance;
    const approve = await api().post(`/api/admin/disputes/${d1.body.data.id}/resolve`).set(auth(support.token)).send({ action: 'approve', resolution: 'Refunded after checking with MTN' });
    expect(approve.body.data.status).toBe('resolved');
    expect((await balanceOf(customer.token)).balance).toBe(before + 700);
    const reject = await api().post(`/api/admin/disputes/${d2.body.data.id}/resolve`).set(auth(superAdmin.token)).send({ action: 'reject', resolution: 'Delivered to the number entered' });
    expect(reject.body.data.status).toBe('rejected');
    expect(reject.body.data.transaction.status).toBe('success');
    const mine = await api().get('/api/disputes').set(auth(customer.token));
    expect(mine.body.data.resolved).toBe(1);
    const queue = await api().get('/api/admin/transactions/refund-queue').set(auth(superAdmin.token));
    expect(queue.body.data.refunded.length).toBeGreaterThanOrEqual(1);
  });
});

describe('payments, broadcasts, alerts, roles', () => {
  test('self-fund needs super + PIN; verify and manual credit', async () => {
    const { superAdmin, support, customer } = await setup();
    expect((await api().post('/api/admin/payments/self-fund').set(auth(support.token)).send({ amount: 100, pin: support.pin })).status).toBe(403);
    const sf = await api().post('/api/admin/payments/self-fund').set(auth(superAdmin.token)).send({ amount: 5000, pin: superAdmin.pin });
    expect(sf.status).toBe(201);
    expect(sf.body.data.balance).toBe(5000);
    const fundings = await api().get('/api/wallet/fundings').set(auth(customer.token));
    const v = await api().post('/api/admin/payments/verify').set(auth(superAdmin.token)).send({ reference: fundings.body.data.items[0].reference });
    expect(v.body.data.status).toBe('success');
    const manual = await api().post('/api/admin/payments/manual').set(auth(superAdmin.token)).send({ user: customer.email, amount: 1500, reference: 'BANK-REF-001' });
    expect(manual.status).toBe(201);
    const again = await api().post('/api/admin/payments/manual').set(auth(superAdmin.token)).send({ user: customer.email, amount: 1500, reference: 'BANK-REF-001' });
    expect(again.status).toBe(400);
    expect((await balanceOf(customer.token)).balance).toBe(9850 + 1500);
  });

  test('broadcast reaches users; alerts feed; mark read', async () => {
    const { superAdmin, customer } = await setup();
    const b = await api().post('/api/admin/broadcasts').set(auth(superAdmin.token)).send({ title: 'Weekend promo', message: 'Extra commission on data', type: 'promotional', audience: 'all' });
    expect(b.status).toBe(201);
    expect(b.body.data.sent).toBeGreaterThanOrEqual(3);
    const n = await api().get('/api/notifications').set(auth(customer.token));
    expect(n.body.data.items[0].title).toBe('Weekend promo');
    expect((await api().post('/api/notifications/read-all').set(auth(customer.token))).body.data.unread).toBe(0);
    const alerts = await api().get('/api/admin/alerts?type=new_user').set(auth(superAdmin.token));
    expect(alerts.body.data.items.length).toBeGreaterThanOrEqual(3);
    await api().post('/api/admin/alerts/read-all').set(auth(superAdmin.token));
    expect((await api().get('/api/admin/alerts').set(auth(superAdmin.token))).body.data.unread).toBe(0);
  });

  test('roles: super admin assigns roles, cannot remove the last super', async () => {
    const { superAdmin, customer } = await setup();
    const a = auth(superAdmin.token);
    const give = await api().post('/api/admin/roles').set(a).send({ email: customer.email, role: 'finance' });
    expect(give.body.data.role).toBe('finance');
    const list = await api().get('/api/admin/roles').set(a);
    expect(list.body.data.admins.some((u) => u.email === customer.email)).toBe(true);
    const self = await api().post('/api/admin/roles').set(a).send({ userId: superAdmin.user.id, role: 'user' });
    expect(self.status).toBe(400);
    const missing = await api().post('/api/admin/roles').set(a).send({ email: 'nobody@example.com', role: 'admin' });
    expect(missing.status).toBe(404);
    const other = await signUp();
    expect((await api().post('/api/admin/roles').set(auth(other.token)).send({ email: other.email, role: 'super' })).status).toBe(403);
  });
});

describe('settings, provider, commission, limits', () => {
  test('settings switch services off and back on', async () => {
    const { superAdmin, customer } = await setup();
    const a = auth(superAdmin.token);
    const s = await api().patch('/api/admin/settings').set(a).send({ services: { data: false }, maintenanceMessage: 'Upgrading' });
    expect(s.body.data.services.data).toBe(false);
    const st = await api().get('/api/services/status').set(auth(customer.token));
    expect(st.body.data.services.data).toBe(false);
    await api().patch('/api/admin/settings').set(a).send({ services: { data: true } });
    expect((await api().get('/api/admin/settings').set(a)).body.data.services.data).toBe(true);
    const prov = await api().get('/api/admin/provider').set(a);
    expect(prov.body.data.bill.name).toBe('simulator');
    expect((await api().post('/api/admin/provider/health').set(a)).body.data.ok).toBe(true);
  });

  test('commission rates change what customers earn', async () => {
    const { superAdmin, customer } = await setup();
    const a = auth(superAdmin.token);
    const airOf = async () =>
      (await api().get('/api/admin/commission?period=today').set(a)).body.data.services.find((x) => x.service === 'airtime');
    const base = await airOf();
    await api().patch('/api/admin/commission/rates/airtime').set(a).send({ user: 5, platform: 1 });
    const p = await api().post('/api/services/airtime').set(auth(customer.token)).send({ network: 'mtn', phone: '08037777777', amount: 1000, pin: customer.pin });
    expect(p.body.data.transaction.commission).toBe(50);
    const air = await airOf();
    expect(air.transactions - base.transactions).toBe(1);
    expect(Math.round((air.revenue - base.revenue) * 100) / 100).toBe(10);
  });

  test('default and per-user limits', async () => {
    const { superAdmin, customer } = await setup();
    const a = auth(superAdmin.token);
    await api().put('/api/admin/limits/defaults').set(a).send({ airtime: { perTxn: 300 } });
    const blocked = await api().post('/api/services/airtime').set(auth(customer.token)).send({ network: 'mtn', phone: '08038888881', amount: 500, pin: customer.pin });
    expect(blocked.body.code).toBe('LIMIT_PER_TRANSACTION');
    await api().put(`/api/admin/limits/users/${customer.user.id}`).set(a).send({ airtime: { perTxn: 1000, daily: 1200 } });
    const allowed = await api().post('/api/services/airtime').set(auth(customer.token)).send({ network: 'mtn', phone: '08038888882', amount: 800, pin: customer.pin });
    expect(allowed.status).toBe(201);
    const daily = await api().post('/api/services/airtime').set(auth(customer.token)).send({ network: 'mtn', phone: '08038888883', amount: 600, pin: customer.pin });
    expect(daily.body.code).toBe('LIMIT_DAILY');
    const view = await api().get('/api/admin/limits').set(a);
    expect(view.body.data.overrides).toHaveLength(1);
    await api().put(`/api/admin/limits/users/${customer.user.id}`).set(a).send({ airtime: null });
    expect((await api().get('/api/admin/limits').set(a)).body.data.overrides).toHaveLength(0);
    await api().put('/api/admin/limits/defaults').set(a).send({ airtime: { perTxn: 50000 } });
  });
});

describe('go-live checklist', () => {
  test('lists every check and is not ready in tests', async () => {
    const { superAdmin, support, customer } = await setup();
    const r = await api().get('/api/admin/readiness').set(auth(superAdmin.token));
    expect(r.status).toBe(200);
    expect(r.body.data.ready).toBe(false);
    const keys = r.body.data.checks.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['environment', 'database', 'jwt', 'email', 'vtpass_keys', 'vtpass_env', 'funding', 'admin']));
    expect(r.body.data.checks.find((c) => c.key === 'admin').status).toBe('ok');
    expect((await api().get('/api/admin/readiness').set(auth(support.token))).status).toBe(200);
    expect((await api().get('/api/admin/readiness').set(auth(customer.token))).status).toBe(403);
  });
});

describe('last seen and last used', () => {
  test('admins see last sign-in, last seen and last transaction', async () => {
    const { User } = require('../src/models');
    const admin = await readyUser({ role: 'super' });
    const u = await readyUser({ fund: 1000 });
    await api().post('/api/services/airtime').set(auth(u.token)).send({ network: 'mtn', phone: '08031234567', amount: 100, pin: u.pin });
    // An old "last seen" is refreshed by the next request.
    await User.updateOne({ _id: u.user.id }, { $set: { lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await api().get('/api/me').set(auth(u.token));
    const d = (await api().get(`/api/admin/users/${u.user.id}`).set(auth(admin.token))).body.data;
    expect(new Date(d.lastSeenAt).getTime()).toBeGreaterThan(Date.now() - 60 * 1000);
    expect(d.lastLoginAt).toBeTruthy();
    expect(d.lastTransactionAt).toBeTruthy();
    expect(d.lastTransaction).toMatch(/Airtime/);

    const online = (await api().get('/api/admin/users?filter=online&sort=last_seen').set(auth(admin.token))).body.data;
    expect(online.items.map((x) => x.id)).toContain(u.user.id);
    expect(online.items[0]).toHaveProperty('lastSeenAt');
  });
});
