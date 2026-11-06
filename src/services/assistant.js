// The AI engine shared by Hawa (admin assistant) and Aminata (customer
// support): sends a conversation to Claude (Anthropic API) with a set of
// tools, runs the tools Claude asks for, and returns the answer.
//
// A tool is { name, description, input_schema, permission?, and one of:
//   request(input) → { path, query }   a GET on this server (see `call`)
//   action(input)  → object            a button the app shows the person;
//                                       nothing runs until they tap it }
const env = require('../config/env');

let anthropicFetch = (...a) => fetch(...a);
/** Tests replace the Anthropic API with a fake. */
function setAnthropicFetch(fn) {
  anthropicFetch = fn || ((...a) => fetch(...a));
}

const MAX_RESULT = 14000; // characters of data per tool result
const OBJECT_ID = /^[a-f0-9]{24}$/i;

function needId(v, what) {
  if (!OBJECT_ID.test(String(v || ''))) throw new Error(`${what} must be an id from an earlier result (24 hex characters). Search first.`);
  return String(v);
}

class AssistantError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Drops pictures and other huge strings from tool data. */
function slim(value) {
  return JSON.stringify(value, (k, v) => {
    if (k === 'avatar' || k === 'photo' || k === 'files' || k === 'selfie') return undefined;
    if (typeof v === 'string' && v.length > 1500) return `${v.slice(0, 200)}…`;
    return v;
  });
}

async function claude(body, name) {
  let r;
  try {
    r = await anthropicFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.anthropic.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AssistantError(`${name} could not connect. Please try again.`, 'AI_UNAVAILABLE', 502);
  }
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = null;
  }
  if (!r.ok || !json) {
    const why = (json && json.error && json.error.message) || `HTTP ${r.status}`;
    console.error(`[${name}] Anthropic error:`, r.status, why);
    if (r.status === 401 || r.status === 403) throw new AssistantError(`${name} is not available right now (AI key refused).`, 'AI_KEY_REFUSED', 502);
    if (r.status === 429 || r.status === 529) throw new AssistantError(`${name} is very busy right now. Please try again in a minute.`, 'AI_BUSY', 503);
    throw new AssistantError(`${name} could not answer right now. Please try again.`, 'AI_UNAVAILABLE', 502);
  }
  return json;
}

/**
 * @param name        'Hawa' | 'Aminata' (for messages)
 * @param system      system prompt
 * @param tools       tool definitions (see top)
 * @param messages    [{ role: 'user'|'assistant', content: string }]
 * @param call        (path, query) => Promise<data>  GET on this server
 */
async function run({ name, system, tools, messages, call, maxSteps = 8, maxTokens = 1500 }) {
  if (!env.anthropic.apiKey) {
    throw new AssistantError(`${name} is not set up yet: add ANTHROPIC_API_KEY on Render.`, 'AI_NOT_CONFIGURED', 503);
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const used = [];
  const actions = [];

  for (let step = 0; step < maxSteps; step += 1) {
    const res = await claude(
      {
        model: env.anthropic.model,
        max_tokens: maxTokens,
        system,
        tools: tools.map(({ name: n, description, input_schema }) => ({ name: n, description, input_schema })),
        messages: convo,
      },
      name,
    );
    const blocks = Array.isArray(res.content) ? res.content : [];
    const calls = blocks.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) {
      const reply = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply: reply || 'Sorry, I could not find an answer to that.', tools: used, actions };
    }
    convo.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const c of calls) {
      const tool = byName[c.name];
      const input = c.input || {};
      used.push({ name: c.name, input });
      let content;
      let isError = false;
      try {
        if (!tool) throw new Error('You do not have access to that.');
        if (tool.action) {
          if (actions.length >= 3) throw new Error('Too many buttons already; answer now.');
          actions.push(await tool.action(input));
          content = 'Done: the button is now shown to the user under your message. Tell them briefly what it does; nothing happens until they tap it.';
        } else {
          const { path, query } = tool.request(input);
          content = slim(await call(path, query));
          if (content.length > MAX_RESULT) content = `${content.slice(0, MAX_RESULT)} …(cut: too long; search more narrowly)`;
        }
      } catch (e) {
        isError = true;
        content = e.message || 'Lookup failed.';
      }
      results.push({ type: 'tool_result', tool_use_id: c.id, content, ...(isError ? { is_error: true } : {}) });
    }
    convo.push({ role: 'user', content: results });
  }
  return { reply: 'That needed too many lookups. Please ask a narrower question.', tools: used, actions };
}

/** GET on this same server as the person asking (their login, their access). */
function callAs(req, prefix) {
  const base = `http://127.0.0.1:${req.socket.localPort}`;
  const headers = { accept: 'application/json', authorization: req.headers.authorization, 'x-ai-assistant': '1' };
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-') && !k.startsWith('x-forwarded') && typeof v === 'string') headers[k] = v;
  }
  return async (path, query = {}) => {
    if (!path.startsWith(prefix) || path.includes('..') || path.includes('//')) throw new Error('Not allowed.');
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    const r = await fetch(url, { method: 'GET', headers });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.success === false) throw new Error((body && body.message) || `Lookup failed (${r.status}).`);
    return body.data;
  };
}

module.exports = { run, callAs, needId, setAnthropicFetch, AssistantError, slim };
