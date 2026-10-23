// Sierra Leone account levels, approval at sign-up, manual KYC review,
// push notifications and the admin webhook.
const crypto = require('crypto');
const { api, auth, useDatabase, signUp, readyUser, balanceOf } = require('./helpers');
const { User, AdminAlert, KycRequest, Device } = require('../src/models');
const env = require('../src/config/env');
const push = require('../src/services/push');

useDatabase('tiers');

const PHOTO = Buffer.alloc(300, 7).toString('base64');
const sl = (opts = {}) => readyUser({ country: 'SL', ...opts });
const setBalance = (u, le) => User.updateOne({ _id: u.user.id }, { $set: { balance: le * 100 } });
const airtime = (u, amount) =>
  api().post('/api/services/sl/airtime').set(auth(u.token)).send({ network: 'africell', phone: '076555123', amount, pin: u.pin });

let admin;
beforeAll(async () => {
  admin = await readyUser({ role: 'super' });
});

describe('sign-up and approval', () => {
  test('a new Sierra Leone account opens at Tier 1, pending, and admins are alerted', async () => {
    const u = await readyUser({ country: 'SL', pending: true });
    const me = (await api().get('/api/me').set(auth(u.token))).body.data;
    expect(me).toEqual(expect.objectContaining({ isApproved: false, tier: 1 }));
    const alert = await AdminAlert.findOne({ user: u.user.id, type: 'new_user' });
    expect(alert.severity).toBe('warning');
    expect(alert.title).toMatch(/approve/);

    await setBalance(u, 50);
    const blocked = await airtime(u, 10);
    expect(blocked.body.code).toBe('ACCOUNT_PENDING_APPROVAL');

    const list = (await api().get('/api/admin/kyc/accounts').set(auth(admin.token))).body.data;
    expect(list.map((x) => x.id)).toContain(u.user.id);

    const ok = await api().post(`/api/admin/users/${u.user.id}/approve`).set(auth(admin.token));
    expect(ok.status).toBe(200);
    expect((await airtime(u, 10)).status).toBe(201);
  });

  test('admin can turn an account down with a reason', async () => {
    const u = await readyUser({ country: 'SL', pending: true });
    const r = await api().post(`/api/admin/users/${u.user.id}/reject`).set(auth(admin.token)).send({ reason: 'Name does not match ID' });
    expect(r.body.data.approvalNote).toBe('Name does not match ID');
    const t = (await api().get('/api/tiers').set(auth(u.token))).body.data;
    expect(t).toEqual(expect.objectContaining({ approved: false, approvalNote: 'Name does not match ID' }));
  });

  test('Nigerian sign-ups are unchanged (approved, no tiers)', async () => {
    const s = await signUp();
    expect(s.user.isApproved).toBe(true);
    expect(s.user.tier).toBeNull();
    expect((await api().get('/api/tiers').set(auth(s.token))).body.code).toBe('WRONG_COUNTRY');
  });
});

describe('tier limits', () => {
  test('Tier 1: Le 100 a day across services', async () => {
    const u = await sl({ tier: 1 });
    await setBalance(u, 400);
    expect((await airtime(u, 60)).status).toBe(201);
    const over = await airtime(u, 50);
    expect(over.body.code).toBe('TIER_DAILY_LIMIT');
    expect(over.body.message).toMatch(/Le 40\.00/);
    const info = (await api().get('/api/tiers').set(auth(u.token))).body.data;
    expect(info).toEqual(expect.objectContaining({ tier: 1, spentToday: 60, leftToday: 40 }));
    expect(info.tiers.map((t) => [t.tier, t.daily, t.maxBalance])).toEqual([[1, 100, 500], [2, 1000, 5000], [3, 5000, 10000], [4, null, null]]);
  });

  test('Tier 1: the wallet holds at most Le 500 (top-ups and transfers in)', async () => {
    const u = await sl({ tier: 1 });
    await setBalance(u, 450);
    await api().patch('/api/admin/settings').set(auth(admin.token)).send({
      slFunding: { methods: [{ id: 'orange', name: 'Orange Money', account: '076000000', accountName: 'Dalabapay' }] },
    });
    const topup = await api().post('/api/wallet/fund/sl-request').set(auth(u.token)).send({ amount: 100, method: 'orange', reference: 'OM123456' });
    expect(topup.body.code).toBe('TIER_BALANCE_LIMIT');
    expect(topup.body.message).toMatch(/Le 50\.00 more/);

    const sender = await sl({ tier: 4 });
    await setBalance(sender, 1000);
    const me = await User.findById(u.user.id);
    const tr = await api().post('/api/wallet/transfer').set(auth(sender.token)).send({ phone: me.phone, amount: 100, pin: sender.pin });
    expect(tr.body.code).toBe('TIER_BALANCE_LIMIT');
    expect((await balanceOf(sender.token)).balance).toBe(1000);
  });
});

