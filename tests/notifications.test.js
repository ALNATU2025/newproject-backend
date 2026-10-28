// End-to-end check of every notification, for a Nigerian and a Sierra
// Leone account: what the person gets (in-app + phone push) and what the
// admins get (staff phone push + admin webhook).
const crypto = require('crypto');
const { api, auth, useDatabase, signUp, readyUser } = require('./helpers');
const { User, Notification, AdminAlert, Transaction } = require('../src/models');
const env = require('../src/config/env');
const push = require('../src/services/push');

useDatabase('notifications');
// The new-device code is off by default; these tests check it switched on.
beforeAll(() => require('../src/services/settings').updateSettings({ deviceCheck: { enabled: true } }));

const HOOK = 'https://hooks.example.com/dalabapay-n';
const calls = [];
let admin;
let adminPhone;

const settle = () => new Promise((r) => setTimeout(r, 300));
const pushes = () => calls.filter((c) => c.url.includes('fcm.googleapis.com')).map((c) => JSON.parse(c.opts.body).message);
const hooks = () => calls.filter((c) => c.url === HOOK).map((c) => JSON.parse(c.opts.body));
const pushTo = (token) => pushes().filter((m) => m.token === token);
const phoneToken = (tag) => `fcm-${tag}-${crypto.randomBytes(24).toString('hex')}`;

async function withPhone(u, tag) {
  const token = phoneToken(tag);
  const r = await api().post('/api/me/devices').set(auth(u.token)).send({ token, platform: 'android' });
  expect(r.status).toBe(200);
  return token;
}

const device = (id, name = 'Tecno Spark 20') => ({ 'X-Device-Id': id, 'X-Device-Name': name, 'X-Device-Platform': 'android' });
const login = (s, headers = {}) => api().post('/api/auth/login').set(headers).send({ identifier: s.email, password: s.password });

beforeAll(async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  env.firebase.serviceAccount = {
    projectId: 'dalabapay-test',
    clientEmail: 'push@dalabapay-test.iam.gserviceaccount.com',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  Object.assign(env.adminWebhook, { url: HOOK, secret: 'whsec_n' });
  push.setFetch(async (url, opts) => {
    calls.push({ url, opts });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.n', expires_in: 3600 });
    return json(200, { name: 'projects/x/messages/1' });
  });
  admin = await readyUser({ role: 'super' });
  adminPhone = await withPhone(admin, 'admin');
});

afterAll(() => {
  env.firebase.serviceAccount = null;
  Object.assign(env.adminWebhook, { url: '', secret: '' });
});

beforeEach(() => {
  calls.length = 0;
});

