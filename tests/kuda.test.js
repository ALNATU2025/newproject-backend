// Kuda Business: Add Money account numbers (Nigeria) and bank transfers to
// Nigeria from Sierra Leone accounts. Kuda's API is faked here.
const jwt = require('jsonwebtoken');
const { api, auth, useDatabase, readyUser, balanceOf } = require('./helpers');
const { User, Transaction } = require('../src/models');
const env = require('../src/config/env');
const kuda = require('../src/providers/kuda');
const { setPaymentProvider } = require('../src/providers/payment');
const { clearPayoutCache } = require('../src/services/payouts');

useDatabase('kuda');

const HOOK = 'kudahook_0123456789abcdef';
const mark = (m) => process.stdout.write(`::warning::KUDA ${m}\n`);
const calls = [];
let nextAccount = 7000001000;
const transfers = {}; // requestRef → status word
let transferMode = 'ok'; // ok | decline | timeout

function reply(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

async function fakeKuda(url, opts) {
  mark(`fetch ${url} ${String(opts && opts.body).slice(0, 80)}`);
  if (url.endsWith('/Account/GetToken')) {
    calls.push({ service: 'TOKEN', body: JSON.parse(opts.body) });
    return reply(200, jwt.sign({ sub: 'biz' }, 'x', { expiresIn: '1h' }));
  }
  const { serviceType, requestRef, data } = JSON.parse(opts.body);
  calls.push({ service: serviceType, requestRef, data, auth: opts.headers.Authorization });
  const ok = (d) => reply(200, { status: true, message: 'Request successful', data: d });
  switch (serviceType) {
    case 'ADMIN_CREATE_DYNAMIC_COLLECTION_ACCOUNT':
      nextAccount += 1;
      return ok({ accountNumber: String(nextAccount), accountName: `Dalabapay/${data.accountName}`, bankName: 'Kuda MFB' });
    case 'BANK_LIST':
      return ok({ banks: [{ bankCode: '000013', bankName: 'GTBank' }, { bankCode: '090267', bankName: 'Kuda.' }] });
    case 'NAME_ENQUIRY':
      if (data.beneficiaryAccountNumber === '0000000000') return reply(200, { status: false, message: 'Account not found' });
      return ok({ beneficiaryName: 'ADA OBI', sessionID: 'SESS123' });
    case 'SINGLE_FUND_TRANSFER':
      if (transferMode === 'decline') return reply(200, { status: false, message: 'Insufficient funds on account' });
      if (transferMode === 'timeout') throw new Error('socket hang up');
      transfers[requestRef] = 'Transaction successful';
      return ok({ transactionReference: `KT${requestRef}` });
    case 'TRANSACTION_STATUS_QUERY': {
      const word = transfers[data.transactionRequestReference];
      if (!word) return reply(200, { status: false, message: 'Not found', responseCode: 'k25' });
      return ok({ status: true, message: word });
    }
    default:
      return reply(200, { status: false, message: `unknown ${serviceType}` });
  }
}

beforeAll(() => {
  mark('beforeAll');
  Object.assign(env.kuda, { email: 'biz@example.com', apiKey: 'kuda_test_key', accountNumber: '3002991121', env: 'uat', webhookToken: HOOK });
  env.cashwyre.fxFallback = { SLE: 24, NGN: 1500 };
  kuda.setFetch(fakeKuda);
  setPaymentProvider(require('../src/providers/payment/kuda'));
  clearPayoutCache();
});
afterAll(() => {
  Object.assign(env.kuda, { email: '', apiKey: '', accountNumber: '', webhookToken: '' });
  env.cashwyre.fxFallback = {};
  setPaymentProvider(null);
});
beforeEach(() => {
  calls.length = 0;
  transferMode = 'ok';
});

describe('Add Money (Nigeria): own Kuda account number', () => {
  test('created the first time Add Money opens, no ID check, kept afterwards', async () => {
    mark('start created the first time Add Money opens, ');
    const u = await readyUser({});
    const w = (await api().get('/api/wallet').set(auth(u.token))).body.data;
    expect(w.dedicatedAccount).toEqual(expect.objectContaining({ accountNumber: expect.stringMatching(/^7\d{9}$/), bankName: 'Kuda MFB' }));
    expect(w.accountNumberOnly).toBe(true);
    expect(w.oneTimeAvailable).toBe(false);
    expect(w.manualBank).toBeNull();
    const create = calls.find((c) => c.service === 'ADMIN_CREATE_DYNAMIC_COLLECTION_ACCOUNT');
    expect(create.data).toEqual(expect.objectContaining({ amount: 0, isPassThrough: true }));
    expect(create.data.remittingAccounts).toEqual([{ splitPercentage: 100, accountNumber: '3002991121' }]);
    expect(create.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

    calls.length = 0;
    const again = (await api().get('/api/wallet').set(auth(u.token))).body.data;
    expect(again.dedicatedAccount.accountNumber).toBe(w.dedicatedAccount.accountNumber);
    expect(calls.some((c) => c.service === 'ADMIN_CREATE_DYNAMIC_COLLECTION_ACCOUNT')).toBe(false);
  });

  test('money sent to it is credited once (webhook with the secret URL)', async () => {
    mark('start money sent to it is credited once (webho');
    const u = await readyUser({});
    const acct = (await api().get('/api/wallet').set(auth(u.token))).body.data.dedicatedAccount.accountNumber;
    const before = (await balanceOf(u.token)).balance;
    const body = { transactionType: 'Credit', amount: '500000', accountNumber: acct, transactionReference: 'KTX0001', senderName: 'ADA OBI', narrations: 'top up' };

    expect((await api().post('/api/webhooks/kuda/wrong-token').send(body)).status).toBe(404);
    const r = await api().post(`/api/webhooks/kuda/${HOOK}`).send(body);
    expect(r.status).toBe(200);
    expect(r.body.data.credited).toBe(true);
    // ₦5,000 less the 1.5% funding fee
    expect((await balanceOf(u.token)).balance).toBeCloseTo(before + 4925, 2);
    const again = await api().post(`/api/webhooks/kuda/${HOOK}`).send(body);
    expect(again.body.data.credited).toBe(false);
    expect((await balanceOf(u.token)).balance).toBeCloseTo(before + 4925, 2);
    const t = await Transaction.findOne({ providerReference: 'KUDA-KTX0001' });
    expect(t.description).toMatch(/ADA OBI/);

    // Debits and unknown accounts are not credited.
    expect((await api().post(`/api/webhooks/kuda/${HOOK}`).send({ ...body, transactionType: 'Debit', transactionReference: 'KTX2' })).body.data.ignored).toBe(true);
    const stray = await api().post(`/api/webhooks/kuda/${HOOK}`).send({ ...body, accountNumber: '7999999999', transactionReference: 'KTX3' });
    expect(stray.body.data.credited).toBe(false);
  });
});

describe('Transfers to Nigerian banks (Sierra Leone accounts) through Kuda', () => {
  const sl = async (le = 1000) => {
    const u = await readyUser({ country: 'SL' });
    await User.updateOne({ _id: u.user.id }, { $set: { balance: le * 100 } });
    return u;
  };
  const quote = (u, extra = {}) => api().post('/api/payouts/quote').set(auth(u.token)).send({
    country: 'NG', accountType: 'bank', bankCode: '000013', accountNumber: '0123456789', amount: 1000, ...extra,
  });

  test('Nigeria offered with Kuda\'s bank list; the name comes from Kuda', async () => {
    mark('start Nigeria offered with Kuda\'s bank list; ');
    const u = await sl();
    const c = (await api().get('/api/payouts/countries').set(auth(u.token))).body.data;
    expect(c.connected).toBe(true);
    expect(c.countries.find((x) => x.code === 'NG')).toEqual(expect.objectContaining({ provider: 'kuda', available: true, bank: true }));
    const banks = (await api().get('/api/payouts/banks').query({ country: 'NG', type: 'bank' }).set(auth(u.token))).body.data;
    expect(banks.map((b) => b.name)).toEqual(['GTBank', 'Kuda.']);
    const look = await api().post('/api/payouts/lookup').set(auth(u.token)).send({ country: 'NG', bankCode: '000013', accountNumber: '0123456789' });
    expect(look.body.data).toEqual(expect.objectContaining({ accountName: 'ADA OBI', verified: true }));
  });

  test('priced in Leones (₦ amount + Kuda fee at the rate), sent from the Kuda account, settled by TSQ', async () => {
    mark('start priced in Leones (₦ amount + Kuda fee at');
    const u = await sl();
    const q = await quote(u);
    expect(q.status).toBe(200);
    // (₦1,000 + ₦15 Kuda fee) × Le 24/₦1,500 × 1.02 × 1.01 = Le 16.73
    expect(q.body.data.charge).toBeCloseTo(16.73, 1);
    expect(q.body.data.accountName).toBe('ADA OBI');
    expect(q.body.data.breakdown.cashwyre).toEqual(expect.objectContaining({ provider: 'kuda', fee: 15, feeCurrency: 'NGN', wallet: 'NGN' }));

    const s = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: q.body.data.quoteToken, pin: u.pin });
    expect(s.status).toBe(201);
    const sent = calls.find((c) => c.service === 'SINGLE_FUND_TRANSFER');
    expect(sent.data).toEqual(expect.objectContaining({
      beneficiaryAccount: '0123456789', beneficiaryBankCode: '000013', amount: '100000', clientAccountNumber: '3002991121', beneficiaryName: 'ADA OBI',
    }));
    expect(sent.requestRef).toMatch(/^PO[0-9A-F]+$/i);
    const t = await Transaction.findOne({ reference: sent.requestRef });
    expect(t.provider).toBe('kuda');
    expect(t.status).toBe('success'); // TSQ said successful
    const tsq = calls.find((c) => c.service === 'TRANSACTION_STATUS_QUERY');
    expect(tsq.data).toEqual({ isThirdPartyBankTransfer: true, transactionRequestReference: sent.requestRef });
  });

  test('declined by Kuda: refunded straight away', async () => {
    mark('start declined by Kuda: refunded straight away');
    const u = await sl();
    const q = await quote(u, { amount: 500 });
    transferMode = 'decline';
    const s = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: q.body.data.quoteToken, pin: u.pin });
    expect(s.body.code).toBe('TRANSFER_DECLINED');
    expect((await balanceOf(u.token)).balance).toBeCloseTo(1000, 2);
  });

  test('no answer from Kuda: stays pending (never resent) until TSQ knows', async () => {
    mark('start no answer from Kuda: stays pending (neve');
    const u = await sl();
    const q = await quote(u, { amount: 700 });
    transferMode = 'timeout';
    const s = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: q.body.data.quoteToken, pin: u.pin });
    expect(s.status).toBe(201);
    expect(s.body.data.transaction.status).toBe('pending');
    expect(calls.filter((c) => c.service === 'SINGLE_FUND_TRANSFER')).toHaveLength(1);
    const { checkPayout } = require('../src/services/payouts');
    const t = await Transaction.findById(s.body.data.transaction.id);
    expect((await checkPayout(t)).result).toBe('pending'); // k25: not found yet
    transfers[t.reference] = 'Transaction failed';
    expect((await checkPayout(await Transaction.findById(t._id))).result).toBe('failed');
    expect((await balanceOf(u.token)).balance).toBeCloseTo(1000, 2);
  });

  test('an account Kuda can\'t find is refused before paying', async () => {
    mark('start an account Kuda can\'t find is refused b');
    const u = await sl();
    const q = await quote(u, { accountNumber: '0000000000' });
    expect(q.body.code).toBe('ACCOUNT_NOT_VERIFIED');
  });
});
