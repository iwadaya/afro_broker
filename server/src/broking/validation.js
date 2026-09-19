// server/src/broking/validation.js — Zod schemas for /api/broking (pattern from
// Universe validation/treaty.js, composed from validation/common.js primitives).
// Rules: pct100 0–100; Loss Cap and % reinstatements 0–1000; money ≥ 0;
// lcf_years 0–20; ≤5 loss-participation slides with max_lr > min_lr;
// a sliding-scale table, when present, has ≥2 complete rows.
import { z } from 'zod';
import { uuid, optionalUuid, money, pct100, pctOpen, intField, uwYear, isoDate, boolish } from '../validation/common.js';
import { normaliseUmr, isValidUmr, UMR_MAX_LENGTH, ALL_STATUSES } from '../../../shared/broking/calcs.js';

export const umrSchema = z.preprocess(
  (v) => (v == null ? v : normaliseUmr(v)),
  z.string().min(1, 'UMR is required').max(UMR_MAX_LENGTH, `A UMR is at most ${UMR_MAX_LENGTH} characters`)
    .refine(isValidUmr, { message: 'Format: B + 4 digits + 1–12 letters or digits (max 17)' }),
);

export const businessTypeSchema = z.enum(['PROPORTIONAL', 'NON_PROPORTIONAL']);

/** row_version / rowVersion: positive int; absent = no check. `force` overrides a stale check. */
const rowVersion = z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().int().positive().optional());
const lockFields = { rowVersion, row_version: rowVersion, force: boolish };

const nullableText = (max) => z.preprocess((v) => (v === '' ? null : v), z.string().max(max).nullable().optional());
const nullableDate = z.preprocess((v) => (v === '' ? null : v), z.union([isoDate, z.null()]).optional());
const nullableEnum = (values) => z.preprocess((v) => (v === '' ? null : v), z.enum(values).nullable().optional());
const uuidList = z.array(uuid).max(50).optional();

export const createContractSchema = z.object({
  umr: umrSchema,
  businessType: businessTypeSchema,
  parentContractId: optionalUuid,
});

export const headerSchema = z.object({
  countryId: optionalUuid,
  cedantId: optionalUuid,
  brokerId: optionalUuid,
  currencyId: optionalUuid,
  treatyTypeId: optionalUuid,
  classIds: uuidList,            // first = primary
  altContractId: nullableText(120),
  inceptionDate: nullableDate,
  renewalDate: nullableDate,
  experienceStartYear: uwYear,
});

export const putHeaderSchema = z.object({ ...lockFields, header: headerSchema });

const numLines = z.preprocess((v) => (v === '' || v == null ? undefined : Number(String(v).replace(/,/g, ''))), z.number().min(0).max(999).optional());

export const propDetailSchema = z.object({
  triangulationsAvailable: boolish,
  qsLimit: money, retentionPct: pct100, cessionPct: pct100,
  surplusMaxRetention: money, numLines,
  eventLimit: money, aal: money,
  quotaShareEpi: money, surplusEpi: money,
  brokeragePct: pct100, taxesPct: pct100, lossCapPct: pctOpen,
});

const slideRow = z.object({ lossRatioPct: pctOpen, commissionPct: pct100 })
  .refine((r) => r.lossRatioPct != null && r.commissionPct != null, { message: 'each sliding-scale row needs Loss Ratio % and Commission %' });

export const commissionsSchema = z.object({
  mode: z.preprocess((v) => (v == null ? undefined : String(v).toUpperCase()), z.enum(['FIXED', 'SLIDING']).optional()),
  fixedCommissionQSPct: pct100, fixedCommissionSurplusPct: pct100, provisionalCommissionPct: pct100,
  slidingMinLossRatio: pct100, slidingMaxLossRatio: pct100, slidingMinCommission: pct100, slidingMaxCommission: pct100,
  mgmtExpensesPct: pct100, profitCommissionPct: pct100,
  lcfYears: z.preprocess((v) => (v === '' || v == null ? null : Number(v)), z.number().int().min(0).max(20).nullable().optional()),
  lcfExtinction: boolish,
  slidingTable: z.array(slideRow).max(50).optional()
    .refine((rows) => !rows || rows.length === 0 || rows.length >= 2, { message: 'a sliding-scale table needs at least 2 complete rows' }),
});

