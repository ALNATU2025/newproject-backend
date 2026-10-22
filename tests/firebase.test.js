// Sign-up with an SMS code through Firebase Phone Auth.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { api, useDatabase } = require('./helpers');
const env = require('../src/config/env');
const { setCertFetcher } = require('../src/services/firebase');

useDatabase('firebase');

const PROJECT = 'dalabapay-test';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** An ID token like Firebase issues after the SMS code is entered. */
function firebaseToken(phone, { project = PROJECT, key = privateKey, kid = 'k1' } = {}) {
  return jwt.sign(
    { phone_number: phone, auth_time: Math.floor(Date.now() / 1000), firebase: { sign_in_provider: 'phone' } },
    key,
    { algorithm: 'RS256', keyid: kid, audience: project, issuer: `https://securetoken.google.com/${project}`, subject: 'uid123', expiresIn: '1h' },
  );
}

beforeAll(() => {
  env.firebase.projectId = PROJECT;
  env.signupVerification = 'sms';
  setCertFetcher(async () => ({
    ok: true,
    headers: { get: () => 'public, max-age=600' },
    json: async () => ({ k1: publicKey }),
  }));
});
afterAll(() => {
  env.firebase.projectId = '';
  env.signupVerification = 'email';
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

test('Sierra Leone numbers use +232', async () => {
  const r = await api().post('/api/auth/register').send(details(3, { phone: '076123403', country: 'SL' }));
  expect(r.body.data.phoneE164).toBe('+23276123403');
  const v = await api().post('/api/auth/register/verify-phone')
    .send({ email: 'sms3@example.com', idToken: firebaseToken('+23276123403') });
  expect(v.status).toBe(201);
  expect(v.body.data.user.country).toBe('SL');
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
