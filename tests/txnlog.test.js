// Every transaction is written to the server logs: who, what, how much;
// failed ones say why. Phone numbers are partly hidden.
const { api, auth, useDatabase, readyUser } = require('./helpers');
const { Transaction } = require('../src/models');
const { format, mask } = require('../src/services/txnLog');

useDatabase('txnlog');

let lines = [];
let logSpy;
let warnSpy;
beforeAll(() => {
  process.env.LOG_TRANSACTIONS = 'on';
});
afterAll(() => {
  delete process.env.LOG_TRANSACTIONS;
});
beforeEach(() => {
  lines = [];
  const keep = (...a) => lines.push(a.join(' '));
  logSpy = jest.spyOn(console, 'log').mockImplementation(keep);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(keep);
});
afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});
const settle = () => new Promise((r) => setTimeout(r, 400));
const txnLines = () => lines.filter((l) => l.startsWith('[TXN]'));

test('a successful payment: who, what, how much, reference', async () => {
  const u = await readyUser({ fund: 5000, fullName: 'Foday Sesay' });
  const r = await api().post('/api/services/airtime').set(auth(u.token)).send({ network: 'mtn', phone: '08031112222', amount: 1000, pin: u.pin });
  expect(r.status).toBe(201);
  await settle();
  const ref = r.body.data.transaction.reference;
  const line = txnLines().find((l) => l.includes(ref) && l.includes('SUCCESS'));
  expect(line).toBeDefined();
  expect(line).toMatch(/debit ₦1,000\.00/);
  expect(line).toMatch(/Foday Sesay \(/);
  expect(line).toMatch(/0803\*\*\*2222/); // recipient partly hidden
  expect(line).not.toMatch(/08031112222/);
  expect(line).not.toMatch(new RegExp(u.pin)); // never the PIN
});

test('a failed payment says why and that it was refunded (and keeps the reason)', async () => {
  const u = await readyUser({ fund: 5000, fullName: 'Aminata Kamara' });
  const r = await api().post('/api/services/airtime').set(auth(u.token)).send({ network: 'mtn', phone: '08030000000', amount: 100, pin: u.pin });
  await settle();
  const t = await Transaction.findOne({ user: u.user.id, type: 'airtime' }).sort({ createdAt: -1 });
  expect(t.status).toBe('failed');
  expect(t.metadata.failureReason).toBeTruthy();
  const line = txnLines().find((l) => l.includes(t.reference) && l.includes('FAILED'));
  expect(line).toBeDefined();
  expect(line).toMatch(/Aminata Kamara/);
  expect(line).toMatch(/reason: \S/);
  expect(line).toMatch(/refunded/);
  expect(r.status === 201 || r.status >= 400).toBe(true);
});

test('format and mask', () => {
  expect(mask('08031234567')).toBe('0803***4567');
  expect(mask('+23276123456')).toBe('+232***3456');
  expect(mask('12345')).toBe('12345');
  const line = format(
    { user: 'x', direction: 'debit', amount: 500000, currency: 'SLE', description: 'Electricity EDSA', recipient: '45123456901', reference: 'DP-1', status: 'failed', refunded: true, metadata: { failureReason: 'Invalid meter\nnumber' }, provider: 'sl' },
    { fullName: 'Ibrahim Conteh', phone: '076123456', country: 'SL' },
  );
  expect(line).toBe('[TXN] FAILED  | debit Le 5,000.00 | Electricity EDSA 4512***6901 | Ibrahim Conteh (0761***456, SL) | ref DP-1 | sl | reason: Invalid meter number | refunded');
});