for (const country of ['NG', 'SL']) {
  const name = country === 'SL' ? 'Sierra Leone' : 'Nigeria';

  describe(`${name}`, () => {
    test('new sign-up: admins are told (webhook + staff phone), the person is welcomed', async () => {
      const s = await signUp({ country });
      await settle();
      const e = hooks().find((h) => h.event === 'alert.new_user');
      expect(e).toBeTruthy();
      expect(e.body).toContain(s.email);
      if (country === 'SL') expect(e.title).toMatch(/approve/);
      expect(pushTo(adminPhone).some((m) => m.data.event === 'alert.new_user')).toBe(true);
      expect(await Notification.exists({ user: s.user.id, title: 'Welcome to Dalabapay' })).toBeTruthy();
    });

    test('sign-in on a new device: the person and the admins are told, once', async () => {
      const s = await signUp({ country });
      const phone = await withPhone(s, 'dev');
      const A = crypto.randomBytes(16).toString('hex');
      const B = crypto.randomBytes(16).toString('hex');

      // First device of the account: remembered quietly.
      expect((await login(s, device(A, 'Old phone'))).status).toBe(200);
      await settle();
      expect(hooks().some((h) => h.event === 'alert.new_device')).toBe(false);

      calls.length = 0;
      // A new device must enter a code emailed to the account first.
      const challenge = await login(s, device(B, 'Samsung A15'));
      expect(challenge.status).toBe(200);
      expect(challenge.body.data).toEqual(expect.objectContaining({ verification: 'device' }));
      expect(challenge.body.data.token).toBeUndefined();
      const v = await api().post('/api/auth/login/verify-device').set(device(B, 'Samsung A15'))
        .send({ challenge: challenge.body.data.challenge, code: challenge.body.data.devCode });
      expect(v.status).toBe(200);
      expect(v.body.data.token).toBeTruthy();
      await settle();
      const alert = hooks().find((h) => h.event === 'alert.new_device');
      expect(alert).toEqual(expect.objectContaining({ severity: 'warning' }));
      expect(alert.title).toContain(name);
      expect(alert.body).toContain('Samsung A15');
      expect(pushTo(adminPhone).some((m) => m.data.event === 'alert.new_device')).toBe(true);
      const mine = pushTo(phone).find((m) => m.notification.title === 'New device sign-in');
      expect(mine.notification.body).toContain('Samsung A15');
      expect(mine.data.kind).toBe('security');

      // Same devices again: nothing new.
      calls.length = 0;
      await login(s, device(B, 'Samsung A15'));
      await login(s, device(A, 'Old phone'));
      await settle();
      expect(hooks().some((h) => h.event === 'alert.new_device')).toBe(false);
      expect(await AdminAlert.countDocuments({ user: s.user.id, type: 'new_device' })).toBe(1);

      // The device id is never stored as is.
      const u = await User.findById(s.user.id).select('+knownDevices');
      expect(u.knownDevices).toHaveLength(2);
      expect(JSON.stringify(u.knownDevices)).not.toContain(A);
    });

    test('failed logins: suspicious activity reaches admins and the person', async () => {
      const s = await signUp({ country });
      const phone = await withPhone(s, 'sus');
      calls.length = 0;
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await api().post('/api/auth/login').send({ identifier: s.email, password: 'WrongPass123' });
      }
      await settle();
      expect(hooks().find((h) => h.event === 'alert.suspicious')).toEqual(expect.objectContaining({ severity: 'critical' }));
      expect(pushTo(phone).some((m) => m.notification.title === 'Failed login attempts')).toBe(true);
    });

    test('payment: the person gets a push, admins get the debit', async () => {
      const u = await readyUser({ country });
      const phone = await withPhone(u, 'pay');
      await User.updateOne({ _id: u.user.id }, { $set: { balance: 5000 * 100 } });
      calls.length = 0;
      const r = country === 'SL'
        ? await api().post('/api/services/sl/airtime').set(auth(u.token)).send({ network: 'africell', phone: '076555123', amount: 20, pin: u.pin })
        : await api().post('/api/services/airtime').set(auth(u.token)).send({ network: 'mtn', phone: '08039999999', amount: 800, pin: u.pin });
      expect(r.status).toBe(201);
      await settle();
      const mine = pushTo(phone).find((m) => m.data.kind === 'payment');
      expect(mine.notification.title).toMatch(/^Payment (successful|pending|failed)$/);
      const debit = hooks().find((h) => h.event === 'transaction.debit');
      expect(debit.title).toContain(country === 'SL' ? 'Le 20.00' : '₦800.00');
      expect(pushTo(adminPhone).some((m) => m.data.event === 'transaction.debit')).toBe(true);
    });

    test('transfer between users: both sides get a push', async () => {
      const a = await readyUser({ country });
      const b = await readyUser({ country });
      const pa = await withPhone(a, 'tra');
      const pb = await withPhone(b, 'trb');
      await User.updateOne({ _id: a.user.id }, { $set: { balance: 1000 * 100 } });
      calls.length = 0;
      const r = await api().post('/api/wallet/transfer').set(auth(a.token)).send({ phone: b.phone, amount: country === 'SL' ? 30 : 300, pin: a.pin });
      expect(r.status).toBe(201);
      await settle();
      expect(pushTo(pa).some((m) => m.notification.title === 'Money sent')).toBe(true);
      expect(pushTo(pb).some((m) => m.notification.title === 'Money received')).toBe(true);
      const events = hooks().map((h) => h.event);
      expect(events).toEqual(expect.arrayContaining(['transaction.debit', 'transaction.credit']));
    });

    test('admin message: pushed and in the in-app list', async () => {
      const u = await readyUser({ country });
      const phone = await withPhone(u, 'msg');
      calls.length = 0;
      const r = await api().post('/api/admin/broadcasts').set(auth(admin.token)).send({ title: `Hello ${country}`, message: 'Service update', audience: 'selected', userIds: [u.user.id] });
      expect(r.status).toBe(201);
      await settle();
      expect(pushTo(phone).find((m) => m.notification.title === `Hello ${country}`)).toBeTruthy();
      const list = (await api().get('/api/notifications').set(auth(u.token))).body.data;
      expect(JSON.stringify(list)).toContain(`Hello ${country}`);
    });
  });
}

