// Logging in on a new device (Nigeria and Sierra Leone): a 6-digit code is
// emailed to the account and must be entered before the session starts.
const crypto = require('crypto');
const { api, useDatabase, signUp } = require('./helpers');
const { Otp } = require('../src/models');

useDatabase('devicecheck');
// The new-device code is off by default; these tests check it switched on.
beforeAll(() => require('../src/services/settings').updateSettings({ deviceCheck: { enabled: true } }));

const device = (id) => ({ 'X-Device-Id': id, 'X-Device-Name': 'Test phone', 'X-Device-Platform': 'android' });
const newId = () => crypto.randomBytes(16).toString('hex');
const login = (s, headers) => api().post('/api/auth/login').set(headers).send({ identifier: s.email, password: s.password });
const verify = (headers, body) => api().post('/api/auth/login/verify-device').set(headers).send(body);

for (const country of ['NG', 'SL']) {
  describe(country === 'SL' ? 'Sierra Leone' : 'Nigeria', () => {
    test('known device logs in straight away; a new one needs the emailed code', async () => {
      const s = await signUp({ country });
      const A = newId();
      const B = newId();
      // First device: trusted.
      const first = await login(s, device(A));
      expect(first.body.data.token).toBeTruthy();
      // Same device again: still straight in.
      expect((await login(s, device(A))).body.data.token).toBeTruthy();

      // New device: no session, a code is emailed.
      const r = await login(s, device(B));
      expect(r.status).toBe(200);
      expect(r.body.data.token).toBeUndefined();
      expect(r.body.data).toEqual(expect.objectContaining({ verification: 'device', challenge: expect.any(String) }));
      expect(r.body.data.email).toMatch(/•+@example\.com$/);
      expect(r.body.data.email).not.toBe(s.email);
      expect(await Otp.exists({ email: s.email, purpose: 'new_device' })).toBeTruthy();

      // Wrong code, wrong device, then the right code.
      expect((await verify(device(B), { challenge: r.body.data.challenge, code: '000000' })).body.code).toBe('CODE_INVALID');
      expect((await verify(device(newId()), { challenge: r.body.data.challenge, code: r.body.data.devCode })).body.code).toBe('CHALLENGE_DEVICE_MISMATCH');
      const ok = await verify(device(B), { challenge: r.body.data.challenge, code: r.body.data.devCode });
      expect(ok.status).toBe(200);
      expect(ok.body.data.token).toBeTruthy();
      expect(ok.body.data.user.email).toBe(s.email);
      // The code can't be used twice, and device B is now known.
      expect((await verify(device(B), { challenge: r.body.data.challenge, code: r.body.data.devCode })).body.code).toBe('CODE_EXPIRED');
      expect((await login(s, device(B))).body.data.token).toBeTruthy();
    });

    test('no device id once the account has a device: asked to update the app', async () => {
      const s = await signUp({ country });
      await login(s, device(newId()));
      const r = await api().post('/api/auth/login').send({ identifier: s.email, password: s.password });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('APP_UPDATE_REQUIRED');
    });

    test('a wrong password never sends a code; a forged challenge is refused', async () => {
      const s = await signUp({ country });
      await login(s, device(newId()));
      const bad = await api().post('/api/auth/login').set(device(newId())).send({ identifier: s.email, password: 'WrongPass999' });
      expect(bad.status).toBe(401);
      expect(await Otp.exists({ email: s.email, purpose: 'new_device' })).toBeNull();
      const forged = await verify(device(newId()), { challenge: 'x'.repeat(40), code: '123456' });
      expect(forged.body.code).toBe('CHALLENGE_EXPIRED');
    });

    test('resend gives a new code', async () => {
      const s = await signUp({ country });
      await login(s, device(newId()));
      const B = newId();
      const r = await login(s, device(B));
      await Otp.updateOne({ email: s.email, purpose: 'new_device' }, { $set: { updatedAt: new Date(Date.now() - 120000) } }, { timestamps: false });
      const again = await api().post('/api/auth/login/resend-device-code').set(device(B)).send({ challenge: r.body.data.challenge });
      expect(again.status).toBe(200);
      expect(again.body.data.devCode).toMatch(/^\d{6}$/);
      expect((await verify(device(B), { challenge: r.body.data.challenge, code: again.body.data.devCode })).body.data.token).toBeTruthy();
    });
  });
}

test('switched off: a new device logs straight in (the alert still goes out)', async () => {
  const { updateSettings } = require('../src/services/settings');
  const { AdminAlert } = require('../src/models');
  await updateSettings({ deviceCheck: { enabled: false } });
  try {
    const s = await signUp({ country: 'NG' });
    await login(s, device(newId()));
    const r = await login(s, device(newId()));
    expect(r.body.data.token).toBeTruthy();
    expect(await AdminAlert.exists({ user: s.user.id, type: 'new_device' })).toBeTruthy();
    // An app without a device id isn't blocked either.
    expect((await api().post('/api/auth/login').send({ identifier: s.email, password: s.password })).body.data.token).toBeTruthy();
  } finally {
    await updateSettings({ deviceCheck: { enabled: true } });
  }
});