const lpSlide = z.object({ minLr: pctOpen, maxLr: pctOpen, share: pct100 })
  .refine((s) => s.minLr != null && s.maxLr != null && s.share != null, { message: 'each corridor needs Min LR %, Max LR % and Re Share %' })
  .refine((s) => s.minLr == null || s.maxLr == null || Number(s.maxLr) > Number(s.minLr), { message: 'max_lr must be greater than min_lr' });

export const lossParticipationSchema = z.object({
  enabled: boolish,
  minLossRatioPct: pctOpen, maxLossRatioPct: pctOpen, reinsurerSharePct: pct100,
  slides: z.array(lpSlide).max(5, 'at most 5 loss-participation slides').optional(),
});

export const epiSplitSchema = z.array(z.object({ classId: uuid, premium: money })).max(50).optional();

export const putPropDetailSchema = z.object({
  ...lockFields,
  header: headerSchema.optional(),
  detail: propDetailSchema.optional(),
  commissions: commissionsSchema.optional(),
  lossParticipation: lossParticipationSchema.optional(),
  epiSplit: epiSplitSchema,
});

/** '' → null (none), 'UNLIMITED' → -1, else 0–10. */
const reinstatements = z.preprocess((v) => {
  if (v === '' || v == null) return null;
  if (typeof v === 'string' && v.trim().toUpperCase() === 'UNLIMITED') return -1;
  const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : v;
}, z.union([z.literal(-1), z.number().int().min(0).max(10)]).nullable().optional());

const rate = z.preprocess((v) => {
  if (v === '' || v == null) return undefined;
  const n = Number(String(v).replace(/[%,\s]/g, '')); return Number.isFinite(n) ? n : v;
}, z.number().min(0).max(100000).optional());

export const layerSchema = z.object({
  layerNumber: intField({ min: 1, max: 20, optional: true }),
  limit: money, aggregateLimit: money, egnpi: money, rate, mdp: money,
  numReinstatements: reinstatements, reinstatementPct: pctOpen,
  aad: boolish, aadAmount: money,
  riskCover: boolish, catCover: boolish,
  classIds: uuidList,
  // Stop Loss / Aggregate XL inputs
  attachLrPct: pctOpen, limitLrPct: pctOpen, epi: money, aggregateDeductible: money,
});

export const programmeSchema = z.object({
  deductible: money,
  accountingMethod: nullableEnum(['Losses Occurring', 'Risks Attaching']),
  xlType: nullableEnum(['Gross XL', 'Net XL']),
  accounts: nullableEnum(['Half yearly', 'Quarterly', 'Annual']),
  estGnpi: money, brokeragePct: pct100, taxesPct: pct100, noClaimsBonusPct: pct100, profitCommissionPct: pct100,
});

export const putNpStructureSchema = z.object({
  ...lockFields,
  programme: programmeSchema.optional(),
  layers: z.array(layerSchema).min(1, 'at least one layer').max(20, 'at most 20 layers').optional(),
});

export const amendUmrSchema = z.object({
  newUmr: umrSchema,
  reason: z.string().trim().min(3, 'give a reason (at least 3 characters)').max(500),
});

export const statusSchema = z.object({ ...lockFields, status: z.enum(ALL_STATUSES) });

export const listQuerySchema = z.object({
  search: z.string().trim().max(40).optional(),
  limit: z.preprocess((v) => (v == null || v === '' ? undefined : Number(v)), z.number().int().min(1).max(500).optional()),
});
