const { api, auth, useDatabase, signUp, readyUser } = require('./helpers');

useDatabase('auth');

describe('sign up', () => {
  test('register sends a code, verify creates the account and logs in', async () => {
    const s = await signUp({ fullName: 'Adaeze Okafor' });
    expect(s.token).toBeTruthy();
    expect(s.user.fullName).toBe('Adaeze Okafor');
    expect(s.user.emailVerified).toBe(true);
    expect(s.user.pinSet).toBe(false);
    expect(s.user.balance).toBe(0);
    expect(s.user.referralCode).toMatch(/^ADAEZE/);
    const me = await api().get('/api/me').set(auth(s.token));
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(s.email);
  });

  test('rejects duplicate email and weak password', async () => {
    const s = await signUp();
    const dup = await api().post('/api/auth/register').send({
      fullName: 'Someone Else', email: s.email, phone: '08099999999', password: 'Passw0rdOk',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('EMAIL_TAKEN');
    const weak = await api().post('/api/auth/register').send({
      fullName: 'Weak Pass', email: 'weak@example.com', phone: '08011112222', password: 'password',
    });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('VALIDATION_ERROR');
  });

  test('wrong code is rejected', async () => {
    const start = await api().post('/api/auth/register').send({
      fullName: 'Code Test', email: 'code@example.com', phone: '08022223333', password: 'Passw0rdOk',
    });
    expect(start.status).toBe(200);
    const wrong = start.body.data.devCode === '000000' ? '111111' : '000000';
    const r = await api().post('/api/auth/register/verify').send({ email: 'code@example.com', code: wrong });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CODE_INVALID');
  });

  test('invalid referral code is rejected; valid one links the referrer', async () => {
    const bad = await api().post('/api/auth/register').send({
      fullName: 'Ref Test', email: 'ref@example.com', phone: '08033334444', password: 'Passw0rdOk', referralCode: 'NOPE1234',
    });
    expect(bad.status).toBe(400);
    const referrer = await signUp();
    const friend = await signUp({ referralCode: referrer.user.referralCode });
    expect(friend.user.id).toBeTruthy();
    const ref = await api().get('/api/referrals').set(auth(referrer.token));
    expect(ref.body.data.totalReferrals).toBe(1);
  });
});

describe('login', () => {
  test('with email or phone; wrong password fails', async () => {
    const s = await signUp();
    const byEmail = await api().post('/api/auth/login').send({ identifier: s.email, password: s.password });
    expect(byEmail.status).toBe(200);
    expect(byEmail.body.data.token).toBeTruthy();
    const byPhone = await api().post('/api/auth/login').send({ identifier: s.phone, password: s.password });
    expect(byPhone.status).toBe(200);
    const wrong = await api().post('/api/auth/login').send({ identifier: s.email, password: 'Wrong1234' });
    expect(wrong.status).toBe(401);
  });

  test('requests without a token are rejected', async () => {
    const r = await api().get('/api/me');
    expect(r.status).toBe(401);
  });
});

describe('password', () => {
  test('forgot → code → reset → login with the new password', async () => {
    const s = await signUp();
    const f = await api().post('/api/auth/password/forgot').send({ email: s.email });
    expect(f.status).toBe(200);
    const v = await api().post('/api/auth/password/verify-code').send({ email: s.email, code: f.body.data.devCode });
    expect(v.status).toBe(200);
    const reset = await api().post('/api/auth/password/reset').send({ resetToken: v.body.data.resetToken, password: 'NewPassw0rd' });
    expect(reset.status).toBe(200);
    const old = await api().post('/api/auth/login').send({ identifier: s.email, password: s.password });
    expect(old.status).toBe(401);
    const fresh = await api().post('/api/auth/login').send({ identifier: s.email, password: 'NewPassw0rd' });
    expect(fresh.status).toBe(200);
    // old session token is no longer valid
    const me = await api().get('/api/me').set(auth(s.token));
    expect(me.status).toBe(401);
  });

  test('forgot password does not reveal unknown emails', async () => {
    const r = await api().post('/api/auth/password/forgot').send({ email: 'nobody@example.com' });
    expect(r.status).toBe(200);
    expect(r.body.data.devCode).toBeUndefined();
  });

  test('change password returns a new token', async () => {
    const s = await signUp();
    const r = await api()
      .post('/api/auth/password/change')
      .set(auth(s.token))
      .send({ currentPassword: s.password, newPassword: 'Changed1Pass' });
    expect(r.status).toBe(200);
    expect((await api().get('/api/me').set(auth(r.body.data.token))).status).toBe(200);
    expect((await api().get('/api/me').set(auth(s.token))).status).toBe(401);
  });
});

describe('payment PIN', () => {
  test('set, verify, change, weak PIN rejected', async () => {
    const s = await signUp();
    const weak = await api().post('/api/auth/pin/set').set(auth(s.token)).send({ pin: '123456' });
    expect(weak.status).toBe(400);
    expect((await api().post('/api/auth/pin/set').set(auth(s.token)).send({ pin: '246813' })).status).toBe(200);
    expect((await api().post('/api/auth/pin/set').set(auth(s.token)).send({ pin: '246813' })).status).toBe(409);
    expect((await api().post('/api/auth/pin/verify').set(auth(s.token)).send({ pin: '246813' })).status).toBe(200);
    const change = await api().post('/api/auth/pin/change').set(auth(s.token)).send({ currentPin: '246813', newPin: '975310' });
    expect(change.status).toBe(200);
    expect((await api().post('/api/auth/pin/verify').set(auth(s.token)).send({ pin: '975310' })).status).toBe(200);
  });

  test('locks after 5 wrong attempts', async () => {
    const u = await readyUser();
    for (let i = 0; i < 4; i++) {
      const r = await api().post('/api/auth/pin/verify').set(auth(u.token)).send({ pin: '000001' });
      expect(r.status).toBe(400);
    }
    const fifth = await api().post('/api/auth/pin/verify').set(auth(u.token)).send({ pin: '000001' });
    expect(fifth.status).toBe(423);
    const correct = await api().post('/api/auth/pin/verify').set(auth(u.token)).send({ pin: u.pin });
    expect(correct.status).toBe(423);
  });

  test('forgot PIN → code → new PIN', async () => {
    const u = await readyUser();
    const f = await api().post('/api/auth/pin/forgot').set(auth(u.token));
    expect(f.status).toBe(200);
    const r = await api().post('/api/auth/pin/reset').set(auth(u.token)).send({ code: f.body.data.devCode, newPin: '864201' });
    expect(r.status).toBe(200);
    expect((await api().post('/api/auth/pin/verify').set(auth(u.token)).send({ pin: '864201' })).status).toBe(200);
  });
});

describe('records from another app', () => {
  test('a user without passwordHash gets a clear 401, not a crash', async () => {
    const { User } = require('../src/models');
    await User.collection.insertOne({ email: 'old@example.com', phone: '08055550000', password: '$2a$10$abc', fullName: 'Old User' });
    const r = await api().post('/api/auth/login').send({ identifier: 'old@example.com', password: 'whatever1A' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('LEGACY_ACCOUNT');
    await User.collection.deleteOne({ email: 'old@example.com' });
  });
});

describe('email service refuses the message', () => {
  test('sign-up gets a clear 503, can retry at once, and /health shows the cause', async () => {
    const env = require('../src/config/env');
    const realFetch = global.fetch;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    env.resendApiKey = 're_test';
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({
        statusCode: 403,
        message: 'You can only send testing emails to your own email address (owner@example.com).',
      }),
    }));
    try {
      const body = { fullName: 'Mail Fail', email: 'mailfail@example.com', phone: '08033334444', password: 'Passw0rdOk' };
      const r = await api().post('/api/auth/register').send(body);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('EMAIL_FAILED');
      // Retry is not blocked by the 45-second wait.
      const again = await api().post('/api/auth/register').send(body);
      expect(again.body.code).toBe('EMAIL_FAILED');
      const h = await api().get('/health');
      expect(h.body.data.email).toMatch(/FAILED.*test mode/);
      expect(h.body.data.email).not.toMatch(/owner@example\.com/);
      expect(errSpy.mock.calls.join(' ')).toMatch(/Email NOT sent \(403\)/);
    } finally {
      global.fetch = realFetch;
      env.resendApiKey = '';
      errSpy.mockRestore();
    }
  });
});
