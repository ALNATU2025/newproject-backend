// Phone numbers are stored in local format:
//   Nigeria       0XXXXXXXXXX  (11 digits, e.g. 08031234567)
//   Sierra Leone  0XXXXXXXX    (9 digits,  e.g. 076123456)
// International forms (+234…, +232…) are accepted and converted.

const NG = /^0[789][01]\d{8}$/;
const SL = /^0[2-9]\d{7}$/;

function digits(raw) {
  return String(raw || '').replace(/[\s\-().]/g, '').replace(/^\+/, '');
}

/** Local Sierra Leone form, or the input unchanged when it can't be. */
function toSlLocal(raw) {
  const d = digits(raw);
  if (/^232\d{8}$/.test(d)) return `0${d.slice(3)}`;
  if (/^\d{8}$/.test(d)) return `0${d}`;
  return d;
}

/** Local Nigerian form, or the input unchanged when it can't be. */
function toNgLocal(raw) {
  const d = digits(raw);
  if (/^234\d{10}$/.test(d)) return `0${d.slice(3)}`;
  if (/^[789][01]\d{8}$/.test(d)) return `0${d}`;
  return d;
}

/** Local form for [country], or null when it isn't a valid number there. */
function normalizePhone(raw, country) {
  if (country === 'SL') {
    const v = toSlLocal(raw);
    return SL.test(v) ? v : null;
  }
  const v = toNgLocal(raw);
  return NG.test(v) ? v : null;
}

/** For login/search: whatever the country, the stored local form. */
function anyLocal(raw) {
  return normalizePhone(raw, 'NG') || normalizePhone(raw, 'SL') || digits(raw);
}

const PHONE_HINT = {
  NG: 'Enter a valid 11-digit Nigerian phone number',
  SL: 'Enter a valid Sierra Leone phone number (e.g. 076 123 456)',
};

module.exports = { normalizePhone, anyLocal, PHONE_HINT, NG_PHONE: NG, SL_PHONE: SL };

/** International form for Firebase/SMS: "08031234567" → "+2348031234567". */
function toE164(local, country) {
  const d = String(local || '').replace(/^0/, '');
  return country === 'SL' ? `+232${d}` : `+234${d}`;
}

module.exports.toE164 = toE164;
