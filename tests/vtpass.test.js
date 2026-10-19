// VTpass TV integration, end to end through the API, against a fake VTpass
// that behaves like the documented sandbox:
//   1212121212    → success              201000000000 → pending (099)
//   300000000000  → timeout              anything else → failed (016)
const { api, auth, useDatabase, readyUser, balanceOf } = require('./helpers');
const { setBillProvider, createRouter } = require('../src/providers/bill');
const simulator = require('../src/providers/bill/simulator');
const { createVtpass, parseDueDate, validityFrom } = require('../src/providers/bill/vtpass');
const { sweepOnce } = require('../src/services/pendingSweeper');
const { Transaction, AdminAlert } = require('../src/models');

useDatabase('vtpass');

const VARIATIONS = {
  dstv: [
    { variation_code: 'dstv-padi', name: 'DStv Padi N1,850', variation_amount: '1850.00', fixedPrice: 'Yes' },
    { variation_code: 'dstv79', name: 'DStv  Compact N7900', variation_amount: '7900.00', fixedPrice: 'Yes' },
  ],
  gotv: [
    { variation_code: 'gotv-lite', name: 'GOtv Lite N410', variation_amount: '410.00', fixedPrice: 'Yes' },
    { variation_code: 'gotv-max', name: 'GOtv Max N3,600', variation_amount: '3600.00', fixedPrice: 'Yes' },
    { variation_code: 'gotv-lite-3months', name: 'GOtv Lite (3 Months) N1,080', variation_amount: '1080.00', fixedPrice: 'Yes' },
  ],
  startimes: [
    { variation_code: 'nova', name: 'Nova - 900 Naira - 1 Month', variation_amount: '900.00', fixedPrice: 'Yes' },
    { variation_code: 'nova-weekly', name: 'Nova - 300 Naira - 1 Week', variation_amount: '300.00', fixedPrice: 'Yes' },
    { variation_code: 'ewallet', name: 'ewallet Amount', variation_amount: '0.00', fixedPrice: 'Yes' },
  ],
};

