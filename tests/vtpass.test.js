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
    { variation_code: 'dstv-xv', name: 'DStv Compact + Extra View N11,900', variation_amount: '11900.00', fixedPrice: 'Yes' },
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

    if (path.startsWith('service-variations') && !path.includes('foreign-airtime')) {
      const id = new URL(`http://x/${path}`).searchParams.get('serviceID');
      return json(200, { response_description: '000', content: { serviceID: id, variations: VARIATIONS[id] || [] } });
    }
    if (path === 'balance') return json(200, { code: 1, contents: { balance: 186450.75 } });
    if (path === 'get-international-airtime-countries') {
      return json(200, {
        response_description: '000',
        content: {
          countries: [
            { code: 'GH', flag: 'https://sandbox.vtpass.com/resources/images/flags/GH.png', name: 'Ghana', currency: 'GHS', prefix: '233' },
            { code: 'CM', flag: 'https://sandbox.vtpass.com/resources/images/flags/CM.png', name: 'Cameroon', currency: 'XAF', prefix: '237' },
          ],
        },
      });
    }
    if (path.startsWith('get-international-airtime-product-types')) {
      return json(200, { response_description: '000', content: [{ product_type_id: 4, name: 'Mobile Data' }, { product_type_id: 1, name: 'Mobile Top Up' }] });
    }
    if (path.startsWith('get-international-airtime-operators')) {
      return json(200, { response_description: '000', content: [{ operator_id: '5', name: 'Ghana MTN', operator_image: 'https://x/80.png' }] });
    }
    if (path.startsWith('service-variations') && path.includes('foreign-airtime')) {
      return json(200, {
        response_description: '000',
        content: {
          serviceID: 'foreign-airtime',
          variations: [
            { variation_code: '2470', name: '15EUR Top Up', variation_amount: '15.00', fixedPrice: 'Yes', charged_amount: '27000' },
            { variation_code: '4987', name: '5 -500 GHS Top Up', variation_amount: '0.00', fixedPrice: 'No', variation_rate: '105' },
            { variation_code: '13056', name: 'Gaga Time - 5GB Mobile Data', variation_amount: '0.00', fixedPrice: 'Yes' },
            // Marked fixed but really a range: needs an amount at pay time.
            { variation_code: '4988', name: '160 -2000 GMD Top Up', variation_amount: '0.00', fixedPrice: 'Yes', variation_rate: '30' },
          ],
        },
      });
    }
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
    if (path === 'pay' && body.serviceID === 'foreign-airtime') {
      expect(body.request_id).toMatch(/^\d{12}[A-Z0-9]+$/);
      const missing = !body.email || !body.phone || !body.operator_id || !body.country_code || !body.product_type_id
        || (['4987', '4988'].includes(body.variation_code) && !body.amount);
      if (missing) return json(200, { code: '011', response_description: 'INVALID ARGUMENTS', content: { errors: ['missing field'] } });
      const ok = body.billersCode === '08011111111' || body.billersCode === '233241234567';
      if (!ok) return json(200, { code: '016', response_description: 'TRANSACTION FAILED', content: { transactions: { status: 'failed' } } });
      paid.set(body.request_id, 'delivered');
      const naira = body.variation_code === '2470' ? 27000
        : Number(body.amount) * (body.variation_code === '4988' ? 30 : 105);
      return json(200, {
        ...tx('delivered', naira, body.request_id),
        purchased_code: body.product_type_id === '3' ? 'PIN 1234-5678' : '',
        cards: body.product_type_id === '3' ? [{ pin: '1234-5678', serial: 'SN01' }] : null,
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
let vt;

beforeEach(() => {
  fake = fakeVtpass();
  vt = createVtpass({
    apiKey: 'AK',
    publicKey: 'PK_x',
    secretKey: 'SK_x',
    environment: 'sandbox',
    timeoutMs: 2000,
    fetchImpl: fake.fetchImpl,
  });
  setBillProvider(createRouter({ base: simulator, routes: { cable: vt, international: vt } }));
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

  test('DStv ExtraView: VTpass\'s hidden, ours paid as a renewal of the exact amount', async () => {
    const u = await readyUser({ fund: 30000 });
    const plans = (await api().get('/api/services/cable/plans?provider=dstv').set(tv(u))).body.data;
    expect(plans.map((p) => p.code)).toEqual(['dstv-padi', 'dstv79', 'xv-dstv-padi', 'xv-dstv79']);
    const xv = plans.find((p) => p.code === 'xv-dstv79');
    expect(xv).toEqual(expect.objectContaining({ name: 'DStv Compact + ExtraView', amount: 7900 + 6000 }));

    const r = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'dstv', smartcardNumber: '1212121212', action: 'change', planCode: 'xv-dstv79', months: 1, phone: '08031234567', pin: u.pin,
    });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction).toEqual(expect.objectContaining({ status: 'success', amount: 13900, description: 'DStv Compact + ExtraView' }));
    const pay = fake.calls.filter((c) => c.path === 'pay').pop();
    expect(pay.body).toEqual(expect.objectContaining({ serviceID: 'dstv', subscription_type: 'renew', amount: 13900 }));
    expect(pay.body.variation_code).toBeUndefined();

    // VTpass's own ExtraView code is refused.
    const old = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'dstv', smartcardNumber: '1212121212', action: 'change', planCode: 'dstv-xv', months: 1, phone: '08031234567', pin: u.pin,
    });
    expect(old.body.code).toBe('PLAN_NOT_FOUND');
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
  test('DStv renew with a typed amount works without a renewal price', async () => {
    const { billProvider } = require('../src/providers/bill');
    const bp = billProvider();
    const real = bp.verifySmartcard;
    bp.verifySmartcard = async (...a) => ({ ...(await real(...a)), renewalAmount: null, canRenew: false, currentPlanCode: null });
    try {
      const u = await readyUser({ fund: 20000 });
      const r = await api().post('/api/services/cable').set(tv(u)).send({
        provider: 'dstv', smartcardNumber: '1212121212', action: 'renew', amount: 4000, phone: '08031234567', pin: u.pin,
      });
      expect(r.status).toBe(201);
      expect(r.body.data.transaction.amount).toBe(4000);
      const noAmount = await api().post('/api/services/cable').set(tv(u)).send({
        provider: 'dstv', smartcardNumber: '1212121212', action: 'renew', phone: '08031234567', pin: u.pin,
      });
      expect(noAmount.body.code).toBe('RENEW_NOT_AVAILABLE');
    } finally {
      bp.verifySmartcard = real;
    }
  });

  test('DStv renew with an edited amount', async () => {
    const u = await readyUser({ fund: 20000 });
    const r = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'dstv', smartcardNumber: '1212121212', action: 'renew', amount: 6000, months: 1, phone: '08031234567', pin: u.pin,
    });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction).toEqual(expect.objectContaining({ status: 'success', amount: 6000 }));
    const pay = fake.calls.filter((c) => c.path === 'pay').pop();
    expect(pay.body).toEqual(expect.objectContaining({ serviceID: 'dstv', subscription_type: 'renew', amount: 6000 }));
    const low = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'dstv', smartcardNumber: '1212121212', action: 'renew', amount: 200, phone: '08031234567', pin: u.pin,
    });
    expect(low.body.code).toBe('AMOUNT_TOO_LOW');
  });

  test('DStv any amount: sent as a renewal with the amount the customer typed', async () => {
    const u = await readyUser({ fund: 20000 });
    const r = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'dstv', smartcardNumber: '1212121212', action: 'custom', amount: 5000, phone: '08031234567', pin: u.pin,
    });
    expect(r.status).toBe(201);
    const t = r.body.data.transaction;
    expect(t).toEqual(expect.objectContaining({ status: 'success', amount: 5000, description: 'DStv payment' }));
    expect(t.metadata.customAmount).toBe(true);
    const pay = fake.calls.filter((c) => c.path === 'pay').pop();
    expect(pay.body).toEqual(expect.objectContaining({ serviceID: 'dstv', subscription_type: 'renew', amount: 5000 }));

    const low = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'dstv', smartcardNumber: '1212121212', action: 'custom', amount: 100, phone: '08031234567', pin: u.pin,
    });
    expect(low.body.code).toBe('AMOUNT_TOO_LOW');
    const gotv = await api().post('/api/services/cable').set(tv(u)).send({
      provider: 'gotv', smartcardNumber: '1212121212', action: 'custom', amount: 5000, phone: '08031234567', pin: u.pin,
    });
    expect(gotv.body.code).toBe('CUSTOM_NOT_SUPPORTED');
  });

  test('admin sees the VTpass balance even when Sierra Leone services are routed first', async () => {
    setBillProvider(createRouter({ base: simulator, routes: { sl_airtime: simulator, sl_data: simulator, cable: vt, international: vt } }));
    const admin = await readyUser({ role: 'super' });
    const prov = (await api().get('/api/admin/provider').set(auth(admin.token))).body.data;
    expect(prov.balance).toBe(186450.75);
  });

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

