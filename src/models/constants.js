// Shared enums so models, routes and the app agree on names.

const ROLES = ['user', 'support', 'finance', 'admin', 'super'];

/**
 * Countries the app serves. Each account belongs to one country and only
 * sees that country's services, in its currency. Money is stored in the
 * currency's minor unit (kobo for NGN, cents for SLE).
 */
const COUNTRIES = {
  NG: { code: 'NG', name: 'Nigeria', currency: 'NGN', symbol: '₦', dialCode: '+234', flag: '🇳🇬' },
  SL: { code: 'SL', name: 'Sierra Leone', currency: 'SLE', symbol: 'Le', dialCode: '+232', flag: '🇸🇱' },
};
const COUNTRY_CODES = Object.keys(COUNTRIES);
const CURRENCIES = { NGN: COUNTRIES.NG, SLE: COUNTRIES.SL };

/** Sierra Leone services (bill payments) and their wallet transfer key. */
const SL_SERVICES = ['sl_airtime', 'sl_data', 'sl_electricity', 'sl_cable'];

/** Bill-payment services plus wallet transfer (used for limits/toggles). */
const SERVICES = [
  'airtime',
  'data',
  'electricity',
  'cable',
  'education',
  'insurance',
  'international',
  'transfer',
  ...SL_SERVICES,
  'sl_transfer',
  // Cashwyre (Sierra Leone only): transfers to banks / mobile money, also
  // in other countries, and virtual dollar cards.
  'sl_payout',
  'sl_card',
];

const TRANSFER_SERVICES = ['transfer', 'sl_transfer'];
const CASHWYRE_SERVICES = ['sl_payout', 'sl_card'];
const BILL_SERVICES = SERVICES.filter((s) => !TRANSFER_SERVICES.includes(s) && !CASHWYRE_SERVICES.includes(s));

/** Transaction types for dollar cards. */
const CARD_TXN_TYPES = ['card_create', 'card_topup', 'card_withdrawal'];

/** Which country a service belongs to. */
const countryOfService = (service) => (String(service || '').startsWith('sl_') ? 'SL' : 'NG');

/** The services a country's users can use (bills + transfer). */
const servicesFor = (country) => SERVICES.filter((s) => countryOfService(s) === country);

const SERVICE_LABELS = {
  airtime: 'Airtime',
  data: 'Data',
  electricity: 'Electricity',
  cable: 'Cable TV',
  education: 'Education',
  insurance: 'Insurance',
  international: 'International Airtime',
  transfer: 'Money Transfer',
  sl_airtime: 'Airtime (Sierra Leone)',
  sl_data: 'Data (Sierra Leone)',
  sl_electricity: 'EDSA Electricity',
  sl_cable: 'Cable TV (Sierra Leone)',
  sl_transfer: 'Money Transfer (Sierra Leone)',
  sl_payout: 'Bank & Mobile Money Transfer (Sierra Leone)',
  sl_card: 'Dollar Card (Sierra Leone)',
};

const TXN_TYPES = [
  ...BILL_SERVICES, // purchases
  'transfer_out',
  'transfer_in',
  'wallet_funding',
  'commission', // earned (commission wallet)
  'commission_withdrawal', // moved from commission to main wallet
  'referral_bonus', // commission wallet
  'refund',
  'admin_credit',
  'admin_debit',
  'payout', // bank / mobile money transfer through Cashwyre
  ...CARD_TXN_TYPES,
];

const TXN_STATUSES = ['pending', 'success', 'failed', 'refunded', 'disputed'];

const NOTIFICATION_KINDS = ['payment', 'wallet', 'promo', 'security', 'general', 'commission', 'referral', 'card'];

const DISPUTE_TYPES = [
  'service_not_delivered',
  'incorrect_amount',
  'failed_transaction',
  'pending_transaction',
  'refund_request',
  'other',
];

const ALERT_TYPES = ['new_user', 'wallet', 'duplicate', 'suspicious', 'status', 'dispute', 'provider'];

module.exports = {
  ROLES,
  COUNTRIES,
  COUNTRY_CODES,
  CURRENCIES,
  SL_SERVICES,
  TRANSFER_SERVICES,
  CASHWYRE_SERVICES,
  CARD_TXN_TYPES,
  countryOfService,
  servicesFor,
  SERVICES,
  BILL_SERVICES,
  SERVICE_LABELS,
  TXN_TYPES,
  TXN_STATUSES,
  NOTIFICATION_KINDS,
  DISPUTE_TYPES,
  ALERT_TYPES,
};
