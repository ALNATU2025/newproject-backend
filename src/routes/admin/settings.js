// Service switches, maintenance, provider status, commission and limits.
const express = require('express');
const { Transaction, User } = require('../../models');
const { SERVICES, BILL_SERVICES, SERVICE_LABELS } = require('../../models/constants');
const { requirePermission } = require('../../middleware/auth');
const { validate, z, fields } = require('../../middleware/validate');
const { asyncHandler, ok, periodStart, startOfLagosDay } = require('../../utils/helpers');
const { toKobo, toNaira } = require('../../utils/money');
const { notFound } = require('../../utils/errors');
const { billProvider } = require('../../providers/bill');
const { paymentProvider } = require('../../providers/payment');
const { getSettings, updateSettings } = require('../../services/settings');
const { effectiveLimits } = require('../../services/limits');
const { audit } = require('../../services/alerts');
const serialize = require('../../serializers');
const { readiness } = require('../../services/readiness');

const router = express.Router();

const nairaOrNull = (v) => (v === null || v === undefined ? null : toNaira(v));
const koboOrNull = (v) => (v === null || v === undefined || v === '' ? null : toKobo(v));

function publicSettings(s) {
  return {
    services: Object.fromEntries(SERVICES.map((k) => [k, s.services[k] !== false])),
    serviceLabels: SERVICE_LABELS,
    maintenance: Boolean(s.maintenance),
    maintenanceMessage: s.maintenanceMessage,
    requireApproval: Boolean(s.requireApproval),
    lowBalanceAlerts: Boolean(s.lowBalanceAlerts),
    lowBalanceThreshold: toNaira(s.lowBalanceThreshold),
    fundingFeePercent: s.fundingFeePercent,
    minFunding: toNaira(s.minFunding),
    maxFunding: toNaira(s.maxFunding),
    minCommissionWithdrawal: toNaira(s.minCommissionWithdrawal),
    referral: {
      bonus: toNaira(s.referral.bonus),
      indirectBonus: toNaira(s.referral.indirectBonus),
      minFirstDeposit: toNaira(s.referral.minFirstDeposit),
    },
    // Sierra Leone (Leones)
    slReferral: {
      bonus: toNaira(s.slReferral.bonus),
      indirectBonus: toNaira(s.slReferral.indirectBonus),
      minFirstDeposit: toNaira(s.slReferral.minFirstDeposit),
    },
    cashwyre: s.cashwyre,
    // Sierra Leone account levels (Leones; null = no limit)
    slTiers: Object.fromEntries(
      Object.entries(s.slTiers || {}).map(([t, v]) => [t, { daily: nairaOrNull(v.daily), maxBalance: nairaOrNull(v.maxBalance) }]),
    ),
    adminNotify: s.adminNotify,
    slFunding: {
      minAmount: toNaira(s.slFunding.minAmount),
      maxAmount: toNaira(s.slFunding.maxAmount),
      instructions: s.slFunding.instructions,
      methods: s.slFunding.methods,
    },
  };
}

router.get(
  '/settings',
  requirePermission('settings:read'),
  asyncHandler(async (req, res) => ok(res, publicSettings(await getSettings({ fresh: true })))),
);

