// Confirm / Cancel links sent in the admin webhook message for a bank
// top-up ("Foday has sent ₦50,000"). Opening the link shows a page with
// one button (so link previews in Slack / WhatsApp can't act on it); the
// button does the action. Links are signed, tied to one top-up and one
// action, expire after 3 days, and work only while the top-up is pending.
const express = require('express');
const { Transaction } = require('../models');
const { asyncHandler } = require('../utils/helpers');
const bankFunding = require('../services/bankFunding');
const { fmt } = require('../services/limits');

const router = express.Router();

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(res, { title, body, button = null, tone = '#1F4FC1', status = 200 }) {
  res.status(status).set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Dalabapay · ${esc(title)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F4F6FB;color:#0B1B3F}
main{max-width:440px;margin:40px auto;padding:0 16px}.card{background:#fff;border-radius:20px;padding:24px;box-shadow:0 8px 30px rgba(11,27,63,.08)}
h1{font-size:20px;margin:0 0 10px}p{line-height:1.5;color:#3B4A6B;margin:8px 0}b{color:#0B1B3F}
button{width:100%;margin-top:18px;padding:15px;border:0;border-radius:14px;font-size:16px;font-weight:700;color:#fff;background:${tone};cursor:pointer}
.brand{font-weight:800;color:#1F4FC1;margin-bottom:14px}</style></head>
<body><main><div class="brand">Dalabapay Admin</div><div class="card"><h1>${esc(title)}</h1>${body}${button ? `<form method="post"><button type="submit">${esc(button)}</button></form>` : ''}</div></main></body></html>`);
}

async function load(token) {
  const p = bankFunding.readActionToken(token);
  const t = await Transaction.findOne({ _id: p.t, type: 'wallet_funding', 'metadata.method': bankFunding.METHOD }).populate('user', 'fullName phone email');
  if (!t || t.amount !== p.amt) return { p, t: null };
  return { p, t };
}

function details(t) {
  const a = (t.metadata && t.metadata.account) || {};
  return `<p><b>${esc(t.user ? t.user.fullName : 'Customer')}</b> (${esc(t.user ? t.user.phone || t.user.email : '')})</p>
<p>Amount: <b>${esc(fmt(t.amount, 'NGN'))}</b><br>To: ${esc(a.bankName)} ${esc(a.accountNumber)}<br>Ref: ${esc(t.reference)}</p>`;
}

const doneText = (t) => (t.status === 'success' ? 'This top-up was already confirmed and credited.' : 'This top-up was already cancelled.');

router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    let r;
    try {
      r = await load(req.params.token);
    } catch (e) {
      return page(res, { title: 'Link not valid', body: `<p>${esc(e.message)}</p>`, status: 400 });
    }
    const { p, t } = r;
    if (!t) return page(res, { title: 'Top-up not found', body: '<p>Use the admin app instead.</p>', status: 404 });
    if (t.status !== 'pending') return page(res, { title: 'Nothing to do', body: details(t) + `<p>${doneText(t)}</p>` });
    const confirm = p.a === 'confirm';
    return page(res, {
      title: confirm ? 'Confirm this top-up?' : 'Cancel this top-up?',
      body: details(t) + (confirm
        ? '<p>Only confirm after you have seen the money in the account. The wallet is credited immediately.</p>'
        : '<p>The customer will be told the payment was not confirmed. Nothing is credited.</p>'),
      button: confirm ? `Confirm and credit ${fmt(t.amount, 'NGN')}` : 'Cancel top-up',
      tone: confirm ? '#079A68' : '#C2413B',
    });
  }),
);

router.post(
  '/:token',
  asyncHandler(async (req, res) => {
    let r;
    try {
      r = await load(req.params.token);
    } catch (e) {
      return page(res, { title: 'Link not valid', body: `<p>${esc(e.message)}</p>`, status: 400 });
    }
    const { p, t } = r;
    if (!t) return page(res, { title: 'Top-up not found', body: '<p>Use the admin app instead.</p>', status: 404 });
    let out;
    try {
      out = await bankFunding.decide(t._id, p.a, { via: 'link', note: p.a === 'confirm' ? 'Confirmed from the admin webhook link' : 'Cancelled from the admin webhook link' });
    } catch (e) {
      return page(res, { title: 'Could not complete', body: details(t) + `<p>${esc(e.message)}</p>`, status: 400 });
    }
    const fresh = await Transaction.findById(t._id).populate('user', 'fullName phone email');
    if (out.result === 'already') return page(res, { title: 'Nothing to do', body: details(fresh) + `<p>${doneText(fresh)}</p>` });
    return page(res, {
      title: out.result === 'confirmed' ? 'Confirmed ✓' : 'Cancelled',
      body: details(fresh) + `<p>${out.result === 'confirmed' ? 'The wallet has been credited and the customer notified.' : 'The customer has been told.'}</p>`,
    });
  }),
);

module.exports = router;
