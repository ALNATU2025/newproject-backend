// Sierra Leone airtime and data through Reloadly (SL_PROVIDER=reloadly).
// Reloadly's API is faked here.
const { api, auth, useDatabase, readyUser, balanceOf } = require('./helpers');
const { User, Transaction } = require('../src/models');
const env = require('../src/config/env');
const reloadly = require('../src/providers/bill/reloadly');
const { setBillProvider, createRouter, billProvider } = require('../src/providers/bill');

useDatabase('reloadly');

const calls = [];
let topupMode = 'ok';
const OPERATORS = [
  { operatorId: 701, name: 'Africell Sierra Leone', bundle: false, data: false, supportsLocalAmounts: true, denominationType: 'RANGE', fx: { rate: 22.5, currencyCode: 'SLE' }, status: 'ACTIVE' },
  { operatorId: 702, name: 'Orange Sierra Leone', bundle: false, data: false, supportsLocalAmounts: false, denominationType: 'RANGE', fx: { rate: 22.5, currencyCode: 'SLE' }, status: 'ACTIVE' },
  {
    operatorId: 703, name: 'Orange Sierra Leone Data Bundles', bundle: true, data: true, denominationType: 'FIXED', fx: { rate: 22.5, currencyCode: 'SLE' }, status: 'ACTIVE',
    fixedAmounts: [2, 5], localFixedAmounts: [45, 112.5],
    fixedAmountsDescriptions: { '2.00': '1.5GB · 7 days', '5.00': '5GB · 30 days' },
  },
];
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
async function fake(url, opts) {
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url, method: opts.method, body, headers: opts.headers });
  if (url === 'https://auth.reloadly.com/oauth/token') return reply(200, { access_token: 'tok', expires_in: 3600 });
  const u = new URL(url);
  if (u.pathname === '/operators/countries/SL') return reply(200, OPERATORS);
  if (u.pathname === '/topups' && opts.method === 'POST') {
    if (topupMode === 'decline') return reply(400, { errorCode: 'INVALID_RECIPIENT', message: 'Invalid phone number for operator' });
    if (topupMode === 'timeout') throw new Error('socket hang up');
    return reply(200, { transactionId: 9001, status: 'SUCCESSFUL', customIdentifier: body.customIdentifier, deliveredAmount: body.useLocalAmount ? body.amount : body.amount * 22.5, deliveredAmountCurrencyCode: 'SLE', requestedAmount: 2.22, requestedAmountCurrencyCode: 'USD' });
  }
  if (u.pathname === '/topups/reports/transactions') return reply(200, { content: [{ transactionId: 9002, status: 'SUCCESSFUL' }] });
  if (u.pathname === '/accounts/balance') return reply(200, { balance: 125.5, currencyCode: 'USD' });
  return reply(404, { message: 'unknown' });
}

let original;
beforeAll(() => {
  Object.assign(env.reloadly, { clientId: 'cid', clientSecret: 'secret', env: 'sandbox' });
  reloadly.setFetch(fake);
  reloadly._reset();
  original = billProvider();
  // eslint-disable-next-line global-require
  const sim = require('../src/providers/bill/simulator');
  setBillProvider(createRouter({ base: sim, routes: { sl_airtime: reloadly, sl_data: reloadly, sl_electricity: reloadly, sl_cable: reloadly } }));
});
afterAll(() => {
  setBillProvider(original);
  reloadly.setFetch(null);
  Object.assign(env.reloadly, { clientId: '', clientSecret: '' });
});
beforeEach(() => {
  calls.length = 0;
  topupMode = 'ok';
});

const slUser = async (le = 500) => {
  const u = await readyUser({ country: 'SL' });
  await User.updateOne({ _id: u.user.id }, { $set: { balance: le * 100 } });
  return u;
};

