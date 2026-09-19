import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate, pageParams } from '../../lib/http.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { currentTermSchema } from '../../domain/termSchemas/index.js';
import { prepareTerms } from '../../domain/terms.js';
import { toMinor, fromMinor } from '../../lib/money.js';

/**
 * M6 — quote response tracking, on StructureVersion.
 *
 * One response per reinsurer per submitted version, with the outcome as a first
 * class value rather than something inferred from what is or is not there.
 * `NO_RESPONSE` is a distinct outcome from a decline and easy to lose, so it is
 * recorded explicitly when a placement closes.
 *
 * An alternative quote is not a different kind of record. It is a new
 * StructureVersion with origin REINSURER and status ALTERNATIVE, linked by
 * parent_version_id to what was submitted (§1.2, M6) — which is what makes
 * "reinsurer X always counters with a higher deductible" a query.
 */
const router = Router();
router.use(authenticate);

const OUTCOMES = ['QUOTED', 'DECLINED', 'ALTERNATIVE_QUOTED', 'NO_RESPONSE', 'ABSTAINED'];

const responseSchema = z.object({
  reinsurer_id: z.string().uuid(),
  outcome: z.enum(OUTCOMES),
  quoted_rate_pct: z.number().nonnegative().optional(),
  quoted_line_pct: z.number().min(0).max(100).optional(),
  quoted_premium: z.union([z.string(), z.number()]).optional(),
  quoted_currency: z.string().length(3).optional(),
  validity: z.string().optional(),
  decline_reason_code: z.string().optional(),
  decline_note: z.string().optional(),
  responded_at: z.string().optional(),
  // ALTERNATIVE_QUOTED: the terms the reinsurer proposed instead. They become
  // a version in their own right.
  alternative_terms: z.record(z.any()).optional(),
});

/** Point-in-time context for the future model (M6). */
async function snapshotFor(client, versionId) {
  const { rows } = await client.query(
    `SELECT sv.id, sv.terms,
            s.cob, s.treaty_type, s.basis,
            cy.inception, cy.currency AS year_currency,
            c.territory,
            cm.rating AS cedant_rating,
            cm.rating_agency AS cedant_rating_agency
     FROM structure_version sv
     JOIN structure s ON s.id = sv.structure_id
     JOIN contract_year cy ON cy.id = s.contract_year_id
     JOIN contract c ON c.id = cy.contract_id
     JOIN cedant ced ON ced.id = c.cedant_id
     -- The cedant's rating lives on its entry in the counterparty register,
     -- which is where the compliance file and rating are maintained. LEFT, since
     -- a cedant need not have been linked to a register entry yet.
     LEFT JOIN market cm ON cm.id = ced.market_id
     WHERE sv.id = $1`,
    [versionId],
  );
  if (!rows[0]) throw new NotFoundError('Structure version');
  const r = rows[0];
  return {
    row: r,
    snapshot: {
      snapshot_cob: r.cob,
      snapshot_treaty_type: r.treaty_type,
      snapshot_basis: r.basis,
      snapshot_territory: r.territory,
      snapshot_cedant_rating: r.cedant_rating,
      snapshot_cedant_rating_agency: r.cedant_rating_agency,
      snapshot_inception: r.inception,
      snapshot_currency: r.terms?.currency ?? r.year_currency,
      snapshot_deductible_minor: r.terms?.deductible ?? null,
      snapshot_limit_minor: r.terms?.limit ?? null,
      snapshot_terms: r.terms ?? {},
    },
  };
}