describe('upgrades and manual review', () => {
  test('Tier 2 (ID) approved, Tier 3 (bank) rejected with a reason', async () => {
    const u = await sl({ tier: 1 });
    const skip = await api().post('/api/tiers/upgrade').set(auth(u.token)).send({ tier: 3, bankName: 'Rokel', accountNumber: '0012345678', accountName: 'Fatmata Kamara' });
    expect(skip.body.code).toBe('TIER_ORDER');

    const r2 = await api().post('/api/tiers/upgrade').set(auth(u.token)).send({ tier: 2, docType: 'national_id', docNumber: 'SL998877', front: PHOTO });
    expect(r2.status).toBe(201);
    expect(r2.body.data.status).toBe('pending');
    const again = await api().post('/api/tiers/upgrade').set(auth(u.token)).send({ tier: 2, docType: 'nin', docNumber: 'SL998877', front: PHOTO });
    expect(again.body.code).toBe('REQUEST_PENDING');
    expect(await AdminAlert.exists({ user: u.user.id, type: 'kyc' })).toBeTruthy();

    const queue = (await api().get('/api/admin/kyc/requests').set(auth(admin.token))).body.data;
    const item = queue.find((x) => x.user.id === u.user.id);
    expect(item.files).toBeUndefined(); // documents only when opened
    const full = (await api().get(`/api/admin/kyc/requests/${item.id}`).set(auth(admin.token))).body.data;
    expect(full.details).toEqual(expect.objectContaining({ docType: 'national_id', docNumber: 'SL998877' }));
    expect(full.files[0]).toEqual(expect.objectContaining({ label: 'Document (front)', data: PHOTO }));

    const ok = await api().post(`/api/admin/kyc/requests/${item.id}/approve`).set(auth(admin.token));
    expect(ok.body.data.status).toBe('approved');
    expect((await User.findById(u.user.id)).tier).toBe(2);
    const twice = await api().post(`/api/admin/kyc/requests/${item.id}/approve`).set(auth(admin.token));
    expect(twice.body.code).toBe('ALREADY_REVIEWED');

    const r3 = await api().post('/api/tiers/upgrade').set(auth(u.token)).send({ tier: 3, bankName: 'Rokel Commercial Bank', accountNumber: '0012 3456 78', accountName: 'Fatmata Kamara' });
    expect(r3.status).toBe(201);
    const no = await api().post(`/api/admin/kyc/requests/${r3.body.data.id}/reject`).set(auth(admin.token)).send({ reason: 'Account name does not match' });
    expect(no.body.data.status).toBe('rejected');
    const mine = (await api().get('/api/tiers').set(auth(u.token))).body.data;
    expect(mine.tier).toBe(2);
    expect(mine.requests[0]).toEqual(expect.objectContaining({ tier: 3, status: 'rejected', rejectionReason: 'Account name does not match' }));
    expect((await KycRequest.findById(r3.body.data.id)).details.accountNumber).toBe('0012345678');
  });

  test('pending accounts can\'t ask for upgrades; support staff can view but not approve', async () => {
    const u = await readyUser({ country: 'SL', pending: true });
    const r = await api().post('/api/tiers/upgrade').set(auth(u.token)).send({ tier: 2, docType: 'nin', docNumber: '12345678', front: PHOTO });
    expect(r.body.code).toBe('ACCOUNT_PENDING_APPROVAL');

    const support = await readyUser({ role: 'support' });
    const v = await sl({ tier: 1 });
    const req2 = await api().post('/api/tiers/upgrade').set(auth(v.token)).send({ tier: 2, docType: 'passport', docNumber: 'P123456', front: PHOTO });
    expect((await api().get(`/api/admin/kyc/requests/${req2.body.data.id}`).set(auth(support.token))).status).toBe(200);
    expect((await api().post(`/api/admin/kyc/requests/${req2.body.data.id}/approve`).set(auth(support.token))).status).toBe(403);
  });
});