function fakeVtpass() {
  const calls = [];
  const paid = new Map(); // request_id → status
  const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const tx = (status, amount, id) => ({
    code: '000',
    content: { transactions: { status, amount: String(amount), transactionId: `VT${id}`, commission: 1 } },
    response_description: status === 'delivered' ? 'TRANSACTION SUCCESSFUL' : 'TRANSACTION PROCESSING',
    amount,
  });
  async function fetchImpl(url, opts) {
    const path = url.replace(/^https:\/\/sandbox\.vtpass\.com\/api\//, '');
    const body = opts.body ? JSON.parse(opts.body) : {};
    calls.push({ path, method: opts.method, headers: opts.headers, body });
    if (opts.headers['api-key'] !== 'AK') return json(401, { code: '087', response_description: 'INVALID CREDENTIALS' });
    if (opts.method === 'GET' && !opts.headers['public-key']) throw new Error('GET needs public-key');
    if (opts.method === 'POST' && !opts.headers['secret-key']) throw new Error('POST needs secret-key');

    if (path.startsWith('service-variations')) {
      const id = new URL(`http://x/${path}`).searchParams.get('serviceID');
      return json(200, { response_description: '000', content: { serviceID: id, variations: VARIATIONS[id] || [] } });
    }
    if (path === 'balance') return json(200, { code: 1, contents: { balance: 186450.75 } });
    if (path === 'merchant-verify') {
      if (body.billersCode !== '1212121212') {
        return json(200, { code: '000', content: { error: 'This Smartcard number is invalid' } });
      }
      if (body.serviceID === 'startimes') {
        return json(200, { code: '000', content: { Customer_Name: 'TestMan Decoder', Balance: 54.82, Smartcard_Number: '1212121212', WrongBillersCode: false } });
      }
      return json(200, {
        code: '000',
        content: {
          Customer_Name: 'TEST METER',
          Status: 'ACTIVE',
          Due_Date: body.serviceID === 'gotv' ? '02-FEB-25' : '2025-02-06T00:00:00',
          Current_Bouquet: body.serviceID === 'gotv' ? 'GOtv Max' : 'DStv Compact',
          Renewal_Amount: body.serviceID === 'gotv' ? 3600 : 7900,
        },
      });
    }
    if (path === 'pay') {
      expect(body.request_id).toMatch(/^\d{12}[A-Z0-9]+$/);
      const price = body.amount ?? (VARIATIONS[body.serviceID].find((v) => v.variation_code === body.variation_code) || {}).variation_amount;
      const total = Number(price) * (body.quantity || 1);
      switch (body.billersCode) {
        case '1212121212':
          paid.set(body.request_id, 'delivered');
          return json(200, tx('delivered', total, body.request_id));
        case '201000000000':
          paid.set(body.request_id, 'pending');
          return json(200, { code: '099', response_description: 'TRANSACTION IS PROCESSING', content: {} });
        case '300000000000': {
          paid.set(body.request_id, 'pending');
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        default:
          return json(200, { code: '016', response_description: 'TRANSACTION FAILED', content: { transactions: { status: 'failed' } } });
      }
    }
    if (path === 'requery') {
      const st = paid.get(body.request_id);
      if (!st) return json(200, { code: '015', response_description: 'INVALID REQUEST ID' });
      return json(200, tx(st, 1000, body.request_id));
    }
    return json(404, { code: '012' });
  }
  return { fetchImpl, calls, paid };
}

let fake;

beforeEach(() => {
  fake = fakeVtpass();
  const vt = createVtpass({
    apiKey: 'AK',
    publicKey: 'PK_x',
    secretKey: 'SK_x',
    environment: 'sandbox',
    timeoutMs: 2000,
    fetchImpl: fake.fetchImpl,
  });
  setBillProvider(createRouter({ base: simulator, routes: { cable: vt } }));
});

afterAll(() => setBillProvider(null));

const tv = (u) => auth(u.token);

describe('helpers', () => {
  test('due dates and validity', () => {
    expect(parseDueDate('2025-02-06T00:00:00')).toBe('2025-02-06');
    expect(parseDueDate('02-FEB-25')).toBe('2025-02-02');
    expect(parseDueDate('nonsense')).toBeNull();
    expect(validityFrom('Nova - 300 Naira - 1 Week')).toBe('1 week');
    expect(validityFrom('GOtv Lite (3 Months) N1,080')).toBe('3 months');
    expect(validityFrom('DStv Padi N1,850')).toBe('1 month');
  });
});

describe('routing', () => {
  test('TV goes to VTpass, other services stay on the simulator', async () => {
    const u = await readyUser();
    const providers = (await api().get('/api/services/cable/providers').set(tv(u))).body.data;
    expect(providers.map((p) => p.id)).toEqual(['dstv', 'gotv', 'startimes']);
    expect((await api().get('/api/services/networks').set(tv(u))).body.data).toHaveLength(4);
    const admin = await readyUser({ role: 'super' });
    const prov = (await api().get('/api/admin/provider').set(auth(admin.token))).body.data;
    expect(prov.bill.services.cable.provider).toBe('vtpass');
    expect(prov.bill.services.airtime.provider).toBe('simulator');
    expect(prov.balance).toBe(186450.75);
    const h = (await api().post('/api/admin/provider/health').set(auth(admin.token))).body.data;
    expect(h.ok).toBe(true);
    // GET used public-key, never the secret key
    const get = fake.calls.find((c) => c.method === 'GET');
    expect(get.headers['public-key']).toBe('PK_x');
    expect(get.headers['secret-key']).toBeUndefined();
  });

  test('missing keys: TV says "not connected" instead of falling back', async () => {
    setBillProvider(createRouter({ base: simulator, routes: { cable: createVtpass({}) } }));
    const u = await readyUser({ fund: 5000 });
    const r = await api().get('/api/services/cable/plans?provider=dstv').set(tv(u));
    expect(r.status).toBe(503);
    const buy = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'dstv', smartcardNumber: '1212121212', action: 'change', planCode: 'dstv-padi', months: 1, phone: '08031234567', pin: u.pin,
    });
    expect(buy.status).toBe(503);
    expect(buy.body.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect((await balanceOf(u.token)).balance).toBe(4925);
  });
});

describe('plans and smartcard check', () => {
  test('plans come from VTpass; zero-price ewallet is hidden', async () => {
    const u = await readyUser();
    const s = (await api().get('/api/services/cable/plans?provider=startimes').set(tv(u))).body.data;
    expect(s.map((p) => p.code)).toEqual(['nova', 'nova-weekly']);
    expect(s[1]).toEqual({ code: 'nova-weekly', name: 'Nova - 300 Naira - 1 Week', amount: 300, validity: '1 week' });
  });

  test('DStv verify returns renewal details; bad card is not found', async () => {
    const u = await readyUser();
    const v = (await api().post('/api/services/cable/verify').set(tv(u)).send({ provider: 'dstv', smartcardNumber: '1212121212' })).body.data;
    expect(v).toEqual(expect.objectContaining({
      customerName: 'TEST METER', currentPlan: 'DStv Compact', currentPlanCode: 'dstv79',
      renewalAmount: 7900, dueDate: '2025-02-06', canRenew: true, maxMonths: 12,
    }));
    const bad = await api().post('/api/services/cable/verify').set(tv(u)).send({ provider: 'dstv', smartcardNumber: '1234567890' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/invalid/i);
  });

  test('StarTimes can\'t renew and is one period at a time', async () => {
    const u = await readyUser();
    const v = (await api().post('/api/services/cable/verify').set(tv(u)).send({ provider: 'startimes', smartcardNumber: '1212121212' })).body.data;
    expect(v.canRenew).toBe(false);
    expect(v.maxMonths).toBe(1);
    expect(v.balance).toBe(54.82);
  });
});

describe('payments', () => {
  test('DStv renew sends subscription_type renew with the renewal amount', async () => {
    const u = await readyUser({ fund: 20000 });
    const r = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'dstv', smartcardNumber: '1212121212', action: 'renew', months: 1, phone: '08031234567', pin: u.pin,
    });
    expect(r.status).toBe(201);
    const t = r.body.data.transaction;
    expect(t.status).toBe('success');
    expect(t.amount).toBe(7900);
    expect(t.providerReference).toBe(`VT${t.reference}`);
    expect(t.metadata.providerRaw).toBeUndefined(); // internal, not shown to users
    const pay = fake.calls.find((c) => c.path === 'pay');
    expect(pay.body).toEqual(expect.objectContaining({
      request_id: t.reference, serviceID: 'dstv', billersCode: '1212121212', subscription_type: 'renew', amount: 7900, phone: '08031234567',
    }));
    expect(t.reference).toMatch(/^\d{12}DP/);
    const db = await Transaction.findById(t.id);
    expect(db.provider).toBe('vtpass');
    expect(db.metadata.providerRaw.code).toBe('000');
  });

  test('GOtv change sends variation_code and months as quantity', async () => {
    const u = await readyUser({ fund: 20000 });
    const r = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'gotv', smartcardNumber: '1212121212', action: 'change', planCode: 'gotv-max', months: 2, phone: '08031234567', pin: u.pin,
    });
    expect(r.body.data.transaction.status).toBe('success');
    expect(r.body.data.transaction.amount).toBe(7200);
    const pay = fake.calls.find((c) => c.path === 'pay');
    expect(pay.body).toEqual(expect.objectContaining({ serviceID: 'gotv', subscription_type: 'change', variation_code: 'gotv-max', quantity: 2 }));
    expect(pay.body.amount).toBeUndefined();
  });

  test('StarTimes recharge sends only the variation code; renew and 2 months are refused', async () => {
    const u = await readyUser({ fund: 20000 });
    const ok = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'startimes', smartcardNumber: '1212121212', action: 'change', planCode: 'nova', months: 1, phone: '08031234567', pin: u.pin,
    });
    expect(ok.body.data.transaction.status).toBe('success');
    const pay = fake.calls.find((c) => c.path === 'pay');
    expect(pay.body.subscription_type).toBeUndefined();
    expect(pay.body.variation_code).toBe('nova');
    const renew = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'startimes', smartcardNumber: '1212121212', action: 'renew', months: 1, phone: '08031234567', pin: u.pin,
    });
    expect(renew.body.code).toBe('RENEW_NOT_AVAILABLE');
    const two = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'startimes', smartcardNumber: '1212121212', action: 'change', planCode: 'nova-weekly', months: 2, phone: '08031234567', pin: u.pin,
    });
    expect(two.body.code).toBe('TOO_MANY_MONTHS');
  });

});

