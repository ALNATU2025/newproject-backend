// Cashwyre: bank and mobile money transfers, and virtual dollar cards,
// against a fake Cashwyre API.
const { api, auth, useDatabase, readyUser, balanceOf } = require('./helpers');
const { User, Transaction, Card } = require('../src/models');
const env = require('../src/config/env');
const cashwyre = require('../src/providers/cashwyre');
const { clearFxCache } = require('../src/services/fx');
const { clearPayoutCache } = require('../src/services/payouts');
const { sweepOnce } = require('../src/services/pendingSweeper');

useDatabase('cashwyre');

const HOOK = 'hook-secret-1234567890';
const calls = [];
const statuses = {}; // payout reference → status
const cardsByEmail = {}; // email → [card]
let txn = 0;

const BANKS = {
  'NG:bank': [{ code: '0014', name: 'Access Bank', nameEnquiryRequired: true }],
  'NG:wallet': [],
  'GH:bank': [{ code: 'GCB', name: 'GCB Bank' }],
  'GH:wallet': [{ code: 'MTN_GH', name: 'MTN Mobile Money' }],
  'SL:bank': [],
  'SL:wallet': [{ code: 'OrangeMoney_SL', name: 'Orange Money' }],
};

const fakeCard = (email, n, amount) => ({
  code: `VCARD${n}`,
  customerEmail: email,
  cardBrand: 'visa',
  last4: `00${n}`.slice(-4),
  cardName: 'Test Card',
  validMonthYear: '12/2029',
  status: 'active',
  cardBalance: amount,
  cardNumber: '4519460050119928',
  cvV2: '014',
  billingAddressCity: 'Miami',
  history: [],
});

function cardByCode(code) {
  return Object.values(cardsByEmail).flat().find((c) => c.code === code);
}

async function fakeCashwyre(url, opts) {
  const path = url.replace(env.cashwyre.baseUrl + '/', '');
  const b = JSON.parse(opts.body);
  calls.push({ path, body: b, auth: opts.headers.Authorization });
  const reply = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
  const okData = (data) => reply({ success: true, message: 'Request Successful', data });
  switch (path) {
    case 'country/getCountryInfo':
      return okData(
        [['NG', 'NGN'], ['GH', 'GHS'], ['SL', 'SLE'], ['US', 'USD', false]].map(([code, currency, canPayout = true]) => ({
          code, name: code, canPayout, canDeposit: true, currencies: [{ currency }],
        })),
      );
    case 'CountryBank/getCountryBanks':
      return okData(BANKS[`${b.country}:${b.accountType}`] || []);
    case 'Payout/getFee':
      if (b.currency === 'GHS') return okData({ sendAmount: b.amount, currency: 'GHS', feeInLocalCurrency: 3, totalDebitAmount: b.amount + 3, totalDebitInUSD: 7.5 });
      return okData({ sendAmount: b.amount, currency: b.currency, feeInLocalCurrency: 10, totalDebitAmount: b.amount + 10, totalDebitInUSD: 22 });
    case 'businessRate/getFxRates':
      return okData([
        { currency: 'NGN', buyRate: 1500, sellRate: 1600 },
        { currency: 'SLE', buyRate: 22, sellRate: 24 },
      ]);
    case 'Payout/initiate':
      if (b.AccountNumber === '0000000') return reply({ success: false, message: 'Invalid account number' }, 400);
      txn += 1;
      statuses[b.Reference] = 'processing';
      return okData({ transactionReference: `CWTX${txn}`, reference: b.Reference });
    case 'Payout/getPayoutStatus':
      return okData({ status: statuses[b.reference] || 'processing', message: 'ok' });
    case 'CustomerCard/createCard': {
      const list = (cardsByEmail[b.email] = cardsByEmail[b.email] || []);
      list.push(fakeCard(b.email, Object.keys(cardsByEmail).length * 10 + list.length, b.amountInUSD));
      return okData({ CustomerId: 'CUST1' });
    }
    case 'CustomerCard/getCards':
      return okData((cardsByEmail[b.customerEmail] || []).map(({ history, ...c }) => c));
    case 'CustomerCard/getCard': {
      const { history, ...c } = cardByCode(b.cardCode);
      return okData(c);
    }
    case 'CustomerCard/topup':
      cardByCode(b.cardCode).cardBalance += b.amountInUSD;
      return okData({ code: b.cardCode });
    case 'CustomerCard/cardwithdrawal': {
      const c = cardByCode(b.cardCode);
      c.cardBalance -= b.amountInUSD;
      c.history.push({ Code: `W${c.history.length}`, Description: 'Withdraw from card - Test', Status: 'success', Reference: `CARDWDRL${c.history.length}`, Amount: b.amountInUSD, DRCR: 'DR', Category: 'card_withdrawal card', CreatedOn: new Date().toISOString() });
      return reply({ success: true, message: 'Card withdrawal request has been successfully initiated', data: true });
    }
    case 'CustomerCard/getCardTransactions':
      return reply({ Success: true, Message: 'Result successful', CardTransactions: cardByCode(b.cardCode).history });
    case 'customerCard/freezeCard':
    case 'customerCard/unfreezeCard':
      return okData(true);
    default:
      return reply({ success: false, message: `unknown ${path}` }, 404);
  }
}