router.patch(
  '/settings',
  requirePermission('settings:write'),
  validate({
    body: z.object({
      services: z.record(z.enum(SERVICES), z.boolean()).optional(),
      maintenance: z.boolean().optional(),
      maintenanceMessage: z.string().trim().min(3).max(300).optional(),
      requireApproval: z.boolean().optional(),
      lowBalanceAlerts: z.boolean().optional(),
      lowBalanceThreshold: z.coerce.number().min(0).optional(),
      fundingFeePercent: z.coerce.number().min(0).max(10).optional(),
      minFunding: z.coerce.number().min(0).optional(),
      maxFunding: z.coerce.number().min(0).optional(),
      minCommissionWithdrawal: z.coerce.number().min(0).optional(),
      referral: z
        .object({
          bonus: z.coerce.number().min(0).optional(),
          indirectBonus: z.coerce.number().min(0).optional(),
          minFirstDeposit: z.coerce.number().min(0).optional(),
        })
        .optional(),
      slReferral: z
        .object({
          bonus: z.coerce.number().min(0).optional(),
          indirectBonus: z.coerce.number().min(0).optional(),
          minFirstDeposit: z.coerce.number().min(0).optional(),
        })
        .optional(),
      slTiers: z
        .record(
          z.enum(['1', '2', '3', '4']),
          z.object({
            daily: z.coerce.number().min(0).nullable().optional(),
            maxBalance: z.coerce.number().min(0).nullable().optional(),
          }),
        )
        .optional(),
      adminNotify: z.object({ transactions: z.boolean().optional() }).optional(),
      cashwyre: z
        .object({
          payoutFeePercent: z.coerce.number().min(0).max(50).optional(),
          fxMarginPercent: z.coerce.number().min(0).max(50).optional(),
          cardFeePercent: z.coerce.number().min(0).max(50).optional(),
          cardWithdrawMarginPercent: z.coerce.number().min(0).max(50).optional(),
          minCardUsd: z.coerce.number().min(5).max(10_000).optional(),
          maxCardUsd: z.coerce.number().min(5).max(10_000).optional(),
          maxCardsPerUser: z.coerce.number().int().min(1).max(10).optional(),
        })
        .optional(),
      slFunding: z
        .object({
          minAmount: z.coerce.number().min(0).optional(),
          maxAmount: z.coerce.number().min(0).optional(),
          instructions: z.string().trim().max(500).optional(),
          methods: z
            .array(
              z.object({
                id: z.string().trim().min(1).max(30),
                name: z.string().trim().min(1).max(60),
                account: z.string().trim().max(60).default(''),
                accountName: z.string().trim().max(100).default(''),
                bankName: z.string().trim().max(100).optional(),
              }),
            )
            .max(8)
            .optional(),
        })
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const patch = {};
    for (const k of ['services', 'maintenance', 'maintenanceMessage', 'requireApproval', 'lowBalanceAlerts', 'fundingFeePercent']) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    for (const k of ['lowBalanceThreshold', 'minFunding', 'maxFunding', 'minCommissionWithdrawal']) {
      if (b[k] !== undefined) patch[k] = toKobo(b[k]);
    }
    for (const key of ['referral', 'slReferral']) {
      if (!b[key]) continue;
      patch[key] = {};
      for (const [k, v] of Object.entries(b[key])) if (v !== undefined) patch[key][k] = toKobo(v);
    }
    if (b.slTiers) {
      patch.slTiers = {};
      for (const [t, v] of Object.entries(b.slTiers)) {
        patch.slTiers[t] = {};
        if (v.daily !== undefined) patch.slTiers[t].daily = koboOrNull(v.daily);
        if (v.maxBalance !== undefined) patch.slTiers[t].maxBalance = koboOrNull(v.maxBalance);
      }
    }
    if (b.adminNotify) patch.adminNotify = b.adminNotify;
    if (b.cashwyre) {
      patch.cashwyre = Object.fromEntries(Object.entries(b.cashwyre).filter(([, v]) => v !== undefined));
    }
    if (b.slFunding) {
      patch.slFunding = {};
      const f = b.slFunding;
      if (f.minAmount !== undefined) patch.slFunding.minAmount = toKobo(f.minAmount);
      if (f.maxAmount !== undefined) patch.slFunding.maxAmount = toKobo(f.maxAmount);
      if (f.instructions !== undefined) patch.slFunding.instructions = f.instructions;
      if (f.methods !== undefined) patch.slFunding.methods = f.methods;
    }
    const s = await updateSettings(patch);
    await audit(req.user._id, 'settings.update', { details: b });
    ok(res, publicSettings(s));
  }),
);

// ── Go-live checklist ─────────────────────────────────────

router.get(
  '/readiness',
  requirePermission('settings:read'),
  asyncHandler(async (req, res) => ok(res, await readiness())),
);

// ── Provider ───────────────────────────────────────────────

router.get(
  '/provider',
  requirePermission('settings:read'),
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    const bp = billProvider();
    let balance = null;
    try {
      balance = await bp.balance();
    } catch {
      balance = null;
    }
    ok(res, {
      bill: {
        name: bp.name,
        environment: bp.environment,
        configured: bp.isConfigured(),
        // Which provider handles each service, e.g. cable → vtpass (live).
        services: bp.serviceMap ? bp.serviceMap() : {},
      },
      payment: { name: paymentProvider().name, configured: paymentProvider().isConfigured() },
      balance: nairaOrNull(balance),
      lowBalance: balance !== null && s.lowBalanceAlerts && balance < s.lowBalanceThreshold,
      lowBalanceThreshold: toNaira(s.lowBalanceThreshold),
    });
  }),
);

