// Aminata, the AI customer support: Claude is faked; her lookups really run
// against the customer API as that customer; her buttons are only offers.
const { api, auth, useDatabase, readyUser } = require('./helpers');
const { Transaction, Dispute } = require('../src/models');
const env = require('../src/config/env');
const assistant = require('../src/services/assistant');

useDatabase('aminata');

const requests = [];
let script;
const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const text = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const use = (...calls) => ({ stop_reason: 'tool_use', content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `t${requests.length}_${i}`, name, input })) });
const results = (body) => {
  const m = body.messages[body.messages.length - 1];
  return Array.isArray(m.content) ? m.content.filter((c) => c.type === 'tool_result') : [];
};

beforeAll(() => {
  env.anthropic.apiKey = 'sk-ant-test';
  assistant.setAnthropicFetch(async (url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    return script(body, requests.length);
  });
});
afterAll(() => {
  env.anthropic.apiKey = '';
  assistant.setAnthropicFetch(null);
});
beforeEach(() => {
  requests.length = 0;
});

const chat = (token, q, history = []) => api().post('/api/support/chat').set(auth(token)).send({ messages: [...history, { role: 'user', content: q }] });

test('looks up the customer\'s own payment, explains it and offers to report it', async () => {
  const u = await readyUser({ fullName: 'Foday Sesay' });
  const t = await Transaction.create({
    user: u.user.id, reference: 'DP-TV-1001', type: 'cable', direction: 'debit', amount: 450000, status: 'success', recipient: '7023456789',
  });
  script = (body, n) => {
    if (n === 1) return reply(200, use(['my_transactions', { q: 'DP-TV-1001' }]));
    if (n === 2) {
      const items = JSON.parse(results(body)[0].content).items;
      return reply(200, use(['get_my_transaction', { transaction_id: items[0].id }]));
    }
    if (n === 3) {
      const tx = JSON.parse(results(body)[0].content);
      return reply(200, use(
        ['offer_report_problem', { transaction_id: tx.id, type: 'service_not_delivered', reason: 'TV not working after payment', description: 'Paid ₦4,500 GOtv, decoder still off.' }],
        ['offer_open_screen', { screen: 'my_tickets' }],
      ));
    }
    return reply(200, text(`Your payment ${results(body).length} was successful. Tap Submit report and our team will check it.`));
  };
  const r = await chat(u.token, 'I paid for TV (DP-TV-1001) but it is not working');
  expect(r.status).toBe(200);
  const d = r.body.data;
  expect(d.reply).toMatch(/Submit report/);
  expect(d.tools).toEqual(['my_transactions', 'get_my_transaction', 'offer_report_problem', 'offer_open_screen']);
  expect(d.actions).toEqual([
    expect.objectContaining({ type: 'report_problem', label: 'Submit report', transactionId: String(t._id), reference: 'DP-TV-1001', disputeType: 'service_not_delivered', reason: 'TV not working after payment' }),
    { type: 'open_screen', label: 'Open my reports', route: '/user-disputes' },
  ]);
  // An offer only: nothing was filed until the customer taps it.
  expect(await Dispute.countDocuments({ user: u.user.id })).toBe(0);
  // And the button's data works with the normal report endpoint.
  const a = d.actions[0];
  const filed = await api().post('/api/disputes').set(auth(u.token)).send({ transactionId: a.transactionId, type: a.disputeType, reason: a.reason, description: a.description });
  expect(filed.status).toBe(201);

  const sys = requests[0].system;
  expect(sys).toMatch(/Aminata/);
  expect(sys).toMatch(/chatting with Foday/);
  expect(sys).toMatch(/Naira/);
  expect(sys).toMatch(/NEVER ask for their password, PIN/);
  expect(requests[0].tools.map((x) => x.name)).not.toContain('search_users'); // no admin tools
});

test('never sees someone else\'s data; Sierra Leone screens; human hand-off', async () => {
  const other = await readyUser({ fullName: 'Someone Else' });
  const theirs = await Transaction.create({ user: other.user.id, reference: 'DP-OTHER-1', type: 'airtime', direction: 'debit', amount: 10000, status: 'success' });
  const sl = await readyUser({ country: 'SL', fullName: 'Aminata Kamara' });

  script = (body, n) => {
    if (n === 1) return reply(200, use(
      ['get_my_transaction', { transaction_id: String(theirs._id) }],
      ['offer_report_problem', { transaction_id: String(theirs._id), type: 'other', reason: 'not mine' }],
      ['offer_open_screen', { screen: 'add_money' }],
      ['offer_human_support', { summary: 'Customer asks about a payment that is not theirs.' }],
    ));
    return reply(200, text(JSON.stringify(results(body).map((x) => Boolean(x.is_error)))));
  };
  const r = await chat(sl.token, 'Show DP-OTHER-1 and how to add money');
  expect(r.status).toBe(200);
  expect(JSON.parse(r.body.data.reply)).toEqual([true, true, false, false]);
  expect(r.body.data.actions).toEqual([
    { type: 'open_screen', label: 'Add money', route: '/sl/add-money' },
    { type: 'contact_human', label: 'Chat with our team on WhatsApp', message: 'Customer asks about a payment that is not theirs.' },
  ]);
  expect(requests[0].system).toMatch(/Leones/);
  // The failed lookup did not leak the other person's record.
  expect(JSON.stringify(requests[1].messages)).not.toMatch(/DP-OTHER-1"/);
});

test('signed-in customers only; clear errors; Hawa still works on the shared engine', async () => {
  expect((await api().post('/api/support/chat').send({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(401);
  const u = await readyUser({ pending: true }); // not approved yet: can still get help
  script = () => reply(200, text('Hi! How can I help you today?'));
  const r = await chat(u.token, 'hi');
  expect(r.body.data).toEqual({ reply: 'Hi! How can I help you today?', tools: [], actions: [] });
  expect((await api().get('/api/support/status').set(auth(u.token))).body.data.available).toBe(true);

  script = () => reply(529, { error: { message: 'Overloaded' } });
  const busy = await chat(u.token, 'hello');
  expect(busy.status).toBe(503);
  expect(busy.body.code).toBe('AI_BUSY');
  expect(busy.body.message).toMatch(/Aminata is very busy/);

  env.anthropic.apiKey = '';
  const off = await chat(u.token, 'hello');
  expect(off.body.code).toBe('AI_NOT_CONFIGURED');
  env.anthropic.apiKey = 'sk-ant-test';
});
