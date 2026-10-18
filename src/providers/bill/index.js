// Picks the bill-payment provider from BILL_PROVIDER.
//
// Every provider exposes the same functions (see none.js for the full
// list). Amounts are in kobo. To add VTpass (or another provider), create
// vtpass.js with these functions and add it below.
const env = require('../../config/env');

const providers = {
  none: () => require('./none'),
  simulator: () => require('./simulator'),
};

let current = null;

function billProvider() {
  if (!current) {
    const make = providers[env.billProvider];
    if (!make) throw new Error(`Unknown BILL_PROVIDER "${env.billProvider}"`);
    current = make();
  }
  return current;
}

/** For tests: swap the provider. */
function setBillProvider(p) {
  current = p;
}

module.exports = { billProvider, setBillProvider };