// Verification only passes for 1212121212, so these use the purchase flow
// (executePurchase) directly with the documented sandbox card numbers.
const { executePurchase } = require('../src/services/purchase');
const { User } = require('../src/models');

async function buy(u, card) {
    const user = await User.findById(u.user.id);
    return executePurchase({
      user,
      service: 'cable',
      pin: u.pin,
      amount: 41000,
      recipient: card,
      description: 'GOtv Lite',
      providerParams: { provider: 'gotv', action: 'change', planCode: 'gotv-lite', months: 1, phone: '08031234567' },
    });
}

describe('declines', () => {
  test('declined payment (016) refunds the wallet straight away', async () => {
    const u = await readyUser({ fund: 10000 });
    const t = await buy(u, '5555555555');
    expect(t.status).toBe('failed');
    expect(t.refunded).toBe(true);
    expect(t.metadata.failureReason).toBe('TRANSACTION FAILED');
    expect((await balanceOf(u.token)).balance).toBe(9850);
  });
});

describe('pending and timeouts', () => {
  test('099 stays pending; the sweeper settles it when VTpass delivers', async () => {
    const u = await readyUser({ fund: 10000 });
    const t = await buy(u, '201000000000');
    expect(t.status).toBe('pending');
    expect((await balanceOf(u.token)).balance).toBe(9850 - 410);
    fake.paid.set(t.reference, 'delivered');
    const results = await sweepOnce({ now: Date.now() + 5 * 60 * 1000 });
    expect(results).toContain('success');
    const fresh = await Transaction.findById(t._id);
    expect(fresh.status).toBe('success');
    expect(fresh.commission).toBeGreaterThan(0);
  });

  test('timeout stays pending (no blind refund); requery failure refunds once', async () => {
    const u = await readyUser({ fund: 10000 });
    const t = await buy(u, '300000000000');
    expect(t.status).toBe('pending');
    expect(await AdminAlert.exists({ title: 'Provider did not respond' })).toBeTruthy();
    fake.paid.set(t.reference, 'failed');
    const admin = await readyUser({ role: 'super' });
    const r = await api().post(`/api/admin/transactions/${t._id}/requery`).set(auth(admin.token));
    expect(r.body.data.result).toBe('failed');
    expect(r.body.data.transaction.refunded).toBe(true);
    expect((await balanceOf(u.token)).balance).toBe(9850);
    // Running the sweeper afterwards doesn't refund again
    await sweepOnce({ now: Date.now() + 5 * 60 * 1000 });
    expect((await balanceOf(u.token)).balance).toBe(9850);
  });

  test('payment VTpass never received (015 on requery) is refunded', async () => {
    const u = await readyUser({ fund: 10000 });
    const t = await buy(u, '300000000000');
    fake.paid.delete(t.reference);
    await sweepOnce({ now: Date.now() + 5 * 60 * 1000 });
    const fresh = await Transaction.findById(t._id);
    expect(fresh.status).toBe('failed');
    expect((await balanceOf(u.token)).balance).toBe(9850);
  });
});
