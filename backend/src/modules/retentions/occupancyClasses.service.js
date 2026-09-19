import { query, withTransaction } from '../../db/pool.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { buildUpdate, defined } from '../../lib/sql.js';
import { audit } from '../../lib/audit.js';

const COLUMNS = 'id, code, name, description, capacity_pct, occupancies, position, active, created_at, updated_at';

/** Trim the match terms, drop blanks, and fold duplicates (case-insensitively). */
function cleanTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const term of terms || []) {
    const trimmed = String(term).trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Columns for an insert/update, with the text fields trimmed. */
function fieldsOf(input) {
  return defined({
    code: input.code === undefined ? undefined : input.code.trim(),
    name: input.name === undefined ? undefined : input.name.trim(),
    description: input.description === undefined ? undefined : (input.description?.trim() || null),
    capacity_pct: input.capacity_pct,
    occupancies: input.occupancies === undefined ? undefined : cleanTerms(input.occupancies),
    position: input.position,
    active: input.active,
  });
}

/** A duplicate code would make grading ambiguous, so say so plainly. */
function asConflict(err, code) {
  if (err.code === '23505') return new ConflictError(`An occupancy class with code "${code}" already exists`);
  return err;
}

/** The grading table, in the order it is read. */
export async function listClasses(runner = { query }) {
  const { rows } = await runner.query(`SELECT ${COLUMNS} FROM occupancy_class ORDER BY position, upper(code)`);
  return rows;
}

async function byId(id, runner = { query }) {
  const { rows } = await runner.query(`SELECT ${COLUMNS} FROM occupancy_class WHERE id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError('Occupancy class');
  return rows[0];
}

async function insert(input, runner) {
  const fields = fieldsOf(input);
  const keys = Object.keys(fields);
  const { rows } = await runner.query(
    `INSERT INTO occupancy_class (${keys.join(', ')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${COLUMNS}`,
    keys.map((k) => fields[k]),
  );
  return rows[0];
}

export async function createClass(input, userId, runner = { query }) {
  const { rows: last } = await runner.query('SELECT COALESCE(MAX(position), 0) AS max FROM occupancy_class');
  try {
    const created = await insert({ ...input, position: input.position ?? Number(last[0].max) + 1 }, runner);
    await audit({ entityType: 'occupancy_class', entityId: created.id, action: 'create', userId, detail: { code: created.code } }, runner);
    return created;
  } catch (err) {
    throw asConflict(err, input.code);
  }
}

export async function updateClass(id, input, userId, runner = { query }) {
  const before = await byId(id, runner);
  const fields = fieldsOf(input);
  if (!Object.keys(fields).length) throw new ValidationError('No fields to update');

  const { text, values, nextIndex } = buildUpdate(fields);
  try {
    const { rows } = await runner.query(
      `UPDATE occupancy_class SET ${text}, updated_at = now() WHERE id = $${nextIndex} RETURNING ${COLUMNS}`,
      [...values, id],
    );
    await audit({
      entityType: 'occupancy_class', entityId: id, action: 'update', userId,
      detail: { from: { code: before.code, capacity_pct: before.capacity_pct }, changed: Object.keys(fields) },
    }, runner);
    return rows[0];
  } catch (err) {
    throw asConflict(err, fields.code ?? before.code);
  }
}

export async function deleteClass(id, userId, runner = { query }) {
  const existing = await byId(id, runner);
  await runner.query('DELETE FROM occupancy_class WHERE id = $1', [id]);
  await audit({ entityType: 'occupancy_class', entityId: id, action: 'delete', userId, detail: { code: existing.code } }, runner);
  return existing;
}

/**
 * Replace the whole table in one transaction — what the editor saves. Rows
 * carrying an id are updated, new rows are inserted, anything left out is
 * removed, and `position` follows the order given.
 *
 * Codes are parked out of the way before the update pass, so the table can be
 * re-lettered in a single save (swapping A and B, say) without tripping the
 * unique index halfway through.
 */
export async function replaceClasses(classes, userId) {
  const seen = new Set();
  for (const k of classes) {
    const key = k.code.trim().toUpperCase();
    if (seen.has(key)) throw new ConflictError(`Duplicate occupancy class code "${k.code.trim()}"`);
    seen.add(key);
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id FROM occupancy_class');
    const existing = new Set(rows.map((r) => r.id));
    const kept = classes.map((k) => k.id).filter(Boolean);
    for (const id of kept) {
      if (!existing.has(id)) throw new NotFoundError('Occupancy class');
    }

    const removed = [...existing].filter((id) => !kept.includes(id));
    for (const id of removed) await deleteClass(id, userId, client);

    if (kept.length) {
      await client.query("UPDATE occupancy_class SET code = '~' || id::text WHERE id = ANY($1)", [kept]);
    }

    let created = 0;
    for (const [i, k] of classes.entries()) {
      const row = { ...k, position: i + 1 };
      if (k.id) await updateClass(k.id, row, userId, client);
      else { await createClass(row, userId, client); created += 1; }
    }

    await audit({
      entityType: 'occupancy_class', entityId: null, action: 'table.replace', userId,
      detail: { total: classes.length, created, updated: kept.length, deleted: removed.length },
    }, client);
    return listClasses(client);
  });
}