beforeAll(() => {
  Object.assign(env.cashwyre, { secretKey: 'sk_test', businessCode: 'C4BTEST', webhookToken: HOOK });
  cashwyre.setFetch(fakeCashwyre);
});
afterAll(() => {
  Object.assign(env.cashwyre, { secretKey: '', businessCode: '', webhookToken: '' });
});
beforeEach(() => {
  calls.length = 0;
  clearFxCache();
  clearPayoutCache();
});

async function user(country, balance) {
  const u = await readyUser(country === 'SL' ? { country: 'SL' } : {});
  await User.updateOne({ _id: u.user.id }, { $set: { balance: balance * 100 } });
  return u;
}

const hook = (eventType, eventData, token = HOOK) => api().post(`/api/webhooks/cashwyre/${token}`).send({ eventType, eventData });

describe('countries and banks', () => {
  test('lists where money can go and whether mobile money works there', async () => {
    const u = await user('NG', 0);
    const r = await api().get('/api/payouts/countries').set(auth(u.token));
    expect(r.status).toBe(200);
    const byCode = Object.fromEntries(r.body.data.countries.map((c) => [c.code, c]));
    expect(Object.keys(byCode).sort()).toEqual(['GH', 'NG', 'SL']); // US can't receive payouts
    expect(byCode.GH).toEqual(expect.objectContaining({ currency: 'GHS', bank: true, mobileMoney: true }));
    expect(byCode.NG).toEqual(expect.objectContaining({ bank: true, mobileMoney: false }));
    expect(byCode.SL).toEqual(expect.objectContaining({ bank: false, mobileMoney: true }));
    expect(calls[0].auth).toBe('Bearer sk_test');
    expect(calls[0].body).toEqual(expect.objectContaining({ appId: 'C4BTEST', businessCode: 'C4BTEST' }));

    const w = await api().get('/api/payouts/banks?country=SL&type=mobile_money').set(auth(u.token));
    expect(w.body.data).toEqual([expect.objectContaining({ code: 'OrangeMoney_SL', name: 'Orange Money' })]);
  });
});

