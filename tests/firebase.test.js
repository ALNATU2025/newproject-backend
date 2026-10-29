// Sign-up with an SMS code through Firebase Phone Auth.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { api, useDatabase } = require('./helpers');
const env = require('../src/config/env');
const { setCertFetcher } = require('../src/services/firebase');

useDatabase('firebase');
// The new-device code is off by default; these tests check it switched on.
beforeAll(() => require('../src/services/settings').updateSettings({ deviceCheck: { enabled: true } }));

const PROJECT = 'dalabapay-test';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** An ID token like Firebase issues after the SMS code is entered. */
function firebaseToken(phone, { project = PROJECT, key = privateKey, kid = 'k1', email, emailVerified } = {}) {
  const claims = email
    ? { email, email_verified: emailVerified, firebase: { sign_in_provider: 'password' } }
    : { phone_number: phone, firebase: { sign_in_provider: 'phone' } };
  return jwt.sign(
    { ...claims, auth_time: Math.floor(Date.now() / 1000) },
    key,
    { algorithm: 'RS256', keyid: kid, audience: project, issuer: `https://securetoken.google.com/${project}`, subject: 'uid123', expiresIn: '1h' },
  );
}

beforeAll(() => {
  env.firebase.projectId = PROJECT;
  env.signupVerification = 'sms';
  env.slSignupVerification = 'email_link';
  setCertFetcher(async () => ({
    ok: true,
    headers: { get: () => 'public, max-age=600' },
    json: async () => ({ k1: publicKey }),
  }));
});
afterAll(() => {
  env.firebase.projectId = '';
  env.signupVerification = 'email';
  env.slSignupVerification = 'email';
});

const details = (n, extra = {}) => ({
  fullName: `Sms User${n}`,
  email: `sms${n}@example.com`,
  phone: `0803000000${n}`,
  password: 'Passw0rdOk',
  ...extra,
});

test('register asks for an SMS code instead of emailing one', async () => {
  const r = await api().post('/api/auth/register').send(details(1));
  expect(r.status).toBe(200);
  expect(r.body.data.verification).toBe('sms');
  expect(r.body.data.phoneE164).toBe('+2348030000001');
  expect(r.body.data.devCode).toBeUndefined();
});

test('a valid Firebase token for the same phone creates the account', async () => {
  await api().post('/api/auth/register').send(details(2));
  const v = await api().post('/api/auth/register/verify-phone')
    .send({ email: 'sms2@example.com', idToken: firebaseToken('+2348030000002') });
  expect(v.status).toBe(201);
  expect(v.body.data.token).toBeTruthy();
  expect(v.body.data.user.phone).toBe('08030000002');
});

test('Sierra Leone numbers use +232 (when SL is set to SMS)', async () => {
  env.slSignupVerification = 'sms';
  const r = await api().post('/api/auth/register').send(details(3, { phone: '076123403', country: 'SL' }));
  expect(r.body.data.phoneE164).toBe('+23276123403');
  const v = await api().post('/api/auth/register/verify-phone')
    .send({ email: 'sms3@example.com', idToken: firebaseToken('+23276123403') });
  expect(v.status).toBe(201);
  expect(v.body.data.user.country).toBe('SL');
  env.slSignupVerification = 'email_link';
});

describe('Sierra Leone: Firebase email link', () => {
  const sl = (n) => details(n, { phone: `07712340${n}`, country: 'SL', email: `link${n}@example.com` });

  test('register asks for the email link; Nigeria still gets SMS', async () => {
    const r = await api().post('/api/auth/register').send(sl(6));
    expect(r.body.data.verification).toBe('email_link');
    const ng = await api().post('/api/auth/register').send(details(7));
    expect(ng.body.data.verification).toBe('sms');
  });

  test('verified email token creates the account', async () => {
    await api().post('/api/auth/register').send(sl(8));
    const notYet = await api().post('/api/auth/register/verify-email-link')
      .send({ email: 'link8@example.com', idToken: firebaseToken(null, { email: 'link8@example.com', emailVerified: false }) });
    expect(notYet.body.code).toBe('EMAIL_NOT_VERIFIED');
    const other = await api().post('/api/auth/register/verify-email-link')
      .send({ email: 'link8@example.com', idToken: firebaseToken(null, { email: 'someone@example.com', emailVerified: true }) });
    expect(other.body.code).toBe('EMAIL_MISMATCH');
    const v = await api().post('/api/auth/register/verify-email-link')
      .send({ email: 'link8@example.com', idToken: firebaseToken(null, { email: 'Link8@example.com', emailVerified: true }) });
    expect(v.status).toBe(201);
    expect(v.body.data.user.country).toBe('SL');
    expect(v.body.data.user.emailVerified).toBe(true);
  });
});

