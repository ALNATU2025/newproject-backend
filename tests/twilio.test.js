// Sign-up SMS codes through Twilio Verify, with the Firebase email link as
// a backup.
const { api, useDatabase } = require('./helpers');
const env = require('../src/config/env');
const twilio = require('../src/services/twilioVerify');

useDatabase('twilio');

const calls = [];
let blockSms = false;
const CODE = '482916';

beforeAll(() => {
  Object.assign(env.twilio, { accountSid: 'ACtest', authToken: 'secret', verifyServiceSid: 'VAtest' });
  env.signupVerification = 'twilio';
  env.slSignupVerification = 'twilio';
  env.firebase.projectId = 'dalabapay-test';
  twilio.setFetch(async (url, opts) => {
    const form = Object.fromEntries(new URLSearchParams(opts.body));
    calls.push({ url, form, auth: opts.headers.Authorization });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url.endsWith('/Verifications')) {
      if (blockSms) return json(400, { code: 60605, message: 'Geo permission' });
      return json(201, { status: 'pending', to: form.To });
    }
    if (url.endsWith('/VerificationCheck')) {
      return json(200, { status: form.Code === CODE ? 'approved' : 'pending' });
    }
    return json(404, { code: 20404 });
  });
});
afterAll(() => {
  Object.assign(env.twilio, { accountSid: '', authToken: '', verifyServiceSid: '' });
  env.signupVerification = 'email';
  env.slSignupVerification = 'email';
  env.firebase.projectId = '';
});
beforeEach(() => {
  calls.length = 0;
  blockSms = false;
});

const details = (n, extra = {}) => ({
  fullName: `Twilio User${n}`,
  email: `tw${n}@example.com`,
  phone: `0805000000${n}`,
  password: 'Passw0rdOk',
  ...extra,
});

test('Nigeria: code texted through Twilio and checked by the server', async () => {
  const r = await api().post('/api/auth/register').send(details(1));
  expect(r.body.data).toEqual(expect.objectContaining({ verification: 'sms_code', phoneE164: '+2348050000001', emailBackup: true }));
  expect(calls[0].url).toBe('https://verify.twilio.com/v2/Services/VAtest/Verifications');
  expect(calls[0].form).toEqual({ To: '+2348050000001', Channel: 'sms' });
  expect(calls[0].auth).toBe(`Basic ${Buffer.from('ACtest:secret').toString('base64')}`);

  const wrong = await api().post('/api/auth/register/verify-sms').send({ email: 'tw1@example.com', code: '111111' });
  expect(wrong.body.code).toBe('CODE_INVALID');
  const v = await api().post('/api/auth/register/verify-sms').send({ email: 'tw1@example.com', code: CODE });
  expect(v.status).toBe(201);
  expect(v.body.data.user.phone).toBe('08050000001');
});

test('Sierra Leone: same flow with +232', async () => {
  const r = await api().post('/api/auth/register').send(details(2, { phone: '073952752', country: 'SL' }));
  expect(r.body.data.phoneE164).toBe('+23273952752');
  const v = await api().post('/api/auth/register/verify-sms').send({ email: 'tw2@example.com', code: CODE });
  expect(v.status).toBe(201);
  expect(v.body.data.user.country).toBe('SL');
});

test('resend asks Twilio for a new code', async () => {
  await api().post('/api/auth/register').send(details(3));
  const r = await api().post('/api/auth/register/resend').send({ email: 'tw3@example.com' });
  expect(r.body.data.verification).toBe('sms_code');
  expect(calls.filter((c) => c.url.endsWith('/Verifications'))).toHaveLength(2);
});

test('SMS blocked: sign-up continues and offers the email link', async () => {
  blockSms = true;
  const r = await api().post('/api/auth/register').send(details(4, { phone: '076555004', country: 'SL' }));
  expect(r.status).toBe(200);
  expect(r.body.data.smsError).toMatch(/email/);
  const sw = await api().post('/api/auth/register/use-email').send({ email: 'tw4@example.com' });
  expect(sw.body.data.verification).toBe('email_link');
});
