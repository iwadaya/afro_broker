import { PROPERTY_CAT_XL } from './propertyCatXl.js';
import { PROPERTY_SURPLUS } from './propertySurplus.js';
import { query } from '../../db/pool.js';
import { NotFoundError } from '../../lib/errors.js';

/**
 * The term schema registry (§1.3, D9).
 *
 * D9: "Phase 2 builds term JSON Schemas for exactly these two. Nothing else,
 * until they are in production use." Second and subsequent treaty types of a
 * shape already built are cheap; the first of each shape is not.
 *
 * Schemas live in the `term_schema` table so adding a treaty type is a config
 * change rather than a deploy, and so a structure written last year can still
 * be re-validated against the rules that applied to it. These definitions are
 * the seed for that table, not the runtime source.
 */

export const SHIPPED_SCHEMAS = [PROPERTY_CAT_XL, PROPERTY_SURPLUS];

export const TREATY_TYPES = SHIPPED_SCHEMAS.map((s) => s.treaty_type);

/**
 * Install the shipped schemas. Idempotent on (treaty_type, cob, version): an
 * existing row is left exactly as it is, because a schema that has already
 * validated a structure must not change underneath it.
 *
 * That idempotence has a sharp edge. Editing a shipped definition without
 * bumping its version is a silent no-op against any database that already
 * holds it — the code says one thing, the database enforces another, and
 * nothing complains. So the stored row is compared against the definition and
 * any divergence is reported rather than ignored.
 *
 * Returns `{ installed, drifted }`. Drift is not thrown on: a running
 * deployment should not fail to boot over it, and the database is right — it
 * is the schema that validated the structures already in it. Bump the version
 * and add the new one alongside.
 */
export async function installTermSchemas(runner = { query }) {
  const installed = [];
  const drifted = [];

  for (const def of SHIPPED_SCHEMAS) {
    const { rows } = await runner.query(
      `INSERT INTO term_schema (treaty_type, cob, version, basis, schema, money_paths, fot_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (treaty_type, cob, version) DO NOTHING
       RETURNING *`,
      [def.treaty_type, def.cob, def.version, def.basis, def.schema, def.money_paths,
        JSON.stringify(def.fot_required ?? [])],
    );

    if (rows[0]) {
      installed.push(rows[0]);
      continue;
    }

    const { rows: existing } = await runner.query(
      'SELECT * FROM term_schema WHERE treaty_type = $1 AND cob = $2 AND version = $3',
      [def.treaty_type, def.cob, def.version],
    );
    if (existing[0] && !sameDefinition(existing[0], def)) {
      drifted.push({
        treaty_type: def.treaty_type,
        cob: def.cob,
        version: def.version,
        message:
          `Shipped ${def.treaty_type}/${def.cob} v${def.version} differs from the stored schema. `
          + 'The stored one is what validated the existing structures and stays in force; '
          + 'ship the change as a new version instead of editing this one.',
      });
    }
  }

  return { installed, drifted };
}

function sameDefinition(row, def) {
  return canonicalJson(row.schema) === canonicalJson(def.schema)
    && canonicalJson(row.money_paths) === canonicalJson(def.money_paths)
    && canonicalJson(row.fot_required) === canonicalJson(def.fot_required ?? [])
    && row.basis === def.basis;
}

/**
 * Stringify with object keys sorted, so the comparison is about content rather
 * than byte order. JSONB does not preserve the key order it was given, so a
 * plain JSON.stringify comparison reports drift on every boot against a
 * database that is in fact identical — and a warning that always fires is one
 * everybody learns to scroll past.
 *
 * Array order is preserved, because in these schemas it is meaningful:
 * `allOf` and the sliding-scale bands are sequences, not sets.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The schema in force for a (treaty_type, cob) pair. */
export async function currentTermSchema(treatyType, cob, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT * FROM term_schema
     WHERE treaty_type = $1 AND cob = $2 AND retired_at IS NULL`,
    [treatyType, cob],
  );
  if (!rows[0]) {
    throw new NotFoundError(
      `Term schema for ${treatyType} / ${cob} (D9 ships Property Cat XL and Property Surplus only)`,
    );
  }
  return rows[0];
}

/** A specific schema by id — how an old version is re-validated years later. */
export async function termSchemaById(id, runner = { query }) {
  const { rows } = await runner.query('SELECT * FROM term_schema WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Term schema');
  return rows[0];
}
