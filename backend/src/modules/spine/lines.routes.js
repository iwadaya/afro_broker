import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { assertApproved } from '../../lib/approvals.js';
import { computeSigning, allocatePremiumMinor, roundPct } from '../../domain/signingDown.js';
import { fromMinor } from '../../lib/money.js';
import { bordereauToXlsx, bordereauToPdf, bordereauFilename } from './bordereau.export.js';

/**
 * M9 — lines and placement completion, on StructureVersion.
 *
 * The signing-down engine is unchanged: it already implements §1.4 correctly,
 * including the per-line override, with largest-remainder reconciliation so the
 * signed total equals the order exactly. What is new is that lines hang off the
 * version whose terms were written, and that the bordereau derives the expiring
 * panel from the renewal chain rather than from anything typed in.
 */
const router = Router();
router.use(authenticate);

const lineSchema = z.object({
  reinsurer_id: z.string().uuid(),
  written_pct: z.number().min(0).max(100),
  to_stand: z.boolean().optional(),
  written_at: z.string().optional(),
  distribution_recipient_id: z.string().uuid().nullish(),
});

async function loadVersion(runner, versionId) {
  const { rows } = await runner.query(
    `SELECT sv.*, s.id AS structure_id, s.label, s.order_pct, s.basis, s.contract_year_id
     FROM structure_version sv JOIN structure s ON s.id = sv.structure_id
     WHERE sv.id = $1`,
    [versionId],
  );
  if (!rows[0]) throw new NotFoundError('Structure version');
  return rows[0];
}

/**
 * The premium at 100% for a version's terms, in minor units.
 *
 * Non-proportional: the minimum and deposit premium is what a line's share is
 * taken against before the year-end adjustment (M11). Proportional: the
 * estimated premium income. Null where the terms do not yet state one, in which
 * case shares are recorded without an allocation rather than against a guess.
 */
function premiumAtHundred(version) {
  const t = version.terms || {};
  const amount = version.basis === 'NP' ? t.mdp : t.epi;
  return typeof amount === 'number' && t.currency
    ? { minor: amount, currency: t.currency }
    : null;
}

router.get(
  '/structure-versions/:id/lines',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT l.*, m.name AS reinsurer_name, m.rating, m.rating_agency
       FROM structure_line l JOIN market m ON m.id = l.reinsurer_id
       WHERE l.structure_version_id = $1 ORDER BY m.name`,
      [req.params.id],
    );
    // The signed premium is stored in minor units; render the display string
    // here so the browser never re-derives an amount (§2.6).
    res.json(rows.map((l) => ({
      ...l,
      premium_signed: l.premium_signed_minor == null
        ? null
        : fromMinor(Number(l.premium_signed_minor), l.premium_currency),
    })));
  }),
);

/**
 * Write (or re-write) a reinsurer's line. Re-writing clears the signed values,
 * which are stale the moment the written total moves — §1.4 is explicit that
 * one must never overwrite the other, and a signed figure computed against a
 * superseded written total is exactly that mistake by another route.
 */
router.put(
  '/structure-versions/:id/lines',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(lineSchema, req.body);

    const row = await withTransaction(async (client) => {
      const version = await loadVersion(client, req.params.id);
      if (version.status !== 'FOT') {
        throw new ConflictError('Lines are written against firm order terms; promote the version to FOT first');
      }
      const { rowCount } = await client.query('SELECT 1 FROM market WHERE id = $1', [body.reinsurer_id]);
      if (!rowCount) throw new NotFoundError('Reinsurer');

      const { rows } = await client.query(
        `INSERT INTO structure_line
           (structure_version_id, reinsurer_id, written_pct, to_stand, written_at,
            distribution_recipient_id, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'WRITTEN',$7)
         ON CONFLICT (structure_version_id, reinsurer_id) DO UPDATE SET
           written_pct = EXCLUDED.written_pct,
           to_stand = EXCLUDED.to_stand,
           written_at = EXCLUDED.written_at,
           distribution_recipient_id = COALESCE(EXCLUDED.distribution_recipient_id, structure_line.distribution_recipient_id),
           signed_pct = NULL, signing_factor = NULL,
           premium_signed_minor = NULL, premium_currency = NULL,
           status = 'WRITTEN', updated_at = now()
         RETURNING *`,
        [req.params.id, body.reinsurer_id, body.written_pct, body.to_stand ?? false,
          body.written_at || null, body.distribution_recipient_id || null, req.user.id],
      );
      await audit({
        entityType: 'structure_line', entityId: rows[0].id, action: 'write',
        userId: req.user.id, after: rows[0],
      }, client);
      return rows[0];
    });
    res.json(row);
  }),
);

router.post(
  '/structure-versions/:id/lines/:reinsurerId/decline',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE structure_line SET status = 'DECLINED', written_pct = 0,
                signed_pct = NULL, premium_signed_minor = NULL, premium_currency = NULL,
                updated_at = now()
         WHERE structure_version_id = $1 AND reinsurer_id = $2 RETURNING *`,
        [req.params.id, req.params.reinsurerId],
      );
      if (!rows[0]) throw new NotFoundError('Line');
      await audit({
        entityType: 'structure_line', entityId: rows[0].id, action: 'decline',
        userId: req.user.id, after: rows[0],
      }, client);
      return rows[0];
    });
    res.json(row);
  }),
);

