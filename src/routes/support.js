// Aminata, the AI customer support (see src/services/aminata.js).
//   GET  /api/support/status → { available }
//   POST /api/support/chat   { messages: [{ role, content }] } → { reply, tools, actions }
const express = require('express');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const { requireAuth } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const { asyncHandler, ok } = require('../utils/helpers');
const aminata = require('../services/aminata');
const assistant = require('../services/assistant');

const router = express.Router();
router.use(requireAuth);

router.get('/status', (req, res) => ok(res, { available: Boolean(env.anthropic.apiKey), name: 'Aminata' }));

// Each answer costs money at Anthropic: per-customer ceilings.
const limit = (windowMs, max, message) =>
  rateLimit({
    windowMs,
    limit: env.isTest ? 10_000 : max,
    keyGenerator: (req) => String(req.user._id),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, code: 'RATE_LIMITED', message },
  });
const perMinute = limit(60 * 1000, 12, 'You are sending messages very fast. Please wait a minute.');
const perDay = limit(24 * 60 * 60 * 1000, 150, "You've reached today's chat limit. Please contact us on WhatsApp for more help.");

const message = z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(2000) });

router.post(
  '/chat',
  perMinute,
  perDay,
  validate({
    body: z.object({
      messages: z.array(message).min(1).max(30).refine((m) => m[m.length - 1].role === 'user', 'The last message must be from you.'),
    }),
  }),
  asyncHandler(async (req, res) => {
    try {
      const out = await aminata.ask({ messages: req.body.messages, user: req.user, call: assistant.callAs(req, '/api/') });
      ok(res, { reply: out.reply, tools: out.tools.map((t) => t.name), actions: out.actions });
    } catch (e) {
      if (e instanceof assistant.AssistantError) {
        const msg = e.code === 'AI_NOT_CONFIGURED' ? 'Aminata is not available right now. Please contact us on WhatsApp.' : e.message;
        return res.status(e.status).json({ success: false, code: e.code, message: msg });
      }
      throw e;
    }
  }),
);

module.exports = router;
