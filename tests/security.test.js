// API hardening: NoSQL-injection guard, no caching, login lockout, hidden
// secrets in request logs.
const { api, auth, useDatabase, readyUser, signUp } = require('./helpers');
const { safeUrl, unsafe } = require('../src/middleware/security');

useDatabase('security');

test('MongoDB operators in bodies and queries are refused', async () => {
  const r = await api().post('/api/auth/login').send({ identifier: { $ne: null }, password: { $gt: '' } });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('INVALID_INPUT');
  const u = await readyUser({});
  const q = await api().get('/api/transactions?status[$ne]=x').set(auth(u.token));
  expect(q.body.code).toBe('INVALID_INPUT');
  expect(unsafe({ a: { b: { 'x.y': 1 } } })).toBe(true);
  expect(unsafe({ a: [{ ok: 1 }], b: 'text with $ and . is fine' })).toBe(false);
});

test('API answers are never cached', async () => {
  const u = await readyUser({});
  const r = await api().get('/api/me').set(auth(u.token));
  expect(r.headers['cache-control']).toBe('no-store');
  expect(r.headers['x-powered-by']).toBeUndefined();
  expect(r.headers['strict-transport-security']).toBeTruthy();
});

test('10 wrong passwords lock the account for 15 minutes, even with the right password', async () => {
  const s = await signUp({});
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop
    await api().post('/api/auth/login').send({ identifier: s.email, password: 'WrongPass999' });
  }
  const locked = await api().post('/api/auth/login').send({ identifier: s.email, password: s.password });
  expect(locked.status).toBe(429);
  expect(locked.body.code).toBe('ACCOUNT_LOCKED');
});

test('the right password resets the wrong-password count', async () => {
  const s = await signUp({});
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await api().post('/api/auth/login').send({ identifier: s.email, password: 'WrongPass999' });
  }
  expect((await api().post('/api/auth/login').send({ identifier: s.email, password: s.password })).body.data.token).toBeTruthy();
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop
    await api().post('/api/auth/login').send({ identifier: s.email, password: 'WrongPass999' });
  }
  expect((await api().post('/api/auth/login').send({ identifier: s.email, password: s.password })).body.data.token).toBeTruthy();
});

test('secret tokens are hidden in request logs', () => {
  expect(safeUrl({ originalUrl: '/api/webhooks/kuda/abc123secret' })).toBe('/api/webhooks/kuda/[hidden]');
  expect(safeUrl({ originalUrl: '/api/funding-actions/eyJhbGci.x.y' })).toBe('/api/funding-actions/[hidden]');
  expect(safeUrl({ originalUrl: '/api/x?token=abc&b=1' })).toBe('/api/x?token=[hidden]&b=1');
});
