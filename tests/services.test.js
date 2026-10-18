const { api, auth, useDatabase, readyUser, balanceOf } = require('./helpers');
const { updateSettings } = require('../src/services/settings');

useDatabase('services');

const START = 9850; // ₦10,000 funded minus 1.5% fee

describe('catalogue', () => {
  test('lists networks, plans and providers', async () => {
    const u = await readyUser();
    const t = auth(u.token);
    expect((await api().get('/api/services/networks').set(t)).body.data).toHaveLength(4);
    const plans = await api().get('/api/services/data/plans?network=mtn').set(t);
    expect(plans.body.data[0]).toEqual(expect.objectContaining({ code: expect.any(String), amount: expect.any(Number) }));
    expect((await api().get('/api/services/cable/providers').set(t)).body.data.length).toBeGreaterThan(2);
    expect((await api().get('/api/services/cable/plans?provider=dstv').set(t)).body.data.length).toBeGreaterThan(3);
    expect((await api().get('/api/services/electricity/providers').set(t)).body.data.length).toBeGreaterThan(5);
    expect((await api().get('/api/services/education/products').set(t)).body.data[0].variations.length).toBeGreaterThan(0);
    const ins = await api().get('/api/services/insurance/options').set(t);
    expect(ins.body.data.types.length).toBe(4);
    const models = await api().get(`/api/services/insurance/models?make=${ins.body.data.makes[0].id}`).set(t);
    expect(models.body.data.length).toBeGreaterThan(0);
    expect((await api().get('/api/services/international/countries').set(t)).body.data.length).toBeGreaterThan(3);
    const status = await api().get('/api/services/status').set(t);
    expect(status.body.data.services.airtime).toBe(true);
    const rates = await api().get('/api/services/rates').set(t);
    expect(rates.body.data.airtime).toBe(2);
  });
});

describe('airtime', () => {
  test('success debits the wallet and pays commission', async () => {
    const u = await readyUser({ fund: 10000 });
    const r = await api()
      .post('/api/services/airtime')
      .set(auth(u.token))
      .send({ network: 'mtn', phone: '08031234567', amount: 1000, pin: u.pin });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction.status).toBe('success');
    expect(r.body.data.transaction.commission).toBe(20);
    const w = await balanceOf(u.token);
    expect(w.balance).toBe(START - 1000);
    expect(w.commissionBalance).toBe(20);
  });

  test('provider failure refunds the wallet', async () => {
    const u = await readyUser({ fund: 10000 });
    const r = await api()
      .post('/api/services/airtime')
      .set(auth(u.token))
      .send({ network: 'mtn', phone: '08030000000', amount: 500, pin: u.pin });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction.status).toBe('failed');
    expect(r.body.data.transaction.refunded).toBe(true);
    expect((await balanceOf(u.token)).balance).toBe(START);
  });

  test('provider pending keeps the money held', async () => {
    const u = await readyUser({ fund: 10000 });
    const r = await api()
      .post('/api/services/airtime')
      .set(auth(u.token))
      .send({ network: 'mtn', phone: '08039999999', amount: 500, pin: u.pin });
    expect(r.body.data.transaction.status).toBe('pending');
    expect((await balanceOf(u.token)).balance).toBe(START - 500);
  });

  test('duplicate within a minute is blocked', async () => {
    const u = await readyUser({ fund: 10000 });
    const body = { network: 'airtel', phone: '08123456789', amount: 300, pin: u.pin };
    expect((await api().post('/api/services/airtime').set(auth(u.token)).send(body)).status).toBe(201);
    const dup = await api().post('/api/services/airtime').set(auth(u.token)).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_TRANSACTION');
  });

  test('insufficient funds, minimum and limits', async () => {
    const u = await readyUser({ fund: 1000 });
    const t = auth(u.token);
    const poor = await api().post('/api/services/airtime').set(t).send({ network: 'mtn', phone: '08031111111', amount: 5000, pin: u.pin });
    expect(poor.status).toBe(402);
    const tiny = await api().post('/api/services/airtime').set(t).send({ network: 'mtn', phone: '08031111112', amount: 10, pin: u.pin });
    expect(tiny.status).toBe(400);
    expect(tiny.body.code).toBe('BELOW_MINIMUM');
    const huge = await api().post('/api/services/airtime').set(t).send({ network: 'mtn', phone: '08031111113', amount: 60000, pin: u.pin });
    expect(huge.body.code).toBe('LIMIT_PER_TRANSACTION');
    expect((await balanceOf(u.token)).balance).toBe(985);
  });

  test('maintenance mode and disabled services block purchases', async () => {
    const u = await readyUser({ fund: 10000 });
    const t = auth(u.token);
    await updateSettings({ services: { airtime: false } });
    const off = await api().post('/api/services/airtime').set(t).send({ network: 'mtn', phone: '08032222222', amount: 100, pin: u.pin });
    expect(off.status).toBe(503);
    expect(off.body.code).toBe('SERVICE_DISABLED');
    await updateSettings({ services: { airtime: true }, maintenance: true });
    const maint = await api().post('/api/services/airtime').set(t).send({ network: 'mtn', phone: '08032222223', amount: 100, pin: u.pin });
    expect(maint.body.code).toBe('MAINTENANCE');
    await updateSettings({ maintenance: false });
  });
});