/** Gather the active written lines and the order for a signing run. */
async function gather(runner, versionId) {
  const version = await loadVersion(runner, versionId);
  const { rows } = await runner.query(
    `SELECT * FROM structure_line
     WHERE structure_version_id = $1 AND status IN ('WRITTEN','SIGNED')
     ORDER BY created_at`,
    [versionId],
  );
  return {
    version,
    order: Number(version.order_pct),
    lines: rows.map((l) => ({ id: l.id, written: Number(l.written_pct), toStand: l.to_stand })),
  };
}

function withPremium(result, version) {
  const premium = premiumAtHundred(version);
  if (!premium) return { ...result, premium: null };
  const alloc = allocatePremiumMinor(premium.minor, result.lines);
  const byId = Object.fromEntries(alloc.map((a) => [a.id, a.premiumSignedMinor]));
  return {
    ...result,
    premium: { currency: premium.currency, at_hundred: fromMinor(premium.minor, premium.currency) },
    lines: result.lines.map((l) => ({
      ...l,
      premiumSignedMinor: byId[l.id] ?? 0,
      premiumSigned: fromMinor(byId[l.id] ?? 0, premium.currency),
    })),
  };
}

/** Non-mutating preview, so the effect of signing down is visible before it is applied. */
router.get(
  '/structure-versions/:id/signing/preview',
  asyncHandler(async (req, res) => {
    const { version, order, lines } = await gather({ query }, req.params.id);
    res.json(withPremium(computeSigning(order, lines), version));
  }),
);

/**
 * Apply signing down. Undersubscribed placements need `accept_shortfall`: a
 * shortfall is a decision to firm at written rather than an arithmetic outcome,
 * and signing it silently would hide that the order was never fully placed.
 */
router.post(
  '/structure-versions/:id/signing/apply',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ accept_shortfall: z.boolean().optional() }), req.body || {});

    const result = await withTransaction(async (client) => {
      const { version, order, lines } = await gather(client, req.params.id);
      if (lines.length === 0) throw new ConflictError('No written lines to sign');

      const signing = computeSigning(order, lines);
      if (signing.state === 'UNDERSUBSCRIBED' && !body.accept_shortfall) {
        throw new ConflictError(
          `Undersubscribed: shortfall ${signing.shortfall}% of an order of ${order}%. `
          + 'Keep marketing, or apply with accept_shortfall to firm at written.',
        );
      }

      const priced = withPremium(signing, version);
      for (const line of priced.lines) {
        await client.query(
          `UPDATE structure_line
           SET signed_pct = $1, signing_factor = $2,
               premium_signed_minor = $3, premium_currency = $4,
               status = 'SIGNED', updated_at = now()
           WHERE id = $5`,
          [line.signed, line.toStand ? 1 : signing.signingFactor,
            line.premiumSignedMinor ?? null,
            line.premiumSignedMinor == null ? null : priced.premium.currency,
            line.id],
        );
      }

      await audit({
        entityType: 'structure_version', entityId: req.params.id, action: 'sign_down',
        userId: req.user.id,
        detail: {
          state: signing.state, factor: signing.signingFactor,
          signed_total: signing.signedTotal, order, lines: priced.lines.length,
        },
      }, client);
      return priced;
    });
    res.json(result);
  }),
);

/**
 * Placement completion for a contract year (§1.4, M10): signed against order,
 * per structure.
 */