describe('international airtime / data / PINs', () => {
  test('countries, product types and operators come from VTpass', async () => {
    const u = await readyUser();
    const countries = (await api().get('/api/services/international/countries').set(tv(u))).body.data;
    expect(countries[0]).toEqual(expect.objectContaining({ code: 'GH', name: 'Ghana', flag: '🇬🇭', dialCode: '+233', currency: 'GHS' }));
    const types = (await api().get('/api/services/international/product-types?country=GH').set(tv(u))).body.data;
    expect(types).toEqual([{ id: '4', name: 'Mobile Data' }, { id: '1', name: 'Mobile Top Up' }]);
    const ops = (await api().get('/api/services/international/operators?country=GH&productType=1').set(tv(u))).body.data;
    expect(ops[0]).toEqual(expect.objectContaining({ id: '5', name: 'Ghana MTN' }));
  });

  test('plans: fixed price in naira, flexible with rate and range, unpriced left out', async () => {
    const u = await readyUser();
    const r = (await api().get('/api/services/international/variations?country=GH&operator=5&productType=1').set(tv(u))).body.data;
    expect(r.currency).toBe('GHS');
    expect(r.variations.map((v) => v.code)).toEqual(['2470', '4987', '4988']);
    // "Fixed" in VTpass but really a range → treated as any-amount.
    expect(r.variations[2]).toEqual(expect.objectContaining({ fixed: false, rate: 30, min: 160, max: 2000 }));
    expect(r.variations[0]).toEqual(expect.objectContaining({ fixed: true, nairaAmount: 27000 }));
    expect(r.variations[1]).toEqual(expect.objectContaining({ fixed: false, rate: 105, min: 5, max: 500 }));
    expect(await AdminAlert.exists({ title: 'International prices missing' })).toBeNull();
  });

  test('fixed plan: charged VTpass\'s naira price; payload matches the docs', async () => {
    const u = await readyUser({ fund: 30000 });
    const r = await api().post('/api/services/international').set(tv(u)).send({
      country: 'GH', productType: '1', operator: '5', variationCode: '2470', phone: '0241234567', pin: u.pin,
    });
    expect(r.status).toBe(201);
    const t = r.body.data.transaction;
    expect(t.status).toBe('success');
    expect(t.amount).toBe(27000);
    expect(t.recipient).toBe('+233241234567');
    const pay = fake.calls.find((c) => c.path === 'pay');
    expect(pay.body).toEqual(expect.objectContaining({
      serviceID: 'foreign-airtime', billersCode: '233241234567', variation_code: '2470',
      operator_id: '5', country_code: 'GH', product_type_id: '1', email: u.email,
    }));
    expect(pay.body.amount).toBe(15);
  });

  test('Sierra Leone: same VTpass plans, priced and paid in Leones', async () => {
    const { User } = require('../src/models');
    const { updateSettings } = require('../src/services/settings');
    await updateSettings({ slInternational: { rateLePerNaira: 0.015, marginPercent: 0 } });
    try {
      const u = await readyUser({ country: 'SL' });
      await User.updateOne({ _id: u.user.id }, { $set: { balance: 1000 * 100 } });
      const r = (await api().get('/api/services/sl/international/variations?country=GH&operator=5&productType=1').set(tv(u))).body.data;
      expect(r.variations[0]).toEqual(expect.objectContaining({ fixed: true, nairaAmount: 405 })); // ₦27,000 × 0.015
      expect(r.variations[2].rate).toBeCloseTo(0.45, 5); // ₦30 per unit × 0.015

      const buy = await api().post('/api/services/sl/international').set(tv(u)).send({
        country: 'GH', productType: '1', operator: '5', variationCode: '2470', phone: '0241234567', pin: u.pin,
      });
      expect(buy.status).toBe(201);
      const t = buy.body.data.transaction;
      expect(t).toEqual(expect.objectContaining({ status: 'success', amount: 405, currency: 'SLE', service: 'sl_international', recipient: '+233241234567' }));
      expect(t.metadata.nairaCost).toBe(27000);
      const pay = fake.calls.filter((c) => c.path === 'pay').pop();
      expect(pay.body).toEqual(expect.objectContaining({ serviceID: 'foreign-airtime', variation_code: '2470', amount: 15 }));
      expect((await balanceOf(u.token)).balance).toBeCloseTo(595, 2);

      // Nigerian accounts use their own screen.
      const ng = await readyUser({ fund: 1000 });
      const blocked = await api().get('/api/services/sl/international/countries').set(tv(ng));
      expect(blocked.body.code).toBe('WRONG_COUNTRY');
    } finally {
      await updateSettings({ slInternational: { rateLePerNaira: null, marginPercent: 3 } });
    }
  });

  test('range plan marked fixed by VTpass: amount is asked for and sent', async () => {
    const u = await readyUser({ fund: 30000 });
    const r = await api().post('/api/services/international').set(tv(u)).send({
      country: 'GH', productType: '1', operator: '5', variationCode: '4988', phone: '241234567', amount: 200, pin: u.pin,
    });
    expect(r.body.data.transaction.status).toBe('success');
    expect(r.body.data.transaction.amount).toBe(6000);
    const pay = fake.calls.find((c) => c.path === 'pay');
    expect(pay.body.amount).toBe(200);
  });

  test('INVALID ARGUMENTS (011) fails with a clear message', async () => {
    const bp = require('../src/providers/bill').billProvider();
    const r = await bp.purchase({
      service: 'international', requestId: '202610191400DPBAD00001', recipient: '+233241234567', amount: 600000,
      country: 'GH', productType: '1', operator: '5', variationCode: '4988', fixed: false, email: 'a@b.co', phone: '241234567',
    });
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/code 011/);
  });

  test('flexible top-up: local amount × rate; amount sent to VTpass', async () => {
    const u = await readyUser({ fund: 30000 });
    const r = await api().post('/api/services/international').set(tv(u)).send({
      country: 'GH', productType: '1', operator: '5', variationCode: '4987', phone: '241234567', amount: 20, pin: u.pin, email: 'friend@example.com',
    });
    expect(r.body.data.transaction.amount).toBe(2100);
    const pay = fake.calls.find((c) => c.path === 'pay');
    expect(pay.body.amount).toBe(20);
    expect(pay.body.email).toBe('friend@example.com');
    const out = await api().post('/api/services/international').set(tv(u)).send({
      country: 'GH', productType: '1', operator: '5', variationCode: '4987', phone: '241234567', amount: 600, pin: u.pin,
    });
    expect(out.body.code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  test('sandbox test number goes through unchanged; failures refund', async () => {
    const u = await readyUser({ fund: 60000 });
    const ok = await api().post('/api/services/international').set(tv(u)).send({
      country: 'GH', productType: '1', operator: '5', variationCode: '2470', phone: '08011111111', pin: u.pin,
    });
    expect(ok.body.data.transaction.status).toBe('success');
    const bad = await api().post('/api/services/international').set(tv(u)).send({
      country: 'GH', productType: '1', operator: '5', variationCode: '2470', phone: '244444444', pin: u.pin,
    });
    expect(bad.body.data.transaction.status).toBe('failed');
    expect(bad.body.data.transaction.refunded).toBe(true);
    expect((await balanceOf(u.token)).balance).toBe(59100 - 27000);
  });

  test('PIN products: codes from VTpass appear on the receipt', async () => {
    const bp = require('../src/providers/bill').billProvider();
    const r = await bp.purchase({
      service: 'international', requestId: '202610191400DPPIN0001', recipient: '+233241234567', amount: 2700000,
      country: 'GH', productType: '3', operator: '5', variationCode: '2470', fixed: true, email: 'a@b.co', phone: '241234567',
    });
    expect(r.status).toBe('success');
    expect(r.data.token).toBe('PIN 1234-5678');
    expect(r.data.pins).toEqual([{ pin: '1234-5678', serial: 'SN01' }]);
  });
});