router.post(
  '/provider/health',
  requirePermission('provider:manage'),
  asyncHandler(async (req, res) => {
    const started = Date.now();
    const h = await billProvider().health();
    ok(res, { ...h, latencyMs: h.latencyMs ?? Date.now() - started, checkedAt: new Date() });
  }),
);

router.post(
  '/provider/test',
  requirePermission('provider:manage'),
  asyncHandler(async (req, res) => {
    const r = await billProvider().testCredentials();
    await audit(req.user._id, 'provider.test', { details: r });
    ok(res, { ...r, environment: billProvider().environment });
  }),
);

// ── Commission & revenue ───────────────────────────────────

router.get(
  '/commission',
  requirePermission('commission:read'),
  validate({ query: z.object({ period: z.enum(['today', 'week', 'month', 'year', 'all']).default('month') }) }),
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    const from = periodStart(req.query.period);
    const sevenStart = new Date(startOfLagosDay().getTime() - 6 * 86400000);
    const [perService, perDay] = await Promise.all([
      Transaction.aggregate([
        { $match: { type: { $in: BILL_SERVICES }, status: 'success', createdAt: { $gte: from } } },
        {
          $group: {
            _id: '$type',
            transactions: { $sum: 1 },
            volume: { $sum: '$amount' },
            revenue: { $sum: '$platformRevenue' },
            commission: { $sum: '$commission' },
          },
        },
      ]),
      Transaction.aggregate([
        { $match: { type: { $in: BILL_SERVICES }, status: 'success', createdAt: { $gte: sevenStart } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+01:00' } },
            revenue: { $sum: '$platformRevenue' },
          },
        },
      ]),
    ]);
    const by = Object.fromEntries(perService.map((r) => [r._id, r]));
    const services = BILL_SERVICES.map((k) => {
      const r = by[k] || { transactions: 0, volume: 0, revenue: 0, commission: 0 };
      const rate = s.commissionRates[k] || { user: 0, platform: 0 };
      return {
        service: k,
        label: SERVICE_LABELS[k],
        rate: { user: rate.user, platform: rate.platform },
        transactions: r.transactions,
        volume: toNaira(r.volume),
        revenue: toNaira(r.revenue),
        commission: toNaira(r.commission),
      };
    });
    const total = (f) => perService.reduce((a, r) => a + r[f], 0);
    const txns = total('transactions');
    const dayMap = Object.fromEntries(perDay.map((d) => [d._id, d.revenue]));
    ok(res, {
      period: req.query.period,
      revenue: toNaira(total('revenue')),
      commissionPaid: toNaira(total('commission')),
      volume: toNaira(total('volume')),
      transactions: txns,
      avgRevenuePerTxn: txns ? toNaira(Math.round(total('revenue') / txns)) : 0,
      revenue7d: Array.from({ length: 7 }, (_, i) => {
        const key = new Date(sevenStart.getTime() + i * 86400000 + 3600000).toISOString().slice(0, 10);
        return { date: key, value: toNaira(dayMap[key] || 0) };
      }),
      services,
    });
  }),
);

