// Money is stored in the currency's minor unit (kobo for ₦, cents for Le)
// as an integer, and sent to the app in major units (a number).
const { COUNTRIES, CURRENCIES, countryOfService } = require('../models/constants');

/** Major → minor unit (₦ → kobo, Le → cents), rounded. */
function toKobo(naira) {
  const n = Number(naira);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/** Minor → major unit with two decimals. */
function toNaira(kobo) {
  if (kobo === null || kobo === undefined) return null;
  return Math.round(Number(kobo)) / 100;
}

/** Percentage of an amount in minor units, rounded down. */
function percentOf(kobo, percent) {
  return Math.floor((Number(kobo) * Number(percent || 0)) / 100);
}

/** Currency code for a country code ("SL" → "SLE"); Nigeria by default. */
function currencyOf(country) {
  return (COUNTRIES[country] || COUNTRIES.NG).currency;
}

/** Currency for a service key ("sl_airtime" → "SLE"). */
function currencyOfService(service) {
  return currencyOf(countryOfService(service));
}

/** "₦1,500.00" / "Le 25.00" from minor units. */
function formatMoney(minor, currency = 'NGN') {
  const c = CURRENCIES[currency] || CURRENCIES.NGN;
  const v = (toNaira(minor) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return c.currency === 'NGN' ? `₦${v}` : `${c.symbol} ${v}`;
}

module.exports = { toKobo, toNaira, percentOf, currencyOf, currencyOfService, formatMoney };