router.get(
  '/structure-versions/:id/responses',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT r.*, m.name AS reinsurer_name, m.rating AS reinsurer_rating,
              dr.code AS decline_reason_code, dr.name AS decline_reason_name
       FROM structure_response r
       JOIN market m ON m.id = r.reinsurer_id
       LEFT JOIN decline_reason dr ON dr.id = r.decline_reason_id
       WHERE r.structure_version_id = $1
       ORDER BY m.name`,
      [req.params.id],
    );
    // Money is stored in minor units; the display string is rendered here so
    // the browser never re-derives an amount (§2.6).
    res.json(rows.map((r) => ({
      ...r,
      quoted_premium: r.quoted_premium_minor == null
        ? null
        : fromMinor(Number(r.quoted_premium_minor), r.quoted_currency),
    })));
  }),
);

/**
 * Record a response. Upserts on (version, reinsurer): a market that declines
 * and later comes back with a quote has one outcome, not two.
 */
router.put(
  '/structure-versions/:id/responses',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(responseSchema, req.body);

    const result = await withTransaction(async (client) => {
      const { row: version, snapshot } = await snapshotFor(client, req.params.id);

      const { rowCount } = await client.query('SELECT 1 FROM market WHERE id = $1', [body.reinsurer_id]);
      if (!rowCount) throw new NotFoundError('Reinsurer');

      let declineReasonId = null;
      if (body.outcome === 'DECLINED') {
        if (!body.decline_reason_code) {
          throw new ConflictError('A decline needs a reason code (D4)');
        }
        const { rows: reason } = await client.query(
          'SELECT id FROM decline_reason WHERE code = $1 AND active', [body.decline_reason_code],
        );
        if (!reason[0]) throw new NotFoundError(`Decline reason "${body.decline_reason_code}"`);
        declineReasonId = reason[0].id;
      }

      // An alternative quote becomes a version of the same structure.
      let alternativeId = null;
      if (body.outcome === 'ALTERNATIVE_QUOTED') {
        if (!body.alternative_terms) {
          throw new ConflictError('An alternative quote must carry the terms the reinsurer proposed');
        }
        alternativeId = await createAlternativeVersion(client, {
          submittedVersion: version,
          reinsurerId: body.reinsurer_id,
          terms: body.alternative_terms,
          userId: req.user.id,
        });
      }

      const premiumMinor = body.quoted_premium != null && body.quoted_currency
        ? toMinor(body.quoted_premium, body.quoted_currency.toUpperCase())
        : null;

      const { rows } = await client.query(
        `INSERT INTO structure_response (
           structure_version_id, reinsurer_id, outcome,
           quoted_rate_pct, quoted_line_pct, quoted_premium_minor, quoted_currency, validity,
           alternative_version_id, decline_reason_id, decline_note,
           snapshot_cob, snapshot_treaty_type, snapshot_basis, snapshot_territory,
           snapshot_cedant_rating, snapshot_cedant_rating_agency,
           snapshot_inception, snapshot_currency,
           snapshot_deductible_minor, snapshot_limit_minor, snapshot_terms,
           responded_at, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         ON CONFLICT (structure_version_id, reinsurer_id) DO UPDATE SET
           outcome = EXCLUDED.outcome,
           quoted_rate_pct = EXCLUDED.quoted_rate_pct,
           quoted_line_pct = EXCLUDED.quoted_line_pct,
           quoted_premium_minor = EXCLUDED.quoted_premium_minor,
           quoted_currency = EXCLUDED.quoted_currency,
           validity = EXCLUDED.validity,
           alternative_version_id = EXCLUDED.alternative_version_id,
           decline_reason_id = EXCLUDED.decline_reason_id,
           decline_note = EXCLUDED.decline_note,
           responded_at = EXCLUDED.responded_at,
           recorded_by = EXCLUDED.recorded_by,
           updated_at = now()
         RETURNING *`,
        [req.params.id, body.reinsurer_id, body.outcome,
          body.quoted_rate_pct ?? null, body.quoted_line_pct ?? null,
          premiumMinor, premiumMinor == null ? null : body.quoted_currency.toUpperCase(),
          body.validity || null,
          alternativeId, declineReasonId, body.decline_note || null,
          snapshot.snapshot_cob, snapshot.snapshot_treaty_type, snapshot.snapshot_basis,
          snapshot.snapshot_territory, snapshot.snapshot_cedant_rating,
          snapshot.snapshot_cedant_rating_agency,
          snapshot.snapshot_inception, snapshot.snapshot_currency,
          snapshot.snapshot_deductible_minor, snapshot.snapshot_limit_minor,
          snapshot.snapshot_terms,
          body.responded_at || null, req.user.id],
      );

      await audit({
        entityType: 'structure_response', entityId: rows[0].id, action: 'record',
        userId: req.user.id, after: rows[0],
        detail: { outcome: body.outcome, reinsurer_id: body.reinsurer_id },
      }, client);

      return rows[0];
    });
    res.json(result);
  }),
);

async function createAlternativeVersion(client, { submittedVersion, reinsurerId, terms, userId }) {
  const { rows: structure } = await client.query(
    'SELECT * FROM structure WHERE id = (SELECT structure_id FROM structure_version WHERE id = $1)',
    [submittedVersion.id],
  );
  const schema = await currentTermSchema(structure[0].treaty_type, structure[0].cob, client);
  const prepared = prepareTerms(terms, schema);

  const { rows: next } = await client.query(
    'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM structure_version WHERE structure_id = $1',
    [structure[0].id],
  );
  const { rows } = await client.query(
    `INSERT INTO structure_version
       (structure_id, version_no, status, origin, origin_party_id, parent_version_id,
        terms, term_schema_id, created_by)
     VALUES ($1,$2,'ALTERNATIVE','REINSURER',$3,$4,$5,$6,$7) RETURNING *`,
    [structure[0].id, next[0].n, reinsurerId, submittedVersion.id, prepared, schema.id, userId],
  );
  await audit({
    entityType: 'structure_version', entityId: rows[0].id, action: 'alternative_quote',
    userId, after: rows[0],
  }, client);
  return rows[0].id;
}

/**
 * Close the quoting round: every reinsurer approached but not heard from is
 * recorded as NO_RESPONSE.
 *
 * M6 is explicit that this is a distinct outcome and must not be inferred from
 * absent rows — an absent row is indistinguishable from "we never asked them",
 * and a model trained without the silences learns that everyone answers.
 */
router.post(
  '/structure-versions/:id/close-quoting',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(
      z.object({ approached_reinsurer_ids: z.array(z.string().uuid()).min(1) }),
      req.body,
    );

    const result = await withTransaction(async (client) => {
      const { snapshot } = await snapshotFor(client, req.params.id);

      const { rows } = await client.query(
        `INSERT INTO structure_response (
           structure_version_id, reinsurer_id, outcome,
           snapshot_cob, snapshot_treaty_type, snapshot_basis, snapshot_territory,
           snapshot_cedant_rating, snapshot_cedant_rating_agency,
           snapshot_inception, snapshot_currency,
           snapshot_deductible_minor, snapshot_limit_minor, snapshot_terms,
           recorded_by)
         SELECT $1, m.id, 'NO_RESPONSE',
                $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
         FROM unnest($2::uuid[]) AS m(id)
         ON CONFLICT (structure_version_id, reinsurer_id) DO NOTHING
         RETURNING *`,
        [req.params.id, body.approached_reinsurer_ids,
          snapshot.snapshot_cob, snapshot.snapshot_treaty_type, snapshot.snapshot_basis,
          snapshot.snapshot_territory, snapshot.snapshot_cedant_rating,
          snapshot.snapshot_cedant_rating_agency,
          snapshot.snapshot_inception, snapshot.snapshot_currency,
          snapshot.snapshot_deductible_minor, snapshot.snapshot_limit_minor,
          snapshot.snapshot_terms, req.user.id],
      );

      if (rows.length > 0) {
        await audit({
          entityType: 'structure_version', entityId: req.params.id, action: 'close_quoting',
          userId: req.user.id,
          detail: { no_response_recorded: rows.length },
        }, client);
      }
      return { no_response_recorded: rows.length, responses: rows };
    });
    res.json(result);
  }),
);

/**
 * A reinsurer's history across placements (M6). The ML dataset as a query, not
 * an ETL job — which is what §1.2 said the version model would buy.
 */
router.get(
  '/reinsurers/:id/response-history',
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const params = [req.params.id];
    const filters = ['r.reinsurer_id = $1'];
    if (req.query.cob) {
      params.push(req.query.cob);
      filters.push(`r.snapshot_cob = $${params.length}`);
    }
    if (req.query.treaty_type) {
      params.push(req.query.treaty_type);
      filters.push(`r.snapshot_treaty_type = $${params.length}`);
    }
    params.push(limit, offset);

    const { rows } = await query(
      `SELECT r.id, r.outcome, r.quoted_rate_pct, r.quoted_line_pct, r.responded_at,
              r.snapshot_cob, r.snapshot_treaty_type, r.snapshot_basis, r.snapshot_territory,
              r.snapshot_cedant_rating, r.snapshot_inception, r.snapshot_currency,
              r.snapshot_deductible_minor, r.snapshot_limit_minor,
              dr.code AS decline_reason_code,
              s.label AS structure_label, ced.name AS cedant_name,
              alt.terms AS alternative_terms
       FROM structure_response r
       JOIN structure_version sv ON sv.id = r.structure_version_id
       JOIN structure s ON s.id = sv.structure_id
       JOIN contract_year cy ON cy.id = s.contract_year_id
       JOIN contract c ON c.id = cy.contract_id
       JOIN cedant ced ON ced.id = c.cedant_id
       LEFT JOIN decline_reason dr ON dr.id = r.decline_reason_id
       LEFT JOIN structure_version alt ON alt.id = r.alternative_version_id
       WHERE ${filters.join(' AND ')}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const { rows: tally } = await query(
      `SELECT outcome, COUNT(*)::int AS n FROM structure_response
       WHERE reinsurer_id = $1 GROUP BY outcome`,
      [req.params.id],
    );

    res.json({
      reinsurer_id: req.params.id,
      by_outcome: Object.fromEntries(tally.map((t) => [t.outcome, t.n])),
      responses: rows,
    });
  }),
);

/** The decline reason vocabulary (M6, D4). */
router.get(
  '/decline-reasons',
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      'SELECT id, code, name, description FROM decline_reason WHERE active ORDER BY position, code',
    );
    res.json(rows);
  }),
);

export default router;