router.patch(
  '/commission/rates/:service',
  requirePermission('commission:write'),
  validate({
    params: z.object({ service: z.enum(BILL_SERVICES) }),
    body: z.object({ user: z.coerce.number().min(0).max(20), platform: z.coerce.number().min(0).max(20) }),
  }),
  asyncHandler(async (req, res) => {
    const { service } = req.params;
    const s = await updateSettings({ commissionRates: { [service]: req.body } });
    await audit(req.user._id, 'commission.rates', { details: { service, ...req.body } });
    ok(res, { service, rate: s.commissionRates[service] });
  }),
);

// ── Limits ─────────────────────────────────────────────────

const limitBody = z.record(
  z.enum(SERVICES),
  z.object({ perTxn: z.coerce.number().min(0).nullable().optional(), daily: z.coerce.number().min(0).nullable().optional() }),
);

router.get(
  '/limits',
  requirePermission('limits:read'),
  asyncHandler(async (req, res) => {
    const s = await getSettings({ fresh: true });
    const custom = await User.find({ limits: { $exists: true, $ne: null } }).select('fullName email phone limits');
    ok(res, {
      defaults: Object.fromEntries(SERVICES.map((k) => [k, serialize.limits(s.limits[k])])),
      minimums: Object.fromEntries(SERVICES.map((k) => [k, toNaira(s.minimums[k] || 0)])),
      labels: SERVICE_LABELS,
      overrides: custom
        .filter((u) => u.limits && u.limits.size)
        .map((u) => ({
          user: serialize.userBrief(u),
          limits: Object.fromEntries([...u.limits.entries()].map(([k, v]) => [k, serialize.limits(v)])),
        })),
    });
  }),
);

router.put(
  '/limits/defaults',
  requirePermission('limits:write'),
  validate({ body: limitBody }),
  asyncHandler(async (req, res) => {
    const patch = {};
    for (const [k, v] of Object.entries(req.body)) {
      patch[k] = {};
      if (v.perTxn !== undefined) patch[k].perTxn = koboOrNull(v.perTxn);
      if (v.daily !== undefined) patch[k].daily = koboOrNull(v.daily);
    }
    const s = await updateSettings({ limits: patch });
    await audit(req.user._id, 'limits.defaults', { details: req.body });
    ok(res, Object.fromEntries(SERVICES.map((k) => [k, serialize.limits(s.limits[k])])));
  }),
);

async function userLimits(u) {
  const s = await getSettings();
  return Object.fromEntries(
    SERVICES.map((k) => {
      const e = effectiveLimits(u, k, s);
      return [k, { ...serialize.limits(e), custom: e.custom }];
    }),
  );
}

router.get(
  '/limits/users/:id',
  requirePermission('limits:read'),
  validate({ params: z.object({ id: fields.objectId }) }),
  asyncHandler(async (req, res) => {
    const u = await User.findById(req.params.id);
    if (!u) throw notFound('User not found.');
    ok(res, { user: serialize.userBrief(u), limits: await userLimits(u) });
  }),
);

/** Body: { airtime: { perTxn, daily } | null, ... }  null = use system default. */
router.put(
  '/limits/users/:id',
  requirePermission('limits:write'),
  validate({
    params: z.object({ id: fields.objectId }),
    body: z.record(
      z.enum(SERVICES),
      z.object({ perTxn: z.coerce.number().min(0).nullable().optional(), daily: z.coerce.number().min(0).nullable().optional() }).nullable(),
    ),
  }),
  asyncHandler(async (req, res) => {
    const u = await User.findById(req.params.id);
    if (!u) throw notFound('User not found.');
    if (!u.limits) u.limits = new Map();
    for (const [k, v] of Object.entries(req.body)) {
      if (v === null) u.limits.delete(k);
      else u.limits.set(k, { perTxn: koboOrNull(v.perTxn), daily: koboOrNull(v.daily) });
    }
    if (u.limits.size === 0) u.limits = undefined;
    await u.save();
    await audit(req.user._id, 'limits.user', { targetUser: u._id, details: req.body });
    ok(res, { user: serialize.userBrief(u), limits: await userLimits(u) });
  }),
);

module.exports = router;
