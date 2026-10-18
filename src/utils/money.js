// Money is stored in kobo (integer) and sent to the app in naira (number).

/** ₦ → kobo, rounded to the nearest kobo. */
function toKobo(naira) {
  const n = Number(naira);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/** kobo → ₦ with two decimals. */
function toNaira(kobo) {
  if (kobo === null || kobo === undefined) return null;
  return Math.round(Number(kobo)) / 100;
}

/** Percentage of an amount in kobo, rounded down to whole kobo. */
function percentOf(kobo, percent) {
  return Math.floor((Number(kobo) * Number(percent || 0)) / 100);
}

module.exports = { toKobo, toNaira, percentOf };
