import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { parseCsv, toNumber } from '../../lib/csv.js';
import { summariseBordereau, aggregateExperience, DEFAULT_LARGE_LOSS_THRESHOLD } from '../../domain/experience.js';

const router = Router();
router.use(authenticate);

const ingestSchema = z.object({
  type: z.enum(['premium', 'claims', 'risk_profile']),
  source_file: z.string().optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  // Either raw CSV text or pre-parsed rows.
  csv: z.string().optional(),
  rows: z.array(z.record(z.any())).optional(),
}).refine((d) => d.csv || d.rows, { message: 'Provide csv text or rows' });

/** Summarise parsed rows by bordereau type using common column-name heuristics. */
export function summarise(type, rows) {
  const pick = (row, names) => {
    const keys = Object.keys(row);
    for (const n of names) {
      const k = keys.find((key) => key.toLowerCase().replace(/[^a-z]/g, '') === n);
      if (k != null) return toNumber(row[k]);
    }
    return 0;
  };
  // Risk profiles (sum-insured banding) are shaped by the experience domain.
  if (type === 'risk_profile') return summariseBordereau('risk_profile', rows);
  if (type === 'premium') {
    // premiumceded first: on canonical (template-mapped) rows the premium
    // ceded to the treaty is the bordereau's premium, not the 100% gross.
    const premium = rows.reduce((a, r) => a + pick(r, ['premiumceded', 'premium', 'grosspremium', 'gwp']), 0);
    return { row_count: rows.length, premium: round2(premium) };
  }
  const paid = rows.reduce((a, r) => a + pick(r, ['paid', 'paidloss', 'paidamount']), 0);
  const outstanding = rows.reduce((a, r) => a + pick(r, ['outstanding', 'reserve', 'osr', 'casereserve']), 0);
  const incurred = rows.reduce((a, r) => {
    const inc = pick(r, ['incurred', 'incurredloss']);
    return a + (inc || pick(r, ['paid', 'paidloss']) + pick(r, ['outstanding', 'reserve', 'osr']));
  }, 0);
  return {
    row_count: rows.length,
    paid: round2(paid),
    outstanding: round2(outstanding),
    incurred: round2(incurred),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

router.get(
  '/placements/:placementId/bordereaux',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT id, placement_id, type, source_file, period_start, period_end, row_count, summary, created_at FROM bordereau WHERE placement_id = $1 ORDER BY created_at',
      [req.params.placementId],
    );
    res.json(rows);
  }),
);

router.post(
  '/placements/:placementId/bordereaux',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(ingestSchema, req.body);
    const placement = await query('SELECT 1 FROM placement WHERE id = $1', [req.params.placementId]);
    if (!placement.rowCount) throw new NotFoundError('Placement');

    const parsed = body.rows ? body.rows : parseCsv(body.csv);
    const summary = summarise(body.type, parsed);

    const { rows } = await query(
      `INSERT INTO bordereau (placement_id, type, source_file, period_start, period_end, parsed_rows, row_count, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, placement_id, type, source_file, period_start, period_end, row_count, summary, created_at`,
      [req.params.placementId, body.type, body.source_file || null,
        body.period_start || null, body.period_end || null,
        JSON.stringify(parsed), parsed.length, summary, req.user.id],
    );
    await audit({ entityType: 'bordereau', entityId: rows[0].id, action: 'ingest', userId: req.user.id, detail: { type: body.type, rows: parsed.length } });
    res.status(201).json(rows[0]);
  }),
);

router.get(
  '/bordereaux/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM bordereau WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new NotFoundError('Bordereau');
    res.json(rows[0]);
  }),
);

/** Pick the underwriting year off a parsed row, if it carries one. */
function yearOf(row) {
  const keys = Object.keys(row);
  for (const n of ['uy', 'underwritingyear', 'uwyear', 'uwy', 'yoa', 'yearofaccount', 'treatyyear', 'year']) {
    const k = keys.find((key) => key.toLowerCase().replace(/[^a-z]/g, '') === n);
    if (k != null) {
      const y = toNumber(row[k]);
      if (y >= 1900 && y <= 2100) return y;
    }
  }
  return null;
}