test('networks and data bundles in Leones', async () => {
  const u = await slUser();
  const nets = (await api().get('/api/sl/networks').set(auth(u.token))).body.data;
  expect(nets).toEqual([{ id: 'africell', name: 'Africell' }, { id: 'orange', name: 'Orange' }]);
  const plans = (await api().get('/api/sl/data/plans?network=orange').set(auth(u.token))).body.data;
  expect(plans).toEqual([
    expect.objectContaining({ code: '703:2.00', name: '1.5GB · 7 days', amount: 45 }),
    expect.objectContaining({ code: '703:5.00', name: '5GB · 30 days', amount: 112.5 }),
  ]);
  expect(calls.find((c) => c.url.includes('oauth')).body).toEqual(expect.objectContaining({ audience: 'https://topups-sandbox.reloadly.com', grant_type: 'client_credentials' }));
  expect(calls.find((c) => c.url.includes('/operators/')).headers.Accept).toBe('application/com.reloadly.topups-v1+json');
});

test('airtime: Leones sent as local amount, or converted to USD when the operator needs it', async () => {
  const u = await slUser();
  const r = await api().post('/api/sl/airtime').set(auth(u.token)).send({ network: 'africell', phone: '077123456', amount: 50, pin: u.pin });
  expect(r.status).toBe(201);
  expect(r.body.data.transaction.status).toBe('success');
  const sent = calls.find((c) => c.url.endsWith('/topups'));
  expect(sent.body).toEqual(expect.objectContaining({ operatorId: 701, amount: 50, useLocalAmount: true, recipientPhone: { countryCode: 'SL', number: '077123456' } }));
  expect(sent.body.customIdentifier).toBeTruthy();
  expect((await balanceOf(u.token)).balance).toBeCloseTo(450, 2);

  calls.length = 0;
  await api().post('/api/sl/airtime').set(auth(u.token)).send({ network: 'orange', phone: '076123456', amount: 45, pin: u.pin });
  expect(calls.find((c) => c.url.endsWith('/topups')).body).toEqual(expect.objectContaining({ operatorId: 702, amount: 2, useLocalAmount: false }));
});

test('data bundle; declined → refunded with the reason; no answer → pending', async () => {
  const u = await slUser();
  const d = await api().post('/api/sl/data').set(auth(u.token)).send({ network: 'orange', phone: '076123456', planCode: '703:2.00', pin: u.pin });
  expect(d.status).toBe(201);
  expect(calls.find((c) => c.url.endsWith('/topups')).body).toEqual(expect.objectContaining({ operatorId: 703, amount: 2, useLocalAmount: false }));
  expect((await balanceOf(u.token)).balance).toBeCloseTo(455, 2);

  topupMode = 'decline';
  const bad = await api().post('/api/sl/airtime').set(auth(u.token)).send({ network: 'africell', phone: '077000999', amount: 20, pin: u.pin });
  const t = await Transaction.findOne({ user: u.user.id, recipient: '077000999' });
  expect(t.status).toBe('failed');
  expect(t.metadata.failureReason).toMatch(/Invalid phone number/);
  expect((await balanceOf(u.token)).balance).toBeCloseTo(455, 2);
  expect(bad.status === 201 || bad.status >= 400).toBe(true);

  topupMode = 'timeout';
  const slow = await api().post('/api/sl/airtime').set(auth(u.token)).send({ network: 'africell', phone: '077000888', amount: 10, pin: u.pin });
  const p = await Transaction.findOne({ user: u.user.id, recipient: '077000888' });
  expect(p.status).toBe('pending');
  expect(slow.status).toBeLessThan(500);
  const rq = await reloadly.requery(p.reference);
  expect(rq.status).toBe('success');
});

test('EDSA and TV are not on Reloadly: clear message', async () => {
  const u = await slUser();
  const r = await api().post('/api/sl/electricity/verify').set(auth(u.token)).send({ meterNumber: '04123456789' });
  expect(r.status).toBe(503);
  expect(r.body.code).toBe('PROVIDER_NOT_CONFIGURED');
  expect(await reloadly.balance()).toBe(12550);
});