describe('transfers', () => {
  test('Nigeria → Ghana mobile money: priced in Naira, settled by webhook after checking', async () => {
    const u = await user('NG', 100000);
    const q = await api().post('/api/payouts/quote').set(auth(u.token)).send({
      country: 'GH', accountType: 'mobile_money', bankCode: 'MTN_GH', accountNumber: '0241234567', accountName: 'Kwame Mensah', amount: 100,
    });
    expect(q.status).toBe(200);
    // $7.50 × ₦1600 × 1.02 (FX margin) × 1.01 (fee)
    expect(q.body.data.charge).toBeCloseTo(12362.4, 2);
    expect(q.body.data.currency).toBe('GHS');

    const s = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: q.body.data.quoteToken, pin: u.pin });
    expect(s.status).toBe(201);
    expect(s.body.data.transaction).toEqual(expect.objectContaining({ type: 'payout', status: 'pending', amount: 12362.4, currency: 'NGN' }));
    const init = calls.find((c) => c.path === 'Payout/initiate').body;
    expect(init).toEqual(expect.objectContaining({ BankCode: 'MTN_GH', Amount: 100, Currency: 'GHS', Country: 'GH', DebitWalletCurrency: 'USD' }));
    expect((await balanceOf(u.token)).balance).toBeCloseTo(100000 - 12362.4, 2);

    // A webhook alone isn't trusted: Cashwyre still says "processing".
    await hook('payout.success', { reference: init.Reference, status: 'success' });
    expect((await Transaction.findOne({ reference: init.Reference })).status).toBe('pending');

    statuses[init.Reference] = 'success';
    const h = await hook('payout.success', { reference: init.Reference, status: 'success' });
    expect(h.body.data.result).toBe('success');
    expect((await Transaction.findOne({ reference: init.Reference })).status).toBe('success');
  });

  test('Sierra Leone → Orange Money in Leones; a failed payout is refunded by the sweeper', async () => {
    const u = await user('SL', 2000);
    const q = await api().post('/api/payouts/quote').set(auth(u.token)).send({
      country: 'SL', accountType: 'mobile_money', bankCode: 'OrangeMoney_SL', accountNumber: '076123456', accountName: 'Fatmata Kamara', amount: 500,
    });
    expect(q.status).toBe(200);
    expect(q.body.data.charge).toBeCloseTo(515.1, 2); // (500 + Le 10 fee) × 1.01
    expect(q.body.data.fee).toBeCloseTo(15.1, 2);
    const s = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: q.body.data.quoteToken, pin: u.pin });
    expect(s.status).toBe(201);
    const init = calls.find((c) => c.path === 'Payout/initiate').body;
    expect(init.DebitWalletCurrency).toBeUndefined();

    statuses[init.Reference] = 'failed';
    await Transaction.collection.updateOne({ reference: init.Reference }, { $set: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });
    await sweepOnce();
    const t = await Transaction.findOne({ reference: init.Reference });
    expect(t.status).toBe('failed');
    expect(t.refunded).toBe(true);
    expect((await balanceOf(u.token)).balance).toBeCloseTo(2000, 2);
  });

  test('declined straight away: refunded, and quotes can\'t be reused by others or changed', async () => {
    const u = await user('NG', 50000);
    const q = await api().post('/api/payouts/quote').set(auth(u.token)).send({
      country: 'NG', accountType: 'bank', bankCode: '0014', accountNumber: '0000000', accountName: 'Bad Account', amount: 1000,
    });
    expect(q.body.data.charge).toBeCloseTo(1020.1, 2);
    const other = await user('NG', 50000);
    const stolen = await api().post('/api/payouts/send').set(auth(other.token)).send({ quoteToken: q.body.data.quoteToken, pin: other.pin });
    expect(stolen.body.code).toBe('QUOTE_INVALID');
    const tampered = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: `${q.body.data.quoteToken}x`, pin: u.pin });
    expect(tampered.body.code).toBe('QUOTE_INVALID');

    const s = await api().post('/api/payouts/send').set(auth(u.token)).send({ quoteToken: q.body.data.quoteToken, pin: u.pin });
    expect(s.status).toBe(400);
    expect(s.body.code).toBe('TRANSFER_DECLINED');
    expect((await balanceOf(u.token)).balance).toBeCloseTo(50000, 2);
  });

  test('wrong bank or unsupported method is refused before any money moves', async () => {
    const u = await user('NG', 50000);
    const r = await api().post('/api/payouts/quote').set(auth(u.token)).send({
      country: 'NG', accountType: 'mobile_money', bankCode: 'X', accountNumber: '08031234567', accountName: 'Ada Obi', amount: 1000,
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('METHOD_NOT_SUPPORTED');
  });

  test('webhook with the wrong secret is ignored', async () => {
    const r = await hook('payout.success', { reference: 'x' }, 'wrong-token-wrong-token');
    expect(r.status).toBe(404);
  });
});