// Aggregated loss/exposure summary across all bordereaux on a placement.
// Superseded bordereaux (summary.state === 'superseded') are excluded from
// totals and the per-year exhibit so a re-ingest does not double-count.
router.get(
  '/placements/:placementId/loss-summary',
  asyncHandler(async (req, res) => {
    const { rows: all } = await query(
      'SELECT type, summary, parsed_rows FROM bordereau WHERE placement_id = $1',
      [req.params.placementId],
    );
    const rows = all.filter((r) => r.summary?.state !== 'superseded');
    const premium = rows.filter((r) => r.type === 'premium')
      .reduce((a, r) => a + (r.summary.premium || 0), 0);
    const claims = rows.filter((r) => r.type === 'claims');
    const paid = claims.reduce((a, r) => a + (r.summary.paid || 0), 0);
    const outstanding = claims.reduce((a, r) => a + (r.summary.outstanding || 0), 0);
    const incurred = claims.reduce((a, r) => a + (r.summary.incurred || 0), 0);
    const lossRatio = premium > 0 ? round2((incurred / premium) * 100) : null;

    // Per-underwriting-year exhibit from rows that carry a year column.
    const pick = (row, names) => {
      const keys = Object.keys(row);
      for (const n of names) {
        const k = keys.find((key) => key.toLowerCase().replace(/[^a-z]/g, '') === n);
        if (k != null) return toNumber(row[k]);
      }
      return 0;
    };
    const byYear = new Map();
    const bucket = (y) => {
      if (!byYear.has(y)) byYear.set(y, { year: y, premium: 0, paid: 0, outstanding: 0, incurred: 0 });
      return byYear.get(y);
    };
    for (const b of rows) {
      for (const r of b.parsed_rows || []) {
        const y = yearOf(r);
        if (y == null) continue;
        const acc = bucket(y);
        if (b.type === 'premium') {
          acc.premium += pick(r, ['premium', 'grosspremium', 'gwp', 'subjectpremium']);
        } else {
          const p = pick(r, ['paid', 'paidloss', 'paidamount']);
          const os = pick(r, ['outstanding', 'reserve', 'osr', 'casereserve']);
          acc.paid += p;
          acc.outstanding += os;
          acc.incurred += pick(r, ['incurred', 'incurredloss']) || p + os;
        }
      }
    }
    const by_year = [...byYear.values()]
      .sort((a, b) => a.year - b.year)
      .map((y) => ({
        ...y,
        premium: round2(y.premium),
        paid: round2(y.paid),
        outstanding: round2(y.outstanding),
        incurred: round2(y.incurred),
        loss_ratio_pct: y.premium > 0 ? round2((y.incurred / y.premium) * 100) : null,
      }));

    // The reinsurer-facing exhibits — the large-loss table, cat losses and the
    // risk profile — shaped from the same non-superseded rows.
    const threshold = Number(req.query.large_loss_threshold) > 0
      ? Number(req.query.large_loss_threshold)
      : DEFAULT_LARGE_LOSS_THRESHOLD;
    const shaped = aggregateExperience(rows.map((b) => ({
      type: b.type,
      summary: summariseBordereau(b.type, b.parsed_rows || [], { largeLossThreshold: threshold }),
    })));

    res.json({
      premium: round2(premium),
      paid: round2(paid),
      outstanding: round2(outstanding),
      incurred: round2(incurred),
      loss_ratio_pct: lossRatio,
      bordereaux: all.length,
      by_year,
      large_losses: shaped.large_losses,
      large_loss_count: shaped.large_loss_count,
      large_loss_threshold: threshold,
      cat: shaped.cat,
      risk_profile: shaped.risk_profile,
    });
  }),
);

export default router;