describe('funding', () => {
  beforeAll(async () => {
    const r = await api().patch('/api/admin/settings').set(auth(admin.token)).send({
      slFunding: { methods: [{ id: 'orange', name: 'Orange Money', account: '076000111', accountName: 'Dalabapay SL' }] },
    });
    expect(r.status).toBe(200);
  });

  test('Nigeria: automatic bank transfer credits the wallet and tells both sides', async () => {
    const u = await readyUser({});
    const phone = await withPhone(u, 'ngfund');
    calls.length = 0;
    const r = await api().post('/api/dev/simulate-transfer').set(auth(u.token)).send({ amount: 1000 });
    expect(r.status).toBeLessThan(300);
    await settle();
    expect(pushTo(phone).find((m) => m.notification.title === 'Wallet funded')).toBeTruthy();
    expect(hooks().find((h) => h.event === 'alert.wallet').title).toBe('Wallet funding successful');
    expect(hooks().some((h) => h.event === 'transaction.credit')).toBe(true);
  });

  test('Sierra Leone: top-up request alerts admins; approval credits and tells the person', async () => {
    const u = await readyUser({ country: 'SL' });
    const phone = await withPhone(u, 'slfund');
    calls.length = 0;
    const req = await api().post('/api/wallet/fund/sl-request').set(auth(u.token)).send({ amount: 100, method: 'orange', reference: `OM${Date.now()}`, senderNumber: '076222333' });
    expect(req.status).toBe(201);
    await settle();
    expect(pushTo(phone).find((m) => m.notification.title === 'Top-up received')).toBeTruthy();
    const ask = hooks().find((h) => h.event === 'alert.wallet');
    expect(ask).toEqual(expect.objectContaining({ title: 'Sierra Leone top-up to confirm', severity: 'warning' }));
    expect(pushTo(adminPhone).some((m) => m.notification.title === 'Sierra Leone top-up to confirm')).toBe(true);

    calls.length = 0;
    const id = req.body.data.transaction.id;
    const ok = await api().patch(`/api/admin/transactions/${id}/status`).set(auth(admin.token)).send({ status: 'success' });
    expect(ok.status).toBe(200);
    await settle();
    const funded = pushTo(phone).find((m) => m.notification.title === 'Wallet funded');
    expect(funded.notification.body).toContain('Le 100.00');
    expect((await Transaction.findById(id)).status).toBe('success');
  });

  test('Sierra Leone: a rejected top-up tells the person', async () => {
    const u = await readyUser({ country: 'SL' });
    const phone = await withPhone(u, 'slrej');
    const req = await api().post('/api/wallet/fund/sl-request').set(auth(u.token)).send({ amount: 50, method: 'orange', reference: `OM${Date.now()}9` });
    calls.length = 0;
    await api().patch(`/api/admin/transactions/${req.body.data.transaction.id}/status`).set(auth(admin.token)).send({ status: 'failed', note: 'Payment not found' });
    await settle();
    expect(pushTo(phone).find((m) => m.notification.title === 'Top-up not completed').notification.body).toContain('Payment not found');
  });
});

describe('account approval (Sierra Leone)', () => {
  test('the person is told when the account is approved', async () => {
    const u = await readyUser({ country: 'SL', pending: true });
    const phone = await withPhone(u, 'appr');
    calls.length = 0;
    expect((await api().post(`/api/admin/users/${u.user.id}/approve`).set(auth(admin.token))).status).toBe(200);
    await settle();
    expect(pushTo(phone).length).toBeGreaterThan(0);
  });
});

describe('admin "send test notification"', () => {
  test('reports what is set up and sends a push + webhook event', async () => {
    const r = await api().post('/api/admin/notifications/test').set(auth(admin.token));
    expect(r.status).toBe(200);
    expect(r.body.data.push).toEqual(expect.objectContaining({ configured: true, devices: 1, delivered: 1 }));
    expect(r.body.data.webhook).toEqual({ configured: true, ok: true });
    expect(r.body.data.staffWithPhones).toBeGreaterThanOrEqual(1);
    expect(pushTo(adminPhone).find((m) => m.notification.title === 'Dalabapay test notification')).toBeTruthy();
    expect(hooks().find((h) => h.event === 'test')).toBeTruthy();
  });

  test('says so when push is not set up', async () => {
    const saved = env.firebase.serviceAccount;
    env.firebase.serviceAccount = null;
    try {
      const r = await api().post('/api/admin/notifications/test').set(auth(admin.token));
      expect(r.body.data.push).toEqual(expect.objectContaining({ configured: false, delivered: 0 }));
    } finally {
      env.firebase.serviceAccount = saved;
    }
  });

  test('ordinary users cannot use it', async () => {
    const u = await readyUser({});
    expect((await api().post('/api/admin/notifications/test').set(auth(u.token))).status).toBe(403);
  });
});
