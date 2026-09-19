import { query } from '../db/pool.js';

/**
 * Append-only audit log (§2.2): actor, timestamp, before, after.
 *
 * The before/after pair is the point. KYC status and security ratings are the
 * fields §2.2 singles out as ones people later need to prove the state of, and
 * an after-only log cannot answer "what was it before?".
 *
 * `detail` is unchanged and still optional, so every call site that predates
 * before/after keeps working exactly as it did.
 */
export async function audit(
  { entityType, entityId, action, userId, before = null, after = null, detail = {} },
  client = null,
) {
  const runner = client || { query };
  await runner.query(
    `INSERT INTO audit_event (entity_type, entity_id, action, user_id, detail, before_state, after_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entityType,
      entityId == null ? null : String(entityId),
      action,
      userId || null,
      detail,
      before === null ? null : JSON.stringify(auditable(before)),
      after === null ? null : JSON.stringify(auditable(after)),
    ],
  );
}

/**
 * Fields that must never reach the audit log. The log is readable by oversight
 * roles, so a password hash sitting in it is a credential in a second place.
 */
const REDACTED = new Set(['password_hash']);

export function auditable(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (!REDACTED.has(k)) out[k] = v;
  }
  return out;
}

/** Which fields moved between two audited states. Used by the history view. */
export function changedFields(before, after) {
  if (!before || !after) return null;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      changed.push({ field: k, from: before[k] ?? null, to: after[k] ?? null });
    }
  }
  return changed;
}