describe('data, electricity, cable, education, insurance, international', () => {
  test('data uses the server price for the chosen plan', async () => {
    const u = await readyUser({ fund: 10000 });
    const plans = (await api().get('/api/services/data/plans?network=glo').set(auth(u.token))).body.data;
    const plan = plans[2];
    const r = await api()
      .post('/api/services/data')
      .set(auth(u.token))
      .send({ network: 'glo', phone: '08051234567', planCode: plan.code, pin: u.pin });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction.amount).toBe(plan.amount);
    const bad = await api()
      .post('/api/services/data')
      .set(auth(u.token))
      .send({ network: 'glo', phone: '08051234568', planCode: 'made-up', pin: u.pin });
    expect(bad.status).toBe(400);
  });

  test('electricity verify + purchase returns a token', async () => {
    const u = await readyUser({ fund: 10000 });
    const t = auth(u.token);
    const v = await api().post('/api/services/electricity/verify').set(t).send({ provider: 'ikeja-electric', meterNumber: '45031234567', meterType: 'prepaid' });
    expect(v.body.data.customerName).toBeTruthy();
    const notFound = await api().post('/api/services/electricity/verify').set(t).send({ provider: 'ikeja-electric', meterNumber: '45031234000', meterType: 'prepaid' });
    expect(notFound.status).toBe(400);
    const r = await api().post('/api/services/electricity').set(t).send({
      provider: 'ikeja-electric', meterNumber: '45031234567', meterType: 'prepaid', amount: 2500, phone: '08031234567', pin: u.pin,
    });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction.metadata.token).toMatch(/\d{4}-/);
  });

  test('cable renew uses the current package price × months', async () => {
    const u = await readyUser({ fund: 20000 });
    const t = auth(u.token);
    const v = await api().post('/api/services/cable/verify').set(t).send({ provider: 'gotv', smartcardNumber: '7023456789' });
    expect(v.status).toBe(200);
    const r = await api().post('/api/services/cable').set(t).send({
      provider: 'gotv', smartcardNumber: '7023456789', action: 'renew', months: 2, phone: '08031234567', pin: u.pin,
    });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction.amount).toBe(v.body.data.renewalAmount * 2);
  });

  test('education with quantity and JAMB profile', async () => {
    const u = await readyUser({ fund: 30000 });
    const t = auth(u.token);
    const products = (await api().get('/api/services/education/products').set(t)).body.data;
    const waec = products.find((p) => p.id === 'waec');
    const r = await api().post('/api/services/education').set(t).send({
      service: 'waec', variationCode: waec.variations[0].code, quantity: 2, phone: '08031234567', pin: u.pin,
    });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction.amount).toBe(waec.variations[0].amount * 2);
    expect(r.body.data.transaction.metadata.pins.length).toBeGreaterThan(0);
    const jamb = products.find((p) => p.id === 'jamb');
    const noProfile = await api().post('/api/services/education').set(t).send({
      service: 'jamb', variationCode: jamb.variations[0].code, phone: '08031234568', pin: u.pin,
    });
    expect(noProfile.status).toBe(400);
    const v = await api().post('/api/services/education/verify').set(t).send({ service: 'jamb', profileId: '1234567890' });
    expect(v.body.data.customerName).toBeTruthy();
  });

  test('insurance and international airtime', async () => {
    const u = await readyUser({ fund: 30000 });
    const t = auth(u.token);
    const ins = await api().post('/api/services/insurance').set(t).send({
      typeCode: 'private', plateNumber: 'lag123xy', insuredName: 'Adaeze Okafor', email: 'a@example.com', phone: '08031234567', pin: u.pin,
    });
    expect(ins.status).toBe(201);
    expect(ins.body.data.transaction.recipient).toBe('LAG123XY');
    const ops = (await api().get('/api/services/international/operators?country=GH&productType=topup').set(t)).body.data;
    const vars = (await api().get(`/api/services/international/variations?country=GH&operator=${ops[0].id}&productType=topup`).set(t)).body.data;
    const r = await api().post('/api/services/international').set(t).send({
      country: 'GH', productType: 'topup', operator: ops[0].id, variationCode: vars.variations[0].code, phone: '241234567', amount: 10, pin: u.pin,
    });
    expect(r.status).toBe(201);
    expect(r.body.data.transaction.amount).toBe(10 * vars.rate);
  });
});

describe('earnings', () => {
  test('commission summary and withdrawal minimum', async () => {
    const u = await readyUser({ fund: 30000 });
    const t = auth(u.token);
    const small = await api().post('/api/commission/withdraw').set(t).send({});
    expect(small.status).toBe(400);
    await updateSettings({ minCommissionWithdrawal: 1000 }); // ₦10
    await api().post('/api/services/airtime').set(t).send({ network: 'mtn', phone: '08036666666', amount: 20000, pin: u.pin });
    const c = await api().get('/api/commission').set(t);
    expect(c.body.data.balance).toBe(400);
    expect(c.body.data.week).toHaveLength(7);
    const before = (await balanceOf(u.token)).balance;
    const w = await api().post('/api/commission/withdraw').set(t).send({});
    expect(w.status).toBe(201);
    const after = await balanceOf(u.token);
    expect(after.commissionBalance).toBe(0);
    expect(after.balance).toBe(before + 400);
  });
});
