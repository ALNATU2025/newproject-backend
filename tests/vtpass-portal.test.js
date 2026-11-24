// Admin → VTpass portal: every VTpass payment, totals, success rate and the
// commission VTpass pays Dalabapay (VTpass's figure, else 1.8%).
const { api, auth, useDatabase, readyUser } = require('./helpers');
const { Transaction } = require('../src/models');

useDatabase('vtpassportal');
beforeEach(() => Transaction.deleteMany({}));

async function seed(user) {
  const base = { user: user.user.id, provider: 'vtpass', direction: 'debit', type: 'cable' };
  await Transaction.create([
    { ...base, reference: 'VT-1', amount: 1900000, status: 'success', recipient: '7039216378', description: 'DStv Compact', commission: 9500,
      metadata: { provider: 'DStv', providerRaw: { code: '000', transactionId: '1732001', status: 'delivered', commission: 285 } } },
    { ...base, reference: 'VT-2', amount: 1000000, status: 'success', recipient: '7020000001', description: 'GOtv Supa', commission: 5000,
      metadata: { provider: 'GOtv', providerRaw: { code: '000', transactionId: '1732002', status: 'delivered' } } },
    { ...base, reference: 'VT-3', amount: 1900000, status: 'failed', refunded: true, recipient: '7039216378', description: 'DStv Current package',
      metadata: { provider: 'DStv', failureReason: 'TRANSACTION FAILED', providerRaw: { code: '016' } } },
    { ...base, type: 'international', reference: 'VT-4', amount: 500000, status: 'pending', recipient: '+233241234567', description: 'Ghana airtime', metadata: {} },
    { user: user.user.id, provider: 'simulator', direction: 'debit', type: 'airtime', reference: 'NOT-VT', amount: 100000, status: 'success', metadata: {} },
  ]);
}

test('dashboard: totals, success rate, commission (reported + 1.8%), by service, failures', async () => {
  const admin = await readyUser({ role: 'super' });
  const customer = await readyUser({ fullName: 'Alusine Jalloh' });
  await seed(customer);
  const r = await api().get('/api/admin/vtpass/summary?period=month').set(auth(admin.token));
  expect(r.status).toBe(200);
  const s = r.body.data;
  expect(s.counts).toEqual({ total: 4, success: 2, failed: 1, pending: 1, refunded: 0 });
  expect(s.successRate).toBeCloseTo(66.7, 1);
  expect(s.volume).toBe(29000);
  expect(s.commissionRate).toBe(1.8);
  // ₦285 reported by VTpass + 1.8% of ₦10,000 = ₦180 → ₦465
  expect(s.commission.earned).toBeCloseTo(465, 2);
  expect(s.commission.reportedByVtpass).toBe(285);
  expect(s.commission.reportedCount).toBe(1);
  expect(s.commission.estimatedCount).toBe(1);
  expect(s.commission.paidToUsers).toBe(145);
  expect(s.commission.net).toBeCloseTo(320, 2);
  expect(s.byService.map((x) => x.label)).toEqual(expect.arrayContaining(['DStv', 'GOtv']));
  expect(s.topFailures[0]).toEqual(expect.objectContaining({ reason: 'TRANSACTION FAILED', count: 1 }));
  expect(s.series.length).toBeGreaterThan(0);
  expect(s.seriesUnit).toBe('day');
});

test('transactions: list, filters, search, CSV; commission rate setting', async () => {
  const admin = await readyUser({ role: 'super' });
  const customer = await readyUser({ fullName: 'Fatmata Bangura' });
  await seed(customer);
  const a = auth(admin.token);

  const all = (await api().get('/api/admin/vtpass/transactions').set(a)).body.data;
  expect(all.total).toBe(4); // simulator payment not included
  expect(all.totals).toEqual({ volume: 29000, commission: 465 });
  const dstv = all.items.find((x) => x.reference === 'VT-1');
  expect(dstv).toEqual(expect.objectContaining({ serviceLabel: 'DStv', amount: 19000, commission: 285, commissionReported: true, userCommission: 95 }));
  expect(dstv.vtpass.transactionId).toBe('1732001');
  expect(dstv.user.fullName).toBe('Fatmata Bangura');
  expect(all.items.find((x) => x.reference === 'VT-2').commission).toBe(180);

  const failed = (await api().get('/api/admin/vtpass/transactions?status=failed').set(a)).body.data;
  expect(failed.items.map((x) => x.reference)).toEqual(['VT-3']);
  expect(failed.items[0]).toEqual(expect.objectContaining({ failureReason: 'TRANSACTION FAILED', refunded: true }));
  expect(failed.items[0].vtpass.code).toBe('016');

  expect((await api().get('/api/admin/vtpass/transactions?q=Fatmata').set(a)).body.data.total).toBe(4);
  expect((await api().get('/api/admin/vtpass/transactions?q=1732002').set(a)).body.data.items[0].reference).toBe('VT-2');
  expect((await api().get('/api/admin/vtpass/transactions?status=pending').set(a)).body.data.items[0].reference).toBe('VT-4');

  const csv = await api().get('/api/admin/vtpass/transactions.csv').set(a);
  expect(csv.status).toBe(200);
  expect(csv.headers['content-type']).toMatch(/text\/csv/);
  expect(csv.text).toMatch(/VT-1,1732001,Fatmata Bangura/);
  expect(csv.text).toMatch(/1\.8% estimate/);

  expect((await api().patch('/api/admin/vtpass/settings').set(a).send({ commissionRate: 2 })).body.data.commissionRate).toBe(2);
  const again = (await api().get('/api/admin/vtpass/summary').set(a)).body.data;
  expect(again.commissionRate).toBe(2);
  expect(again.commission.earned).toBeCloseTo(285 + 200, 2);

  const support = await readyUser({ role: 'support' });
  expect((await api().patch('/api/admin/vtpass/settings').set(auth(support.token)).send({ commissionRate: 5 })).status).toBe(403);
  expect((await api().get('/api/admin/vtpass/transactions').set(auth(customer.token))).status).toBe(403);
});