test('wrong phone, wrong project or forged token are refused', async () => {
  await api().post('/api/auth/register').send(details(4));
  const other = await api().post('/api/auth/register/verify-phone')
    .send({ email: 'sms4@example.com', idToken: firebaseToken('+2348099999999') });
  expect(other.body.code).toBe('PHONE_MISMATCH');
  const project = await api().post('/api/auth/register/verify-phone')
    .send({ email: 'sms4@example.com', idToken: firebaseToken('+2348030000004', { project: 'someone-else' }) });
  expect(project.body.code).toBe('INVALID_VERIFICATION');
  const { privateKey: fake } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const forged = await api().post('/api/auth/register/verify-phone')
    .send({ email: 'sms4@example.com', idToken: firebaseToken('+2348030000004', { key: fake }) });
  expect(forged.body.code).toBe('INVALID_VERIFICATION');
});

test('without a pending sign-up nothing is created', async () => {
  const v = await api().post('/api/auth/register/verify-phone')
    .send({ email: 'nobody@example.com', idToken: firebaseToken('+2348030000005') });
  expect(v.body.code).toBe('CODE_EXPIRED');
});

describe('choice: SMS or email, both through Firebase', () => {
  beforeAll(() => {
    env.signupVerification = 'firebase';
    env.slSignupVerification = 'firebase';
  });

  test('register offers both, for either country', async () => {
    const ng = await api().post('/api/auth/register').send(details(9));
    expect(ng.body.data).toEqual(expect.objectContaining({ verification: 'choose', options: ['sms', 'email_link'], phoneE164: '+2348030000009' }));
    const sl = await api().post('/api/auth/register').send(details(0, { phone: '073952700', country: 'SL', email: 'choice0@example.com' }));
    expect(sl.body.data.verification).toBe('choose');
  });

  test('either proof finishes the sign-up', async () => {
    await api().post('/api/auth/register').send(details(1, { phone: '08030000011', email: 'choice1@example.com' }));
    const bySms = await api().post('/api/auth/register/verify-phone')
      .send({ email: 'choice1@example.com', idToken: firebaseToken('+2348030000011') });
    expect(bySms.status).toBe(201);
    await api().post('/api/auth/register').send(details(2, { phone: '073952712', country: 'SL', email: 'choice2@example.com' }));
    const byEmail = await api().post('/api/auth/register/verify-email-link')
      .send({ email: 'choice2@example.com', idToken: firebaseToken(null, { email: 'choice2@example.com', emailVerified: true }) });
    expect(byEmail.status).toBe(201);
  });
});


describe('new device login: email code in both countries', () => {
  const dev = (id) => ({ 'X-Device-Id': id, 'X-Device-Name': 'Tecno', 'X-Device-Platform': 'android' });
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);

  test('Sierra Leone accounts get an email code too', async () => {
    env.slSignupVerification = 'sms';
    const phone = '076123461';
    await api().post('/api/auth/register').set(dev(A)).send(details(61, { phone, country: 'SL', email: 'slsms61@example.com' }));
    const v = await api().post('/api/auth/register/verify-phone').set(dev(A))
      .send({ email: 'slsms61@example.com', idToken: firebaseToken(`+232${phone.slice(1)}`) });
    expect(v.status).toBe(201);
    const r = await api().post('/api/auth/login').set(dev(B)).send({ identifier: 'slsms61@example.com', password: 'Passw0rdOk' });
    expect(r.body.data).toEqual(expect.objectContaining({ verification: 'device', method: 'email' }));
    expect(r.body.data.phoneE164).toBeUndefined();
    const ok = await api().post('/api/auth/login/verify-device').set(dev(B)).send({ challenge: r.body.data.challenge, code: r.body.data.devCode });
    expect(ok.body.data.token).toBeTruthy();
  });
});
