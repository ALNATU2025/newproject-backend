// Read-only VTpass check — spends nothing. Uses the VTPASS_* settings.
//   npm run vtpass-check                    balance + bouquets + countries
//   npm run vtpass-check -- dstv 1234567890 also verifies a smartcard
const env = require('../src/config/env');
const { createVtpass } = require('../src/providers/bill/vtpass');

async function main() {
  const vt = createVtpass(env.vtpass);
  console.log(`VTpass ${env.vtpass.environment} · keys ${vt.isConfigured() ? 'set' : 'MISSING'}`);
  const h = await vt.health();
  console.log(`Health: ${h.ok ? 'OK' : 'FAILED'} — ${h.message}`);
  if (!h.ok) process.exit(1);
  for (const tv of ['dstv', 'gotv', 'startimes']) {
    const plans = await vt.cablePlans(tv);
    console.log(`${tv}: ${plans.length} packages, e.g. ${plans.slice(0, 2).map((p) => `${p.name} ₦${p.amount / 100}`).join(' · ')}`);
  }
  const countries = await vt.intlCountries();
  console.log(`International: ${countries.length} countries (${countries.slice(0, 5).map((c) => c.name).join(', ')}…)`);
  const [service, card] = process.argv.slice(2);
  if (service && card) {
    const v = await vt.verifySmartcard(service, card);
    console.log('Smartcard:', v);
  }
}

main().catch((e) => {
  console.error('Check failed:', e.message);
  process.exit(1);
});
