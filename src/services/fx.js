// Dollar exchange rates from Cashwyre ($1 in each currency), cached for
// ten minutes. "sell" is what $1 costs (used when a customer pays for
// dollars); "buy" is what $1 is worth (used when dollars come back).
const env = require('../config/env');
const cashwyre = require('../providers/cashwyre');
const { unavailable } = require('../utils/errors');

const TTL_MS = 10 * 60 * 1000;
let cache = null;
let cachedAt = 0;

async function rates() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  try {
    cache = await cashwyre.fxRates();
    cachedAt = Date.now();
  } catch (e) {
    if (!cache) cache = {};
  }
  return cache;
}

/** Units of [currency] per $1. Throws FX_UNAVAILABLE when unknown. */
async function usdRate(currency, side = 'sell') {
  const c = String(currency || '').toUpperCase();
  if (c === 'USD') return 1;
  const r = (await rates())[c];
  const v = r ? (side === 'buy' ? r.buy || r.sell : r.sell || r.buy) : 0;
  if (v > 0) return v;
  const fallback = env.cashwyre.fxFallback[c];
  if (fallback > 0) return fallback;
  throw unavailable(`We can't get the dollar rate for ${c} right now. Please try again later.`, 'FX_UNAVAILABLE');
}

function clearFxCache() {
  cache = null;
  cachedAt = 0;
}

module.exports = { usdRate, clearFxCache };
