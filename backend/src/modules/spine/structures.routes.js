import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { currentTermSchema, termSchemaById, TREATY_TYPES } from '../../domain/termSchemas/index.js';
import { prepareTerms, presentTerms, diffTerms } from '../../domain/terms.js';
import { structureWarnings } from '../../domain/termRules.js';

/**
 * §1.2 — Structures and their versions.
 *
 * A structure is quoted, counter-quoted, negotiated and firmed. All of those
 * are versions of one entity, not rows in five different tables, so the
 * negotiation history IS the version chain and diffing any two states is one
 * generic function over `terms`.
 */
const router = Router();
router.use(authenticate);

const STATUSES = ['EXPIRING', 'SUBMITTED', 'QUOTED', 'ALTERNATIVE', 'NEGOTIATED', 'FOT', 'BOUND'];
const ORIGINS = ['BROKER', 'REINSURER', 'CEDANT'];

const structureSchema = z.object({
  label: z.string().min(1),
  treaty_type: z.enum(TREATY_TYPES),
  cob: z.string().min(1),
  position: z.number().int().min(0).optional(),
  // The opening version. A structure without terms is an empty promise, so the
  // first version is created with it rather than left to a second call.
  status: z.enum(STATUSES).default('SUBMITTED'),
  origin: z.enum(ORIGINS).default('BROKER'),
  origin_party_id: z.string().uuid().nullish(),
  terms: z.record(z.any()),
});

const versionSchema = z.object({
  status: z.enum(STATUSES),
  origin: z.enum(ORIGINS),
  origin_party_id: z.string().uuid().nullish(),
  parent_version_id: z.string().uuid().nullish(),
  terms: z.record(z.any()),
});

/** Present a version with its money rendered back to decimal strings. */
async function present(version, schemaCache = new Map()) {
  if (!version.term_schema_id) return version;
  if (!schemaCache.has(version.term_schema_id)) {
    schemaCache.set(version.term_schema_id, await termSchemaById(version.term_schema_id));
  }
  const schema = schemaCache.get(version.term_schema_id);
  return { ...version, terms_display: presentTerms(version.terms, schema) };
}

/**
 * §1.2 requires origin_party_id to name the reinsurer for a REINSURER version
 * and to be null otherwise. The table enforces it; this turns the constraint
 * violation into a message that says what to fix.
 */
function assertOriginParty(origin, partyId) {
  if (origin === 'REINSURER' && !partyId) {
    throw new ConflictError('A REINSURER version must name the reinsurer that proposed it');
  }
  if (origin !== 'REINSURER' && partyId) {
    throw new ConflictError(`origin_party_id belongs only to a REINSURER version, not ${origin}`);
  }
}

// ---------------------------------------------------------------------------
// Structures under a contract year
// ---------------------------------------------------------------------------

/**
 * The structures on a year, each with its latest version.
 *
 * `?include_expiring=1` also returns the prior year's structures, read through
 * `prior_contract_year_id` (§1.1, M5). They are read, never copied: the link is
 * the point, and a copy would let the two drift apart.
 */
router.get(
  '/contract-years/:id/structures',
  asyncHandler(async (req, res) => {
    const { rows: year } = await query(
      'SELECT id, prior_contract_year_id FROM contract_year WHERE id = $1', [req.params.id],
    );
    if (!year[0]) throw new NotFoundError('Contract year');

    const cache = new Map();
    const current = await loadStructures(req.params.id, cache);

    let expiring = null;
    if (req.query.include_expiring) {
      expiring = year[0].prior_contract_year_id
        ? {
          contract_year_id: year[0].prior_contract_year_id,
          source: 'PRIOR_YEAR',
          structures: await loadStructures(year[0].prior_contract_year_id, cache),
        }
        // No linked predecessor: M5 says expiring structures are then entered or
        // extracted, which means a version with status EXPIRING on this year.
        : { contract_year_id: null, source: 'UNLINKED', structures: [] };
    }

    res.json({
      contract_year_id: req.params.id,
      structures: current,
      expiring,
      // Placement-level checks that span sibling structures. Warnings, not
      // errors: a non-contiguous tower is a real thing a broker may place
      // deliberately, so it is worth surfacing and wrong to forbid.
      warnings: structureWarnings(current),
    });
  }),
);

async function loadStructures(contractYearId, cache) {
  const { rows } = await query(
    `SELECT s.*,
            (SELECT row_to_json(v) FROM (
               SELECT * FROM structure_version sv
               WHERE sv.structure_id = s.id
               ORDER BY sv.version_no DESC LIMIT 1
             ) v) AS latest_version,
            (SELECT COUNT(*)::int FROM structure_version sv WHERE sv.structure_id = s.id) AS version_count
     FROM structure s
     WHERE s.contract_year_id = $1
     ORDER BY s.position, s.label`,
    [contractYearId],
  );
  return Promise.all(rows.map(async (r) => ({
    ...r,
    latest_version: r.latest_version ? await present(r.latest_version, cache) : null,
  })));
}

