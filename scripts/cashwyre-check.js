// Read-only Cashwyre check — spends nothing. Uses the CASHWYRE_* settings.
//   npm run cashwyre-check
// Prints every country you can send to, with its banks and mobile money
// providers, and the dollar rates.
const env = require('../src/config/env');
const cashwyre = require('../src/providers/cashwyre');

async function main() {
  console.log(`Cashwyre · keys ${cashwyre.configured() ? 'set' : 'MISSING'} · webhook token ${env.cashwyre.webhookToken ? 'set' : 'MISSING'}`);
  if (!cashwyre.configured()) process.exit(1);
  const countries = (await cashwyre.countries()).filter((c) => c.canPayout);
  console.log(`\n${countries.length} payout countries:\n`);
  for (const c of countries) {
    const [banks, wallets] = await Promise.all([
      cashwyre.banks(c.code, 'bank').catch(() => []),
      cashwyre.banks(c.code, 'wallet').catch(() => []),
    ]);
    console.log(`${c.code} ${c.name} (${c.currencies.join('/')}): ${banks.length} banks · mobile money: ${wallets.length ? wallets.map((w) => w.name).join(', ') : 'none'}`);
  }
  const rates = await cashwyre.fxRates();
  console.log('\nDollar rates ($1 =):', Object.entries(rates).map(([k, v]) => `${k} buy ${v.buy} / sell ${v.sell}`).join(' · '));
}

main().catch((e) => {
  console.error('Check failed:', e.message);
  process.exit(1);
});