describe('dollar cards', () => {
  const details = {
    amountUsd: 10, brand: 'Visa', dateOfBirth: '1992-04-15', homeAddressNumber: '12B', homeAddress: 'Allen Avenue, Ikeja, Lagos', idType: 'nin', idNumber: '11002200301',
  };

  test('create, top up, reveal, withdraw back to the wallet, freeze', async () => {
    const u = await user('NG', 100000);
    const cfg = await api().get('/api/cards/config').set(auth(u.token));
    expect(cfg.body.data.idTypes.map((t) => t.id)).toEqual(['nin', 'bvn']);

    const quote = await api().get('/api/cards/quote?action=create&amountUsd=10').set(auth(u.token));
    expect(quote.body.data).toEqual(expect.objectContaining({ feeUsd: 2.5, totalUsd: 12.5, local: 20200 })); // 12.5 × 1600 × 1.01

    const c = await api().post('/api/cards').set(auth(u.token)).send({ ...details, pin: u.pin });
    expect(c.status).toBe(201);
    expect(c.body.data.card).toEqual(expect.objectContaining({ status: 'active', brand: 'Visa', balanceUsd: 10 }));
    expect(c.body.data.card.number).toBeUndefined();
    expect(c.body.data.transaction).toEqual(expect.objectContaining({ type: 'card_create', status: 'success', amount: 20200 }));
    const create = calls.find((x) => x.path === 'CustomerCard/createCard').body;
    expect(create).toEqual(expect.objectContaining({ phoneCode: '+234', cardType: 'virtual', amountInUSD: 10, idType: 'nin' }));
    expect((await balanceOf(u.token)).balance).toBeCloseTo(100000 - 20200, 2);
    const created = await Transaction.findOne({ type: 'card_create', user: u.user.id });
    expect(created.status).toBe('success');

    const id = c.body.data.card.id;
    const top = await api().post(`/api/cards/${id}/topup`).set(auth(u.token)).send({ amountUsd: 5, pin: u.pin });
    expect(top.status).toBe(201);
    expect(top.body.data.transaction.status).toBe('success');

    const reveal = await api().post(`/api/cards/${id}/reveal`).set(auth(u.token)).send({ pin: u.pin });
    expect(reveal.body.data).toEqual(expect.objectContaining({ number: '4519460050119928', cvv: '014' }));
    const wrongPin = await api().post(`/api/cards/${id}/reveal`).set(auth(u.token)).send({ pin: '000000' });
    expect(wrongPin.status).toBeGreaterThanOrEqual(400);

    const tooMuch = await api().post(`/api/cards/${id}/withdraw`).set(auth(u.token)).send({ amountUsd: 15, pin: u.pin });
    expect(tooMuch.body.code).toBe('CARD_BALANCE'); // $1 must stay

    const before = (await balanceOf(u.token)).balance;
    const w = await api().post(`/api/cards/${id}/withdraw`).set(auth(u.token)).send({ amountUsd: 3, pin: u.pin });
    expect(w.status).toBe(201);
    const wt = await Transaction.findById(w.body.data.transaction.id);
    expect(wt.status).toBe('success'); // confirmed in the card's history
    expect(wt.amount).toBe(441000); // $3 × ₦1500 × 0.98
    expect((await balanceOf(u.token)).balance).toBeCloseTo(before + 4410, 2);

    const f = await api().post(`/api/cards/${id}/freeze`).set(auth(u.token));
    expect(f.body.data.status).toBe('frozen');
    const blocked = await api().post(`/api/cards/${id}/topup`).set(auth(u.token)).send({ amountUsd: 5, pin: u.pin });
    expect(blocked.body.code).toBe('CARD_FROZEN');
  });

  test('a card that appears later is linked by the webhook', async () => {
    const u = await user('SL', 5000);
    const email = (await User.findById(u.user.id)).email;
    // Cashwyre is slow: the card doesn't show up in their list yet.
    const realFetch = fakeCashwyre;
    cashwyre.setFetch(async (url, opts) => {
      if (url.endsWith('CustomerCard/getCards')) return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) };
      if (url.endsWith('CustomerCard/createCard')) return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
      return realFetch(url, opts);
    });
    const c = await api().post('/api/cards').set(auth(u.token)).send({
      ...details, idType: 'national_id', idImageBase64: 'aGVsbG8=', pin: u.pin,
    });
    cashwyre.setFetch(realFetch);
    expect(c.status).toBe(201);
    expect(c.body.data.card.status).toBe('creating');

    cardsByEmail[email] = [fakeCard(email, 99, 10)];
    const h = await hook('virtualcard.created.completed', { cardCode: 'VCARD99', CustomerEmail: email });
    expect(h.body.data.result).toBe('linked');
    const card = await Card.findById(c.body.data.card.id);
    expect(card.status).toBe('active');
    expect(card.cardCode).toBe('VCARD99');
  });

  test('Sierra Leone ID types need a photo', async () => {
    const u = await user('SL', 5000);
    const r = await api().post('/api/cards').set(auth(u.token)).send({ ...details, idType: 'national_id', pin: u.pin });
    expect(r.body.code).toBe('ID_IMAGE_REQUIRED');
  });
});
