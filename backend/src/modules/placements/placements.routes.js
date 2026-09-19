import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate, pageParams } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as svc from './placements.service.js';
import { PLACEMENT_STATUS } from '../../domain/statusMachine.js';

const router = Router();
router.use(authenticate);

/** Reinstatements are a count (1-10) or unlimited — never a free-form string. */
const REINSTATEMENTS = z.enum([...Array.from({ length: 10 }, (_, i) => String(i + 1)), 'UNLIMITED']);

const placementSchema = z.object({
  reference: z.string().min(1).optional(),
  cedant_id: z.string().uuid(),
  class: z.string().min(1),
  inception: z.string(),
  expiry: z.string(),
  currency: z.string().min(1),
  renewal_of: z.string().uuid().nullable().optional(),
  est_gwp: z.number().nonnegative().nullable().optional(),
  notes: z.string().optional(),
  structure_cobs: z.record(
    z.string(),
    z.array(z.object({
      cob: z.string(),
      limit: z.union([z.number(), z.null()]).optional(),
      layers: z.array(z.boolean()).optional(),
      // Cells ticked by hand, which the underwriting-limit rule leaves alone.
      manual: z.array(z.boolean()).optional(),
      // An aggregate XL's inner limit / deductible per class.
      inner_limit: z.union([z.number(), z.null()]).optional(),
      inner_deductible: z.union([z.number(), z.null()]).optional(),
    })),
  ).optional(),
  expiring_structure: z.record(z.string(), z.any()).optional(),
  quote_structures: z.array(z.record(z.string(), z.any())).optional(),
  retentions: z.union([
    z.array(z.record(z.string(), z.any())),
    z.record(z.string(), z.any()),
  ]).optional(),
});

const layerSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['QS', 'Surplus', 'XoL', 'Fac']),
  attachment: z.number().nonnegative().optional(),
  limit_amt: z.number().nonnegative().nullable().optional(),
  section_pct: z.number().min(0).max(100).optional(),
  order_pct: z.number().min(0).max(100).optional(),
  premium100: z.number().nonnegative().optional(),
  brokerage_pct: z.number().min(0).max(100).optional(),
  currency: z.string().min(1),
  technical_ref: z.string().nullable().optional(),
  position: z.number().int().optional(),
  risk_cover: z.boolean().optional(),
  cat_cover: z.boolean().optional(),
  // Geographic scope: a region the layer is restricted to, or null for worldwide.
  region: z.string().nullable().optional(),
  reinstatements: REINSTATEMENTS.nullable().optional(),
  reinstatement_pct: z.number().min(0).nullable().optional(),
  egnpi: z.number().nonnegative().nullable().optional(),
  rate_pct: z.number().min(0).nullable().optional(),
  aad: z.number().nonnegative().nullable().optional(),
});

/**
 * Other spellings a cedant's domicile may be stored under, by country code —
 * the register's DOMICILE_ALIASES, so a filter on "United Kingdom" finds a
 * cedant recorded as "UK".
 */
const DOMICILE_ALIASES = { GB: ['uk', 'great britain'], US: ['usa', 'united states of america'], AE: ['uae'] };

/** Every spelling a country filter has to match a domicile against. */
async function domicileSpellings(country) {
  const given = String(country || '').trim().toLowerCase();
  if (!given) return [];
  const spellings = new Set([given]);
  const { rows } = await query(
    `SELECT country_name, country_code FROM public.country
      WHERE lower(country_name) = $1 OR lower(country_code) = $1 LIMIT 1`,
    [given],
  ).catch(() => ({ rows: [] }));
  if (rows[0]) {
    spellings.add(String(rows[0].country_name).toLowerCase());
    spellings.add(String(rows[0].country_code).toLowerCase());
    for (const alias of DOMICILE_ALIASES[rows[0].country_code] || []) spellings.add(alias);
  }
  for (const [code, aliases] of Object.entries(DOMICILE_ALIASES)) {
    if (aliases.includes(given)) spellings.add(code.toLowerCase());
  }
  return [...spellings];
}

/**
 * The WHERE clause the register and the renewal wizard search with: country
 * (the cedant's domicile), cedant, treaty type, class of business, status,
 * the year renewed, and free text over reference, class and cedant name.
 * The same filters serve the list and the facets, so a cascade — country,
 * then cedant, then treaty type, then class — narrows exactly as the list.
 */
async function searchFilters(q, { skip = [] } = {}) {
  const params = [];
  const filters = [];
  const add = (sql, value) => { params.push(value); filters.push(sql.replace('?', `$${params.length}`)); };
  if (q.status && !skip.includes('status')) add('p.status = ?', q.status);
  if (q.cedant_id && !skip.includes('cedant_id')) add('p.cedant_id = ?', q.cedant_id);
  if (q.renewal_of) add('p.renewal_of = ?', q.renewal_of);
  if (q.country && !skip.includes('country')) {
    const spellings = await domicileSpellings(q.country);
    add('lower(btrim(COALESCE(c.domicile, \'\'))) = ANY(?::text[])', spellings);
  }
  if (q.treaty_type && !skip.includes('treaty_type')) add('lower(p.treaty_type) = ?', String(q.treaty_type).toLowerCase());
  if (q.class && !skip.includes('class')) {
    // A class of business the placement names — one of them, or the whole string.
    const cls = String(q.class).toLowerCase();
    params.push(cls);
    filters.push(`(lower(p.class_of_business) = $${params.length} OR lower(p.class) = $${params.length}
      OR $${params.length} = ANY(string_to_array(lower(COALESCE(p.class_of_business, '')), ' / ')))`);
  }
  if (q.q && String(q.q).trim()) {
    add('(p.reference ILIKE ? OR p.class ILIKE ? OR c.name ILIKE ?)'.replaceAll('?', `$${params.length + 1}`), `%${String(q.q).trim()}%`);
  }
  return { params, where: filters.length ? `WHERE ${filters.join(' AND ')}` : '' };
}

