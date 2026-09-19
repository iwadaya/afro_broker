// server/src/broking/audit.js — field-level diffs → bk_audit (one row per write,
// written on the SAME transaction client as the mutation, so a failed audit rolls
// the write back — the Universe services/audit.js "critical" contract).

const norm = (v) => {
  if (v === undefined || v === '') return null;
  if (v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v) || typeof v === 'object') return v;
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : s; }
  return s;
};
const same = (a, b) => {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) < 1e-9;
  return JSON.stringify(x) === JSON.stringify(y);
};

/**
 * Compare two flat records and return { "<prefix>.<key>": { from, to } } for every
 * key whose value changed. Keys are the union of both sides; `ignore` skips
 * bookkeeping columns.
 */
export function diffRecords(before = {}, after = {}, prefix = '', ignore = ['updated_at', 'created_at', 'row_version']) {
  const changes = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (ignore.includes(k)) continue;
    const from = before?.[k], to = after?.[k];
    if (!same(from, to)) changes[prefix ? `${prefix}.${k}` : k] = { from: norm(from), to: norm(to) };
  }
  return changes;
}

/** Diff a list-valued slice (slides, layers, classes) as one entry when it changed. */
export function diffList(before, after, key) {
  const a = JSON.stringify(before ?? []), b = JSON.stringify(after ?? []);
  return a === b ? {} : { [key]: { from: before ?? [], to: after ?? [] } };
}

/**
 * Append the audit row. `client` MUST be the mutation's transaction client.
 * diff = { action, changes, ...meta }.
 */
export async function writeAudit(client, { contractId, umr, userId, action, changes = {}, meta = {} }) {
  await client.query(
    `INSERT INTO public.bk_audit (contract_id, umr, user_id, diff) VALUES ($1, $2, $3, $4::jsonb)`,
    [contractId, umr, userId || null, JSON.stringify({ action, changes, ...meta })],
  );
}