router.post(
  '/contract-years/:id/structures',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(structureSchema, req.body);
    assertOriginParty(body.origin, body.origin_party_id);

    const result = await withTransaction(async (client) => {
      const { rows: year } = await client.query(
        'SELECT id FROM contract_year WHERE id = $1', [req.params.id],
      );
      if (!year[0]) throw new NotFoundError('Contract year');

      const schema = await currentTermSchema(body.treaty_type, body.cob, client);
      const terms = prepareTerms(body.terms, schema);

      const { rows: structure } = await client.query(
        `INSERT INTO structure (contract_year_id, label, basis, treaty_type, cob, position, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.params.id, body.label, schema.basis, body.treaty_type, body.cob,
          body.position ?? 0, req.user.id],
      );

      const { rows: version } = await client.query(
        `INSERT INTO structure_version
           (structure_id, version_no, status, origin, origin_party_id, terms, term_schema_id, created_by)
         VALUES ($1,1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [structure[0].id, body.status, body.origin, body.origin_party_id || null,
          terms, schema.id, req.user.id],
      );

      await audit({
        entityType: 'structure', entityId: structure[0].id, action: 'create',
        userId: req.user.id, after: structure[0],
      }, client);
      await audit({
        entityType: 'structure_version', entityId: version[0].id, action: 'create',
        userId: req.user.id, after: version[0],
      }, client);

      return { ...structure[0], versions: [version[0]] };
    });
    res.status(201).json(result);
  }),
);

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------
router.get(
  '/structures/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.*, cy.year_label, c.name AS contract_name, ced.name AS cedant_name
       FROM structure s
       JOIN contract_year cy ON cy.id = s.contract_year_id
       JOIN contract c ON c.id = cy.contract_id
       JOIN cedant ced ON ced.id = c.cedant_id
       WHERE s.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw new NotFoundError('Structure');

    const { rows: versions } = await query(
      `SELECT sv.*, m.name AS origin_party_name
       FROM structure_version sv
       LEFT JOIN market m ON m.id = sv.origin_party_id
       WHERE sv.structure_id = $1 ORDER BY sv.version_no`,
      [req.params.id],
    );
    const cache = new Map();
    res.json({
      ...rows[0],
      versions: await Promise.all(versions.map((v) => present(v, cache))),
    });
  }),
);

/**
 * Add a version. This is the single write path for every state a structure
 * passes through — a broker's submission, a reinsurer's quote, a reinsurer's
 * alternative, a negotiated counter, the firm order. §1.2 is the whole reason
 * there is one endpoint here rather than five.
 */
router.post(
  '/structures/:id/versions',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(versionSchema, req.body);
    assertOriginParty(body.origin, body.origin_party_id);

    const row = await withTransaction(async (client) => {
      const { rows: structure } = await client.query(
        'SELECT * FROM structure WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      if (!structure[0]) throw new NotFoundError('Structure');

      if (body.parent_version_id) {
        const { rows: parent } = await client.query(
          'SELECT structure_id FROM structure_version WHERE id = $1', [body.parent_version_id],
        );
        if (!parent[0]) throw new NotFoundError('Parent version');
        if (parent[0].structure_id !== req.params.id) {
          throw new ConflictError(
            'A version is derived from another version of the same structure; the chain is that structure\'s history',
          );
        }
      }

      const schema = await currentTermSchema(structure[0].treaty_type, structure[0].cob, client);
      const terms = prepareTerms(body.terms, schema);

      const { rows: next } = await client.query(
        'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM structure_version WHERE structure_id = $1',
        [req.params.id],
      );

      const { rows } = await client.query(
        `INSERT INTO structure_version
           (structure_id, version_no, status, origin, origin_party_id, parent_version_id,
            terms, term_schema_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.params.id, next[0].n, body.status, body.origin, body.origin_party_id || null,
          body.parent_version_id || null, terms, schema.id, req.user.id],
      );

      await audit({
        entityType: 'structure_version', entityId: rows[0].id, action: 'create',
        userId: req.user.id, after: rows[0],
        detail: { structure_id: req.params.id, version_no: next[0].n, status: body.status },
      }, client);
      return rows[0];
    });
    res.status(201).json(row);
  }),
);

/**
 * Diff any two versions — §1.2's first consequence, "diffing any two states is
 * one generic function over `terms`". The two need not share a structure: an
 * expiring layer on last year's programme diffs against this year's submission
 * the same way a submission diffs against a reinsurer's counter.
 */
router.get(
  '/structure-versions/:id/diff/:otherId',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT sv.*, s.label, s.treaty_type, s.cob, s.contract_year_id, cy.year_label
       FROM structure_version sv
       JOIN structure s ON s.id = sv.structure_id
       JOIN contract_year cy ON cy.id = s.contract_year_id
       WHERE sv.id = ANY($1)`,
      [[req.params.id, req.params.otherId]],
    );
    const from = rows.find((r) => r.id === req.params.id);
    const to = rows.find((r) => r.id === req.params.otherId);
    if (!from || !to) throw new NotFoundError('Structure version');

    const cache = new Map();
    res.json({
      from: await describe(from, cache),
      to: await describe(to, cache),
      changes: diffTerms(from.terms, to.terms),
    });
  }),
);

async function describe(v, cache) {
  const presented = await present(v, cache);
  return {
    id: v.id,
    structure_id: v.structure_id,
    label: v.label,
    year_label: v.year_label,
    version_no: v.version_no,
    status: v.status,
    origin: v.origin,
    terms: presented.terms_display ?? v.terms,
  };
}

/** The term schemas in force (§1.3, D9) — what a structure can be written as. */
router.get(
  '/term-schemas',
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, treaty_type, cob, version, basis, money_paths, schema
       FROM term_schema WHERE retired_at IS NULL ORDER BY treaty_type`,
    );
    res.json(rows);
  }),
);

export default router;