router.get(
  '/contract-years/:id/completion',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.id AS structure_id, s.label, s.order_pct, s.basis,
              fot.id AS fot_version_id,
              COALESCE(SUM(l.written_pct) FILTER (WHERE l.status IN ('WRITTEN','SIGNED')), 0) AS written_total,
              COALESCE(SUM(l.signed_pct) FILTER (WHERE l.status = 'SIGNED'), 0) AS signed_total
       FROM structure s
       LEFT JOIN LATERAL (
         SELECT sv.id FROM structure_version sv
         WHERE sv.structure_id = s.id AND sv.status = 'FOT'
         ORDER BY sv.version_no DESC LIMIT 1
       ) fot ON TRUE
       LEFT JOIN structure_line l ON l.structure_version_id = fot.id
       WHERE s.contract_year_id = $1
       GROUP BY s.id, s.label, s.order_pct, s.basis, fot.id
       ORDER BY s.position, s.label`,
      [req.params.id],
    );

    res.json(rows.map((r) => {
      const order = Number(r.order_pct);
      const written = roundPct(Number(r.written_total));
      const signed = roundPct(Number(r.signed_total));
      return {
        structure_id: r.structure_id,
        label: r.label,
        basis: r.basis,
        fot_version_id: r.fot_version_id,
        order_pct: order,
        written_total: written,
        signed_total: signed,
        pct_of_order_written: order > 0 ? roundPct((written / order) * 100) : null,
        oversubscribed: written > order,
        shortfall: written < order ? roundPct(order - written) : 0,
      };
    }));
  }),
);

/**
 * The written lines bordereau (M9): reinsurer, share, rating, and whether the
 * reinsurer was on the expiring panel.
 *
 * The expiring flag is derived from `prior_contract_year_id`, not typed in —
 * that link is one of the three things §1.1 says the renewal chain buys.
 */
async function bordereauFor(contractYearId) {
  const { rows: year } = await query(
    `SELECT cy.*, c.name AS contract_name, ced.name AS cedant_name
     FROM contract_year cy
     JOIN contract c ON c.id = cy.contract_id
     JOIN cedant ced ON ced.id = c.cedant_id
     WHERE cy.id = $1`,
    [contractYearId],
  );
  if (!year[0]) throw new NotFoundError('Contract year');

  const { rows } = await query(
    `WITH fot AS (
       SELECT DISTINCT ON (s.id) s.id AS structure_id, s.label, s.position, s.order_pct, sv.id AS version_id
       FROM structure s
       JOIN structure_version sv ON sv.structure_id = s.id AND sv.status = 'FOT'
       WHERE s.contract_year_id = $1
       ORDER BY s.id, sv.version_no DESC
     ),
     expiring_panel AS (
       -- Who was on the panel last year, through the renewal chain.
       SELECT DISTINCT l.reinsurer_id
       FROM structure ps
       JOIN structure_version psv ON psv.structure_id = ps.id
       JOIN structure_line l ON l.structure_version_id = psv.id
       WHERE ps.contract_year_id = $2 AND l.status IN ('WRITTEN','SIGNED')
     )
     SELECT f.structure_id, f.label, f.order_pct,
            m.id AS reinsurer_id, m.name AS reinsurer_name,
            m.rating, m.rating_agency,
            l.written_pct, l.signed_pct, l.to_stand, l.status,
            l.premium_signed_minor, l.premium_currency,
            (ep.reinsurer_id IS NOT NULL) AS on_expiring_panel
     FROM fot f
     JOIN structure_line l ON l.structure_version_id = f.version_id
     JOIN market m ON m.id = l.reinsurer_id
     LEFT JOIN expiring_panel ep ON ep.reinsurer_id = m.id
     WHERE l.status IN ('WRITTEN','SIGNED')
     ORDER BY f.position, f.label, m.name`,
    [contractYearId, year[0].prior_contract_year_id],
  );

  return {
    contract_year: {
      id: year[0].id,
      year_label: year[0].year_label,
      cedant_name: year[0].cedant_name,
      contract_name: year[0].contract_name,
      inception: year[0].inception,
      expiry: year[0].expiry,
      currency: year[0].currency,
    },
    expiring_panel_known: year[0].prior_contract_year_id != null,
    lines: rows.map((r) => ({
      structure_id: r.structure_id,
      structure_label: r.label,
      order_pct: Number(r.order_pct),
      reinsurer_id: r.reinsurer_id,
      reinsurer_name: r.reinsurer_name,
      rating: r.rating,
      rating_agency: r.rating_agency,
      written_pct: Number(r.written_pct),
      signed_pct: r.signed_pct == null ? null : Number(r.signed_pct),
      to_stand: r.to_stand,
      status: r.status,
      premium_signed: r.premium_signed_minor == null
        ? null
        : fromMinor(Number(r.premium_signed_minor), r.premium_currency),
      premium_currency: r.premium_currency,
      on_expiring_panel: r.on_expiring_panel,
    })),
  };
}

router.get(
  '/contract-years/:id/bordereau',
  asyncHandler(async (req, res) => {
    res.json(await bordereauFor(req.params.id));
  }),
);

/* M9 — "Export to Excel and PDF." Both render the same object the JSON
   endpoint returns, so they cannot drift into disagreeing about the panel. */
const EXPORTS = {
  xlsx: {
    extension: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    render: bordereauToXlsx,
  },
  pdf: { extension: 'pdf', contentType: 'application/pdf', render: bordereauToPdf },
};

router.get(
  '/contract-years/:id/bordereau/export',
  asyncHandler(async (req, res) => {
    const format = String(req.query.format || 'xlsx').toLowerCase();
    const exporter = EXPORTS[format];
    if (!exporter) throw new ValidationError(`Unsupported format "${format}" — use xlsx or pdf`);

    const bordereau = await bordereauFor(req.params.id);
    const buffer = await exporter.render(bordereau);
    await audit({
      entityType: 'contract_year', entityId: req.params.id, action: 'bordereau_export',
      userId: req.user.id, detail: { format, lines: bordereau.lines.length },
    });
    res.setHeader('Content-Type', exporter.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${bordereauFilename(bordereau, exporter.extension)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  }),
);

// ---------------------------------------------------------------------------
// Written lines advised to the cedant, incrementally (M9)
// ---------------------------------------------------------------------------
/**
 * "Written lines sent to the cedant incrementally as they arrive from follow
 * markets — not one final send."
 *
 * An advice snapshots the written percentages as at the moment it is raised: it
 * is a statement made on a date, and a line that moves afterwards must not
 * rewrite what the cedant was told.
 */
router.post(
  '/contract-years/:id/written-line-advices',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await withTransaction(async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM contract_year WHERE id = $1', [req.params.id]);
      if (!rowCount) throw new NotFoundError('Contract year');

      const { rows: lines } = await client.query(
        `SELECT l.id, l.written_pct FROM structure_line l
         JOIN structure_version sv ON sv.id = l.structure_version_id
         JOIN structure s ON s.id = sv.structure_id
         WHERE s.contract_year_id = $1 AND l.status IN ('WRITTEN','SIGNED')`,
        [req.params.id],
      );
      if (lines.length === 0) throw new ConflictError('No written lines to advise');

      const { rows } = await client.query(
        'INSERT INTO written_line_advice (contract_year_id, created_by) VALUES ($1,$2) RETURNING *',
        [req.params.id, req.user.id],
      );
      for (const l of lines) {
        await client.query(
          `INSERT INTO written_line_advice_line (advice_id, structure_line_id, written_pct)
           VALUES ($1,$2,$3)`,
          [rows[0].id, l.id, l.written_pct],
        );
      }
      await audit({
        entityType: 'written_line_advice', entityId: rows[0].id, action: 'create',
        userId: req.user.id, after: rows[0], detail: { lines: lines.length },
      }, client);
      return { ...rows[0], line_count: lines.length };
    });
    res.status(201).json(row);
  }),
);

router.get(
  '/contract-years/:id/written-line-advices',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT a.*, u.name AS created_by_name,
              (SELECT COUNT(*)::int FROM written_line_advice_line al WHERE al.advice_id = a.id) AS line_count
       FROM written_line_advice a LEFT JOIN users u ON u.id = a.created_by
       WHERE a.contract_year_id = $1 ORDER BY a.created_at DESC`,
      [req.params.id],
    );
    res.json(rows);
  }),
);

/** D7 — an advice is outbound, so it consumes a second user's approval. */
router.post(
  '/written-line-advices/:id/send',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        'SELECT * FROM written_line_advice WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      if (!current[0]) throw new NotFoundError('Written line advice');
      if (current[0].status !== 'DRAFT') throw new ConflictError('That advice has already gone out');

      const approval = await assertApproved(client, {
        actionType: 'written_line_advice', entityType: 'written_line_advice', entityId: req.params.id,
      });
      const { rows } = await client.query(
        `UPDATE written_line_advice SET status = 'SENT', sent_at = now(), approval_id = $1,
                updated_at = now() WHERE id = $2 RETURNING *`,
        [approval.id, req.params.id],
      );
      await audit({
        entityType: 'written_line_advice', entityId: req.params.id, action: 'send',
        userId: req.user.id, before: current[0], after: rows[0],
        detail: { approval_id: approval.id },
      }, client);
      return rows[0];
    });
    res.json(row);
  }),
);

export { bordereauFor };
export default router;
