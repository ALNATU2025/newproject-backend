// Shapes database documents into the JSON the app reads. Money → naira.
const { toNaira } = require('./utils/money');
const { permissionsFor } = require('./permissions');

const id = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

function user(u, { admin = false } = {}) {
  if (!u) return null;
  const out = {
    id: id(u),
    fullName: u.fullName,
    email: u.email,
    phone: u.phone,
    role: u.role,
    isAdmin: u.role !== 'user',
    permissions: u.role === 'user' ? [] : permissionsFor(u.role),
    isActive: u.isActive,
    isApproved: u.isApproved,
    emailVerified: u.emailVerified,
    pinSet: Boolean(u.pinSet),
    pinLocked: Boolean(u.pinLockedUntil && new Date(u.pinLockedUntil) > new Date()),
    pinLockedUntil: u.pinLockedUntil || null,
    balance: toNaira(u.balance || 0),
    commissionBalance: toNaira(u.commissionBalance || 0),
    referralCode: u.referralCode || null,
    kyc: {
      status: (u.kyc && u.kyc.status) || 'none',
      idType: (u.kyc && u.kyc.idType) || null,
      submittedAt: (u.kyc && u.kyc.submittedAt) || null,
      verifiedAt: (u.kyc && u.kyc.verifiedAt) || null,
      rejectionReason: (u.kyc && u.kyc.rejectionReason) || null,
    },
    dedicatedAccount:
      u.dedicatedAccount && u.dedicatedAccount.accountNumber
        ? {
            accountNumber: u.dedicatedAccount.accountNumber,
            accountName: u.dedicatedAccount.accountName,
            bankName: u.dedicatedAccount.bankName,
          }
        : null,
    preferences: {
      biometricEnabled: Boolean(u.preferences && u.preferences.biometricEnabled),
      pushEnabled: !(u.preferences && u.preferences.pushEnabled === false),
    },
    createdAt: u.createdAt,
  };
  if (admin) {
    out.lifetimeCommission = toNaira(u.lifetimeCommission || 0);
    out.pinFailedAttempts = u.pinFailedAttempts || 0;
    out.lastLoginAt = u.lastLoginAt || null;
    out.referredBy = id(u.referredBy);
  }
  return out;
}

/** Small user summary embedded in admin lists. */
function userBrief(u) {
  if (!u || !u._id) return null;
  return { id: id(u), fullName: u.fullName, email: u.email, phone: u.phone };
}

function transaction(t, { admin = false } = {}) {
  if (!t) return null;
  const out = {
    id: id(t),
    reference: t.reference,
    type: t.type,
    wallet: t.wallet || 'main',
    direction: t.direction,
    isCredit: t.direction === 'credit',
    amount: toNaira(t.amount),
    fee: toNaira(t.fee || 0),
    commission: toNaira(t.commission || 0),
    status: t.status,
    description: t.description || '',
    service: t.service || null,
    recipient: t.recipient || null,
    providerReference: t.providerReference || null,
    metadata: publicMetadata(t.metadata),
    balanceBefore: toNaira(t.balanceBefore),
    balanceAfter: toNaira(t.balanceAfter),
    refunded: Boolean(t.refunded),
    adminNote: t.adminNote || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  if (admin) {
    out.user = userBrief(t.user);
    out.platformRevenue = toNaira(t.platformRevenue || 0);
    out.provider = t.provider || null;
    out.actor = userBrief(t.actor);
    out.counterparty = userBrief(t.counterparty);
  }
  return out;
}

/** Hides internal provider fields; keeps what a receipt needs. */
function publicMetadata(m) {
  if (!m || typeof m !== 'object') return {};
  const { providerRaw, ...rest } = m; // eslint-disable-line no-unused-vars
  return rest;
}

function notification(n) {
  return {
    id: id(n),
    title: n.title,
    body: n.body,
    kind: n.kind,
    read: n.read,
    data: n.data || {},
    createdAt: n.createdAt,
  };
}

function dispute(d, { admin = false } = {}) {
  const t = d.transaction && d.transaction._id ? d.transaction : null;
  const out = {
    id: id(d),
    type: d.type,
    reason: d.reason,
    description: d.description,
    status: d.status,
    resolution: d.resolution,
    refundAmount: toNaira(d.refundAmount || 0),
    resolvedAt: d.resolvedAt,
    createdAt: d.createdAt,
    transaction: t
      ? {
          id: id(t),
          reference: t.reference,
          description: t.description,
          amount: toNaira(t.amount),
          status: t.status,
          type: t.type,
          createdAt: t.createdAt,
        }
      : { id: id(d.transaction) },
  };
  if (admin) out.user = userBrief(d.user);
  return out;
}

function alert(a, viewerId) {
  return {
    id: id(a),
    type: a.type,
    severity: a.severity,
    title: a.title,
    body: a.body,
    user: userBrief(a.user),
    transactionId: id(a.transaction),
    read: Boolean(viewerId && (a.readBy || []).some((r) => String(r) === String(viewerId))),
    createdAt: a.createdAt,
  };
}

function limits(l) {
  return {
    perTxn: l && l.perTxn != null ? toNaira(l.perTxn) : null,
    daily: l && l.daily != null ? toNaira(l.daily) : null,
  };
}

module.exports = { id, user, userBrief, transaction, notification, dispute, alert, limits };
