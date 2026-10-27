// Nigeria "Add money" by transfer to the company Kuda account, confirmed
// by an admin from the push buttons, the admin app or the webhook links.
const crypto = require('crypto');
const { api, auth, useDatabase, readyUser, balanceOf } = require('./helpers');
const { Transaction } = require('../src/models');
const env = require('../src/config/env');
const push = require('../src/services/push');

useDatabase('bankfunding');

const HOOK = 'https://hooks.example.com/bank';
const calls = [];
let admin;
let adminPhone;
const settle = () => new Promise((r) => setTimeout(r, 300));
const hooks = () => calls.filter((c) => c.url === HOOK).map((c) => JSON.parse(c.opts.body));
const pushes = () => calls.filter((c) => c.url.includes('fcm.googleapis.com')).map((c) => JSON.parse(c.opts.body).message);

beforeAll(async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  env.firebase.serviceAccount = { projectId: 'p', clientEmail: 'x@p.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  Object.assign(env.adminWebhook, { url: HOOK, secret: '' });
  push.setFetch(async (url, opts) => {
    calls.push({ url, opts });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url.includes('oauth2')) return json(200, { access_token: 't', expires_in: 3600 });
    return json(200, {});
  });
  admin = await readyUser({ role: 'super' });
  adminPhone = `fcm-admin-${'a'.repeat(40)}`;
  await api().post('/api/me/devices').set(auth(admin.token)).send({ token: adminPhone });
});
afterAll(() => {
  env.firebase.serviceAccount = null;
  Object.assign(env.adminWebhook, { url: '', secret: '' });
});
beforeEach(() => {
  calls.length = 0;
});

const start = (u, amount = 50000) => api().post('/api/wallet/fund/bank').set(auth(u.token)).send({ amount, pin: u.pin });

test('the company account is shown to Nigerian users', async () => {
  const u = await readyUser({});
  const w = (await api().get('/api/wallet').set(auth(u.token))).body.data;
  expect(w.manualBank).toEqual({ accountNumber: '3002991121', accountName: 'Dalabapay Digital Service', bankName: 'Kuda Bank' });
});

test('amount + PIN → account; "I have sent it" → admins get Confirm / Cancel; confirm credits ₦50,000 at once', async () => {
  const u = await readyUser({});
  expect((await start({ ...u, pin: '000000' })).status).not.toBe(201);
  const r = await start(u);
  expect(r.status).toBe(201);
  const t = r.body.data.topUp;
  expect(t).toEqual(expect.objectContaining({ amount: 50000, stage: 'awaiting', status: 'pending' }));
  expect(t.account.accountNumber).toBe('3002991121');
  expect((await api().get('/api/wallet/fund/bank/open').set(auth(u.token))).body.data.topUp.id).toBe(t.id);

  const sent = await api().post(`/api/wallet/fund/bank/${t.id}/sent`).set(auth(u.token));
  expect(sent.body.data.topUp.stage).toBe('sent');
  await settle();
  // Webhook: who sent what, with Confirm / Cancel links.
  const h = hooks().find((x) => x.data && x.data.event === 'funding.sent');
  expect(h.title).toMatch(/has sent ₦50,000\.00/);
  expect(h.actions.map((a) => a.label)).toEqual(['Confirm', 'Cancel']);
  expect(h.text).toContain('|Confirm>');
  // Admin phone: data-only message with buttons.
  const m = pushes().find((x) => x.token === adminPhone && x.data.event === 'funding.sent');
  expect(m.notification).toBeUndefined();
  expect(m.data).toEqual(expect.objectContaining({ actions: 'confirm,cancel', action: 'funding_confirm', transactionId: t.id }));
  expect(m.data.title).toMatch(/has sent/);
  // Tapping "I have sent it" twice doesn't notify twice.
  calls.length = 0;
  await api().post(`/api/wallet/fund/bank/${t.id}/sent`).set(auth(u.token));
  await settle();
  expect(hooks().some((x) => x.data && x.data.event === 'funding.sent')).toBe(false);

  const before = (await balanceOf(u.token)).balance;
  const list = (await api().get('/api/admin/funding/bank').set(auth(admin.token))).body.data.topUps;
  expect(list.find((x) => x.id === t.id).user.id).toBe(u.user.id);
  const c = await api().post(`/api/admin/funding/bank/${t.id}/confirm`).set(auth(admin.token)).send({});
  expect(c.body.data.result).toBe('confirmed');
  expect((await balanceOf(u.token)).balance).toBe(before + 50000);
  // A second confirm (another admin, double tap) credits nothing.
  const again = await api().post(`/api/admin/funding/bank/${t.id}/confirm`).set(auth(admin.token)).send({});
  expect(again.body.data.result).toBe('already');
  expect((await balanceOf(u.token)).balance).toBe(before + 50000);
  const mine = (await api().get(`/api/wallet/fund/bank/${t.id}`).set(auth(u.token))).body.data.topUp;
  expect(mine.stage).toBe('confirmed');
});

