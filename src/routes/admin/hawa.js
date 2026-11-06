// Hawa, the admin AI assistant (see src/services/hawa.js).
//   GET  /api/admin/hawa/status  → { configured, model }
//   POST /api/admin/hawa/chat    { messages: [{ role, content }] } → { reply, tools }
const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../../config/env');
const { requirePermission } = require('../../middleware/auth');
const { validate, z } = require('../../middleware/validate');
const { asyncHandler, ok } = require('../../utils/helpers');
const { audit } = require('../../services/alerts');
const hawa = require('../../services/hawa');

const router = express.Router();

router.get('/status', requirePermission('dashboard:read'), (req, res) =>
  ok(res, { configured: Boolean(env.anthropic.apiKey), model: env.anthropic.model, tools: hawa.toolsFor(req.user.role).map((t) => t.name) }),
);

// Each question costs money at Anthropic: a per-admin ceiling.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.isTest ? 1000 : 20,
  keyGenerator: (req) => String(req.user._id),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many questions to Hawa. Please wait a minute.' },
});

/** GET on this same server, as the asking admin (their login, their permissions). */
function asAdmin(req) {
  const base = `http://127.0.0.1:${req.socket.localPort}`;
  const headers = { accept: 'application/json', authorization: req.headers.authorization, 'x-hawa': '1' };
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-') && !k.startsWith('x-forwarded') && typeof v === 'string') headers[k] = v;
  }
  return async (path, query = {}) => {
    if (!path.startsWith('/api/admin/') || path.includes('..')) throw new Error('Not allowed.');
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    const r = await fetch(url, { method: 'GET', headers });
    const body = await r.json().catch(() => null);
    if (!r.ok || !body || body.success === false) throw new Error((body && body.message) || `Lookup failed (${r.status}).`);
    return body.data;
  };
}

const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(4000) });

router.post(
  '/chat',
  requirePermission('dashboard:read'),
  limiter,
  validate({
    body: z.object({
      messages: z.array(message).min(1).max(30).refine((m) => m[m.length - 1].role === 'user', 'The last message must be the question.'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { messages } = req.body;
    const question = messages[messages.length - 1].content;
    try {
      const out = await hawa.ask({ messages, admin: { fullName: req.user.fullName, role: req.user.role }, call: asAdmin(req) });
      await audit(req.user._id, 'hawa.ask', { details: { question: question.slice(0, 300), tools: out.tools.map((t) => t.name) } });
      ok(res, out);
    } catch (e) {
      if (e instanceof hawa.HawaError) {
        return res.status(e.status).json({ success: false, code: e.code, message: e.message });
      }
      throw e;
    }
  }),
);

module.exports = router;
