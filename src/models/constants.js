// Shared enums so models, routes and the app agree on names.

const ROLES = ['user', 'support', 'finance', 'admin', 'super'];

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
];

const BILL_SERVICES = SERVICES.filter((s) => s !== 'transfer');

const SERVICE_LABELS = {
  airtime: 'Airtime',
  data: 'Data',
  electricity: 'Electricity',
  cable: 'Cable TV',
  education: 'Education',
  insurance: 'Insurance',
  international: 'International Airtime',
  transfer: 'Money Transfer',
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
];

const TXN_STATUSES = ['pending', 'success', 'failed', 'refunded', 'disputed'];

const NOTIFICATION_KINDS = ['payment', 'wallet', 'promo', 'security', 'general', 'commission', 'referral'];

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
  SERVICES,
  BILL_SERVICES,
  SERVICE_LABELS,
  TXN_TYPES,
  TXN_STATUSES,
  NOTIFICATION_KINDS,
  DISPUTE_TYPES,
  ALERT_TYPES,
};