test('webhook links: the page asks first; the button confirms once', async () => {
  const u = await readyUser({});
  const t = (await start(u, 2000)).body.data.topUp;
  await api().post(`/api/wallet/fund/bank/${t.id}/sent`).set(auth(u.token));
  await settle();
  const h = hooks().find((x) => x.data && x.data.event === 'funding.sent');
  const confirmUrl = new URL(h.actions[0].url);
  const before = (await balanceOf(u.token)).balance;

  const view = await api().get(confirmUrl.pathname);
  expect(view.status).toBe(200);
  expect(view.text).toContain('Confirm and credit ₦2,000.00');
  expect((await balanceOf(u.token)).balance).toBe(before); // opening the link does nothing

  const done = await api().post(confirmUrl.pathname).type('form').send({});
  expect(done.text).toContain('Confirmed');
  expect((await balanceOf(u.token)).balance).toBe(before + 2000);
  const twice = await api().post(confirmUrl.pathname).type('form').send({});
  expect(twice.text).toContain('already confirmed');
  expect((await balanceOf(u.token)).balance).toBe(before + 2000);

  // The Cancel link no longer does anything; a forged link is refused.
  expect((await api().post(new URL(h.actions[1].url).pathname).type('form').send({})).text).toContain('already confirmed');
  expect((await api().get('/api/funding-actions/not-a-token')).status).toBe(400);
});

test('admin cancel tells the person; nothing is credited', async () => {
  const u = await readyUser({});
  const phone = `fcm-user-${'u'.repeat(40)}`;
  await api().post('/api/me/devices').set(auth(u.token)).send({ token: phone });
  const t = (await start(u, 1000)).body.data.topUp;
  await api().post(`/api/wallet/fund/bank/${t.id}/sent`).set(auth(u.token));
  const before = (await balanceOf(u.token)).balance;
  calls.length = 0;
  const r = await api().post(`/api/admin/funding/bank/${t.id}/cancel`).set(auth(admin.token)).send({ note: 'Money not received.' });
  expect(r.body.data.result).toBe('cancelled');
  await settle();
  expect((await balanceOf(u.token)).balance).toBe(before);
  const m = pushes().find((x) => x.token === phone);
  expect(m.notification.title).toBe('Top-up not confirmed');
  expect(m.notification.body).toContain('Money not received.');
  expect((await api().post(`/api/admin/funding/bank/${t.id}/confirm`).set(auth(admin.token)).send({})).body.data.result).toBe('already');
});

test('the person can cancel; admins are told if it was already "sent"', async () => {
  const u = await readyUser({});
  const t = (await start(u, 1000)).body.data.topUp;
  await api().post(`/api/wallet/fund/bank/${t.id}/sent`).set(auth(u.token));
  calls.length = 0;
  const r = await api().post(`/api/wallet/fund/bank/${t.id}/cancel`).set(auth(u.token));
  expect(r.body.data.topUp.stage).toBe('cancelled');
  await settle();
  expect(hooks().find((x) => x.title === 'Top-up cancelled by customer')).toBeTruthy();
  expect((await api().get('/api/wallet/fund/bank/open').set(auth(u.token))).body.data.topUp).toBeNull();
});

test('a new top-up replaces one never paid; others cannot touch it', async () => {
  const u = await readyUser({});
  const other = await readyUser({});
  const a = (await start(u, 1000)).body.data.topUp;
  const b = (await start(u, 3000)).body.data.topUp;
  expect((await Transaction.findById(a.id)).status).toBe('failed');
  expect((await api().get('/api/wallet/fund/bank/open').set(auth(u.token))).body.data.topUp.id).toBe(b.id);
  expect((await api().post(`/api/wallet/fund/bank/${b.id}/sent`).set(auth(other.token))).status).toBe(404);
  expect((await api().post(`/api/admin/funding/bank/${b.id}/confirm`).set(auth(u.token)).send({})).status).toBe(403);
});

test('Sierra Leone accounts and switched-off setting', async () => {
  const sl = await readyUser({ country: 'SL' });
  expect((await start(sl, 100)).body.code).toBe('WRONG_COUNTRY');
  await api().patch('/api/admin/settings').set(auth(admin.token)).send({ ngBankFunding: { enabled: false } });
  const u = await readyUser({});
  expect((await api().get('/api/wallet').set(auth(u.token))).body.data.manualBank).toBeNull();
  expect((await start(u, 1000)).body.code).toBe('BANK_FUNDING_OFF');
  await api().patch('/api/admin/settings').set(auth(admin.token)).send({ ngBankFunding: { enabled: true } });
});