const LIST_SELECT = `
  SELECT p.*, c.name AS cedant_name, c.domicile AS cedant_domicile,
         r.reference AS renewal_of_reference,
         (SELECT COUNT(*)::int FROM placement n WHERE n.renewal_of = p.id) AS renewed_by_count
    FROM placement p
    JOIN cedant c ON c.id = p.cedant_id
    LEFT JOIN placement r ON r.id = p.renewal_of`;

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const { params, where } = await searchFilters(req.query);
    params.push(limit, offset);
    const { rows } = await query(
      `${LIST_SELECT} ${where} ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(rows);
  }),
);

/**
 * The register's and the renewal wizard's dropdowns: the countries, cedants,
 * treaty types and classes of business the book holds, each narrowed by the
 * other filters given — pick a country and the cedants are that country's,
 * pick a cedant and the treaty types are what it has placed.
 */
router.get(
  '/facets',
  asyncHandler(async (req, res) => {
    const facet = async (skip, select, groupBy, orderBy = groupBy) => {
      const { params, where } = await searchFilters(req.query, { skip: [skip] });
      const { rows } = await query(
        `SELECT ${select}, COUNT(*)::int AS count FROM placement p JOIN cedant c ON c.id = p.cedant_id ${where}
          GROUP BY ${groupBy} ORDER BY ${orderBy}`,
        params,
      );
      return rows;
    };
    const [domiciles, cedants, treatyTypes, classes] = await Promise.all([
      facet('country', 'c.domicile AS domicile', 'c.domicile'),
      facet('cedant_id', 'c.id, c.name, c.domicile', 'c.id, c.name, c.domicile', 'c.name, c.id'),
      facet('treaty_type', 'p.treaty_type AS name', 'p.treaty_type'),
      facet('class', 'p.class_of_business AS cob', 'p.class_of_business'),
    ]);
    // Domiciles are free text; read each through the country lookups so
    // "UK" and "United Kingdom" are one country.
    const { rows: countries } = await query(
      'SELECT country_name AS name, country_code AS code FROM public.country',
    ).catch(() => ({ rows: [] }));
    const countryOf = (domicile) => {
      const d = String(domicile || '').trim().toLowerCase();
      if (!d) return null;
      const alias = Object.entries(DOMICILE_ALIASES).find(([, names]) => names.includes(d))?.[0];
      return countries.find((c) => c.name.toLowerCase() === d || c.code.toLowerCase() === d || (alias && c.code === alias))
        || { name: String(domicile).trim(), code: null };
    };
    const byCountry = new Map();
    for (const r of domiciles) {
      const c = countryOf(r.domicile);
      if (!c) continue;
      const key = c.code || c.name;
      if (!byCountry.has(key)) byCountry.set(key, { name: c.name, code: c.code, count: 0 });
      byCountry.get(key).count += r.count;
    }
    const byClass = new Map();
    for (const r of classes) {
      for (const cob of String(r.cob || '').split(' / ').map((s) => s.trim()).filter(Boolean)) {
        byClass.set(cob, (byClass.get(cob) || 0) + r.count);
      }
    }
    res.json({
      countries: [...byCountry.values()].sort((a, b) => a.name.localeCompare(b.name)),
      cedants: cedants.map((r) => ({ id: r.id, name: r.name, domicile: r.domicile, count: r.count })),
      treaty_types: treatyTypes.filter((r) => r.name).map((r) => ({ name: r.name, count: r.count })),
      classes: [...byClass.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }),
);

router.post(
  '/',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(placementSchema, req.body);
    const placement = await svc.createPlacement(body, req.user.id);
    res.status(201).json(placement);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await svc.getPlacementWithLayers(req.params.id));
  }),
);

router.patch(
  '/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(placementSchema.partial(), req.body);
    res.json(await svc.updatePlacement(req.params.id, body, req.user.id));
  }),
);

router.post(
  '/:id/transition',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ status: z.enum(Object.values(PLACEMENT_STATUS)) }), req.body);
    res.json(await svc.transitionPlacement(req.params.id, body.status, req.user.id));
  }),
);

router.post(
  '/:id/renew',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(
      z.object({
        reference: z.string().optional(),
        inception: z.string().optional(),
        expiry: z.string().optional(),
        cedant_id: z.string().uuid().optional(),
      }),
      req.body || {},
    );
    const renewal = await svc.cloneForRenewal(req.params.id, body, req.user.id);
    res.status(201).json(renewal);
  }),
);

// ---- Layers nested under placement ----
router.get(
  '/:id/layers',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM layer WHERE placement_id = $1 ORDER BY position, created_at',
      [req.params.id],
    );
    res.json(rows);
  }),
);

router.post(
  '/:id/layers',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(layerSchema, req.body);
    res.status(201).json(await svc.createLayer(req.params.id, body, req.user.id));
  }),
);

export default router;