describe('push notifications and admin webhook', () => {
  const calls = [];
  beforeAll(() => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    env.firebase.serviceAccount = {
      projectId: 'dalabapay-test',
      clientEmail: 'push@dalabapay-test.iam.gserviceaccount.com',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
    Object.assign(env.adminWebhook, { url: 'https://hooks.example.com/dalabapay', secret: 'whsec_test' });
    push.setFetch(async (url, opts) => {
      calls.push({ url, opts });
      const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
      if (url === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'ya29.test', expires_in: 3600 });
      if (url.includes('fcm.googleapis.com')) {
        const { message } = JSON.parse(opts.body);
        if (message.token.startsWith('dead')) return json(404, { error: { status: 'NOT_FOUND' } });
        return json(200, { name: 'projects/x/messages/1' });
      }
      return json(200, {});
    });
  });
  afterAll(() => {
    env.firebase.serviceAccount = null;
    Object.assign(env.adminWebhook, { url: '', secret: '' });
  });

  const settle = () => new Promise((r) => setTimeout(r, 300));

  test('users get pushes; admins get the webhook (signed) and pushes', async () => {
    const u = await sl({ tier: 4 });
    const token = `fcm-${'x'.repeat(40)}`;
    expect((await api().post('/api/me/devices').set(auth(u.token)).send({ token, platform: 'android' })).status).toBe(200);
    await api().post('/api/me/devices').set(auth(u.token)).send({ token: `dead-${'y'.repeat(40)}` });
    const adminToken = `fcm-admin-${'z'.repeat(40)}`;
    await api().post('/api/me/devices').set(auth(admin.token)).send({ token: adminToken });

    calls.length = 0;
    await setBalance(u, 500);
    expect((await airtime(u, 20)).status).toBe(201);
    await settle();

    const fcm = calls.filter((c) => c.url.includes('fcm.googleapis.com')).map((c) => JSON.parse(c.opts.body).message);
    const toUser = fcm.find((m) => m.token === token);
    expect(toUser.notification.title).toBe('Payment successful');
    expect(toUser.data.kind).toBe('payment');
    expect(calls.find((c) => c.url.includes('fcm')).opts.headers.Authorization).toBe('Bearer ya29.test');
    // Stale tokens are dropped.
    expect(await Device.exists({ token: `dead-${'y'.repeat(40)}` })).toBeNull();

    const hooks = calls.filter((c) => c.url === 'https://hooks.example.com/dalabapay');
    const debit = hooks.map((h) => JSON.parse(h.opts.body)).find((b) => b.event === 'transaction.debit');
    expect(debit).toEqual(expect.objectContaining({ title: expect.stringMatching(/Debit Le 20\.00/), text: expect.any(String) }));
    const h = hooks.find((x) => JSON.parse(x.opts.body).event === 'transaction.debit');
    const sig = crypto.createHmac('sha256', 'whsec_test').update(h.opts.body).digest('hex');
    expect(h.opts.headers['X-Dalabapay-Signature']).toBe(`sha256=${sig}`);
    // Staff phones got the transaction too.
    expect(fcm.some((m) => m.token === adminToken && m.data.event === 'transaction.debit')).toBe(true);
  });

  test('new sign-ups and suspicious activity reach admins', async () => {
    calls.length = 0;
    const s = await signUp({ country: 'SL' });
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await api().post('/api/auth/login').send({ identifier: s.email, password: 'WrongPass123' });
    }
    await settle();
    const events = calls.filter((c) => c.url.startsWith('https://hooks')).map((c) => JSON.parse(c.opts.body));
    expect(events.find((e) => e.event === 'alert.new_user').title).toMatch(/approve/);
    expect(events.find((e) => e.event === 'alert.suspicious')).toEqual(expect.objectContaining({ severity: 'critical', title: 'Many failed logins' }));
  });

  test('admin announcements are pushed to users', async () => {
    const u = await sl({ tier: 1 });
    const token = `fcm-news-${'n'.repeat(40)}`;
    await api().post('/api/me/devices').set(auth(u.token)).send({ token });
    calls.length = 0;
    const r = await api().post('/api/admin/broadcasts').set(auth(admin.token)).send({ title: 'New feature', message: 'Dollar cards are here', audience: 'selected', userIds: [u.user.id] });
    expect(r.status).toBe(201);
    await settle();
    const m = calls.filter((c) => c.url.includes('fcm')).map((c) => JSON.parse(c.opts.body).message).find((x) => x.token === token);
    expect(m.notification).toEqual({ title: 'New feature', body: 'Dollar cards are here' });
  });
});
