// Reference data lookups — the lists behind the Treaty Detail dropdowns,
// served exactly as the Universe modelling tool's lookups.js serves them:
// brokers, treaty types, classes of business, and the generic ref lists
// (country, currency), each as { id, name, code? } rows of the active entries,
// behind a short server-side cache that DELETE /ref/cache clears.
//
// The loaders are exported on their own so a server-side reader of the same
// lists (the quick renewal pack's AI intake, which constrains the model to
// the dropdowns' rows) sees exactly what the dropdowns show.
import { Router } from 'express';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { NotFoundError } from '../../lib/errors.js';

const router = Router();
router.use(authenticate);

const REF_TTL_MS = 5 * 60 * 1000; // 5 minutes, as the modelling tool caches

// ── In-process JSON cache (the tool's httpCache jsonCache, keyed "ref:…") ──
const cache = new Map();

export function invalidateRefCache(prefix = 'ref:') {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

async function sendRef(res, key, loader) {
  // Tests reset the database between cases, so nothing may be served stale there.
  const cacheable = process.env.NODE_ENV !== 'test';
  const hit = cacheable ? cache.get(`ref:${key}`) : null;
  if (hit && hit.expires > Date.now()) return res.json(hit.body);
  const body = await loader();
  if (cacheable) cache.set(`ref:${key}`, { body, expires: Date.now() + REF_TTL_MS });
  return res.json(body);
}

// ── The loaders: one per list, each the rows the dropdown shows ────────────

/** Brokers: { id, name }. */
export async function loadBrokers() {
  const { rows } = await query(
    'SELECT broker_id AS id, broker_name AS name FROM public.brokers WHERE is_active IS NOT FALSE ORDER BY broker_name',
  );
  return rows;
}

/** Treaty types: { id, name, category } off the canonical singular table. */
export async function loadTreatyTypes() {
  const { rows } = await query(
    'SELECT treaty_type_id AS id, treaty_type AS name, category FROM public.treaty_type WHERE is_active IS NOT FALSE ORDER BY category, treaty_type',
  );
  return rows;
}

/** Classes of business: { id, name, code }. */
export async function loadClassesOfBusiness() {
  const { rows } = await query(
    `SELECT class_of_business_id AS id, class_of_business AS name, code
       FROM public.class_of_business
      WHERE is_active IS NOT FALSE
      ORDER BY class_of_business`,
  );
  return rows;
}

/**
 * A generic ref list (country, currency): the ref_list table first, which
 * may be empty, then the direct table behind the key. Empty for a key
 * nothing answers to.
 */
export async function loadRefList(key) {
  const { rows: listRows } = await query('SELECT list_id FROM public.ref_list WHERE list_key = $1 LIMIT 1', [key]);
  if (listRows.length) {
    const { rows } = await query(
      'SELECT item_id AS id, name, code FROM public.ref_list_item WHERE list_id = $1 AND is_active = true ORDER BY sort_order, name',
      [listRows[0].list_id],
    );
    if (rows.length) return rows;
  }

  // Direct table fallback
  if (key === 'country') {
    const { rows } = await query(
      'SELECT country_id AS id, country_name AS name, country_code AS code FROM public.country WHERE is_active IS NOT FALSE ORDER BY country_name',
    );
    return rows;
  }
  if (key === 'currency') {
    const { rows } = await query(
      'SELECT currency_id AS id, currency_code AS name, currency_code AS code FROM public.currency WHERE is_active IS NOT FALSE ORDER BY currency_code',
    );
    return rows;
  }
  return [];
}

// Allow cache busting on demand (e.g. after reference data changes)
router.delete('/ref/cache', (_req, res) => { invalidateRefCache('ref:'); res.json({ ok: true, cleared: true }); });

// Brokers
router.get('/brokers', asyncHandler(async (_req, res) => {
  await sendRef(res, 'brokers', loadBrokers);
}));

// Treaty Types — canonical table (treaty_type singular)
router.get('/treaty-types', asyncHandler(async (_req, res) => {
  await sendRef(res, 'treaty-types', loadTreatyTypes);
}));

// Single country by id
router.get('/countries/:id', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM public.country WHERE country_id = $1', [req.params.id]);
  if (!rows[0]) throw new NotFoundError('Country');
  res.json(rows[0]);
}));

// Class of Business
router.get('/class-of-business', asyncHandler(async (_req, res) => {
  await sendRef(res, 'class-of-business', loadClassesOfBusiness);
}));

// Generic ref lists
router.get('/ref/lists/:key/items', asyncHandler(async (req, res) => {
  const { key } = req.params;
  await sendRef(res, `list:${key}`, () => loadRefList(key));
}));

export default router;
