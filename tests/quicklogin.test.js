// Profile photo; signing back in with the PIN or fingerprint after the
// session expires.
const { api, auth, useDatabase, readyUser } = require('./helpers');
const { QuickLogin, User } = require('../src/models');

useDatabase('quicklogin');

// 1x1 JPEG header + padding (only the type is checked).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');

describe('profile photo', () => {
  test('upload, shown in /api/me and /home, remove', async () => {
    const u = await readyUser({ country: 'SL' });
    const up = await api().put('/api/me/avatar').set(auth(u.token)).send({ image: `data:image/jpeg;base64,${JPEG}` });
    expect(up.status).toBe(200);
    expect(up.body.data.avatar).toBe(`data:image/jpeg;base64,${JPEG}`);
    const me = await api().get('/api/me').set(auth(u.token));
    expect(me.body.data).toEqual(expect.objectContaining({ hasAvatar: true, avatar: `data:image/jpeg;base64,${JPEG}` }));
    const home = await api().get('/api/me/home').set(auth(u.token));
    expect(home.body.data.user.avatar).toMatch(/^data:image\/jpeg/);

    const bad = await api().put('/api/me/avatar').set(auth(u.token)).send({ image: Buffer.alloc(300, 1).toString('base64') });
    expect(bad.body.code).toBe('INVALID_IMAGE');

    await api().delete('/api/me/avatar').set(auth(u.token));
    expect((await api().get('/api/me').set(auth(u.token))).body.data.avatar).toBeNull();
  });
});

describe('quick sign-in', () => {
  test('PIN with the device key; fingerprint key; password change disables it', async () => {
    const u = await readyUser();
    const enrol = await api().post('/api/auth/device/enroll').set(auth(u.token)).send({ deviceName: 'Tecno Spark', platform: 'android' });
    expect(enrol.status).toBe(200);
    const { deviceKey } = enrol.body.data;
    expect(deviceKey).toMatch(/^[a-f0-9]{64}$/);
    expect((await QuickLogin.findOne({ user: u.user.id })).keyHash).not.toBe(deviceKey); // only a hash is kept

    const wrong = await api().post('/api/auth/quick-login').send({ deviceKey, pin: '000000' });
    expect(wrong.body.code).toBe('PIN_INVALID');
    const good = await api().post('/api/auth/quick-login').send({ deviceKey, pin: u.pin });
    expect(good.status).toBe(200);
    expect(good.body.data.token).toBeTruthy();
    expect(good.body.data.user.id).toBe(u.user.id);

    const fake = await api().post('/api/auth/quick-login').send({ deviceKey: 'a'.repeat(64), pin: u.pin });
    expect(fake.body.code).toBe('DEVICE_REVOKED');

    // Fingerprint
    const noBio = await api().post('/api/auth/quick-login').send({ deviceKey, bioKey: 'b'.repeat(64) });
    expect(noBio.body.code).toBe('BIOMETRIC_INVALID');
    const bio = await api().post('/api/auth/device/biometric').set(auth(u.token)).send({ deviceKey, pin: u.pin });
    const { bioKey } = bio.body.data;
    const viaBio = await api().post('/api/auth/quick-login').send({ deviceKey, bioKey });
    expect(viaBio.status).toBe(200);

    // A second phone tells the owner.
    await api().post('/api/auth/device/enroll').set(auth(u.token)).send({ deviceName: 'Unknown phone' });
    const { Notification } = require('../src/models');
    expect(await Notification.exists({ user: u.user.id, title: 'New phone signed in' })).toBeTruthy();

    // Password change: old phone keys stop working.
    await User.updateOne({ _id: u.user.id }, { $inc: { tokenVersion: 1 } });
    const after = await api().post('/api/auth/quick-login').send({ deviceKey, pin: u.pin });
    expect(after.body.code).toBe('DEVICE_REVOKED');
  });
});
