import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate, pageParams } from '../../lib/http.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { buildUpdate, defined } from '../../lib/sql.js';
import { parseCsv } from '../../lib/csv.js';
import { listMarkets, getMarket, facets, MARKET_TYPES } from './markets.service.js';
import { gatherProfile, isConfigured as intelConfigured } from '../../integrations/marketIntel.js';
import { llmProviders } from '../../lib/llm.js';

/**
 * The market register: every counterparty the broker deals with, split by type
 * into reinsurers (capacity), insurers (the cedant side) and brokers
 * (co-brokers and intermediaries), each carrying its compliance file and its
 * group profile.
 */
const router = Router();
router.use(authenticate);

const contactSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  role: z.string().optional(),
});

const marketSchema = z.object({
  name: z.string().min(1),
  type: z.enum(MARKET_TYPES).optional(),
  group_name: z.string().optional(),
  domicile: z.string().optional(),
  region: z.string().optional(),
  website: z.string().optional(),
  rating: z.string().optional(),
  rating_agency: z.string().optional(),
  rating_outlook: z.enum(['positive', 'stable', 'negative', 'developing']).optional(),
  rating_as_of: z.string().optional(),
  security_status: z.enum(['approved', 'watch', 'declined']).optional(),
  contacts: z.array(contactSchema).optional(),
});

/** `?has_business=true|false` — anything else leaves the filter off. */
function tribool(value) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function optionalNumber(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function requireMarket(id) {
  const { rows } = await query('SELECT * FROM market WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Market');
  return rows[0];
}

// ---- List / facets ----

router.get(
  '/markets',
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const result = await listMarkets({
      type: MARKET_TYPES.includes(req.query.type) ? req.query.type : undefined,
      q: req.query.q || undefined,
      region: req.query.region,
      country: req.query.country ?? req.query.domicile,
      rating: req.query.rating,
      security_status: req.query.security_status,
      kyc_status: req.query.kyc_status,
      has_business: tribool(req.query.has_business),
      role: ['lead', 'follow'].includes(req.query.role) ? req.query.role : undefined,
      min_share: optionalNumber(req.query.min_share),
      min_lead_share: optionalNumber(req.query.min_lead_share),
      min_follow_share: optionalNumber(req.query.min_follow_share),
      sort: req.query.sort,
      limit,
      offset,
    });
    res.set('x-total-count', String(result.total));
    // The list stays an array — the quote board and every existing caller read
    // it that way; the count rides on the header.
    res.json(result.markets);
  }),
);

router.get(
  '/markets/facets',
  asyncHandler(async (req, res) => {
    res.json({
      ...await facets(MARKET_TYPES.includes(req.query.type) ? req.query.type : null),
      market_intel: { configured: intelConfigured() },
    });
  }),
);

router.post(
  '/markets',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(marketSchema, req.body);
    const { rows } = await query(
      `INSERT INTO market (name, type, group_name, domicile, region, website, rating,
                           rating_agency, rating_outlook, rating_as_of, security_status, contacts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [body.name, body.type || 'reinsurer', body.group_name || null, body.domicile || null,
        body.region || null, body.website || null, body.rating || null, body.rating_agency || null,
        body.rating_outlook || null, body.rating_as_of || null,
        body.security_status || 'approved', JSON.stringify(body.contacts || [])],
    );
    await audit({ entityType: 'market', entityId: rows[0].id, action: 'create', userId: req.user.id, detail: { type: rows[0].type } });
    res.status(201).json(rows[0]);
  }),
);

router.get(
  '/markets/:id',
  asyncHandler(async (req, res) => {
    res.json(await getMarket(req.params.id));
  }),
);

router.patch(
  '/markets/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(marketSchema.partial(), req.body);
    const fields = defined({
      name: body.name,
      type: body.type,
      group_name: body.group_name,
      domicile: body.domicile,
      region: body.region,
      website: body.website,
      rating: body.rating,
      rating_agency: body.rating_agency,
      rating_outlook: body.rating_outlook,
      rating_as_of: body.rating_as_of,
      security_status: body.security_status,
      contacts: body.contacts ? JSON.stringify(body.contacts) : undefined,
    });
    if (Object.keys(fields).length === 0) return res.json(await requireMarket(req.params.id));
    fields.updated_at = new Date();
    const upd = buildUpdate(fields);
    const { rows } = await query(
      `UPDATE market SET ${upd.text} WHERE id = $${upd.nextIndex} RETURNING *`,
      [...upd.values, req.params.id],
    );
    if (!rows[0]) throw new NotFoundError('Market');
    await audit({ entityType: 'market', entityId: req.params.id, action: 'update', userId: req.user.id, detail: fields });
    res.json(rows[0]);
  }),
);

// ---- Compliance (KYC + rating) ----
// KYC sign-off is a control, so it sits with the same roles that authorise FOT
// and bind rather than with the broker who is placing the business.
const complianceSchema = z.object({
  kyc_status: z.enum(['not_started', 'in_progress', 'approved', 'expired', 'rejected']).optional(),
  kyc_reviewed_at: z.string().optional(),
  kyc_expires_at: z.string().optional(),
  kyc_notes: z.string().optional(),
  rating: z.string().optional(),
  rating_agency: z.string().optional(),
  rating_outlook: z.enum(['positive', 'stable', 'negative', 'developing']).optional(),
  rating_as_of: z.string().optional(),
  security_status: z.enum(['approved', 'watch', 'declined']).optional(),
});

router.patch(
  '/markets/:id/compliance',
  requireRole('underwriter', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(complianceSchema, req.body);
    await requireMarket(req.params.id);
    const fields = defined({ ...body });
    if (Object.keys(fields).length === 0) return res.json(await getMarket(req.params.id));
    // Record who signed the KYC file off, alongside what they decided.
    if (body.kyc_status) {
      fields.kyc_reviewed_by = req.user.id;
      if (!body.kyc_reviewed_at) fields.kyc_reviewed_at = new Date().toISOString().slice(0, 10);
    }
    fields.updated_at = new Date();
    const upd = buildUpdate(fields);
    await query(
      `UPDATE market SET ${upd.text} WHERE id = $${upd.nextIndex}`,
      [...upd.values, req.params.id],
    );
    await audit({ entityType: 'market', entityId: req.params.id, action: 'compliance_update', userId: req.user.id, detail: body });
    res.json(await getMarket(req.params.id));
  }),
);

// ---- Group profile ----
const profileSchema = z.object({
  overview: z.string().optional(),
  market_position: z.string().optional(),
  strategy: z.string().optional(),
  citations: z.array(z.object({ title: z.string().optional(), url: z.string() })).optional(),
});

router.put(
  '/markets/:id/profile',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(profileSchema, req.body);
    await requireMarket(req.params.id);
    // A hand-written profile is verified by definition — a person typed it.
    const { rows } = await query(
      `INSERT INTO market_profile (market_id, overview, market_position, strategy, citations,
                                   source, verified, verified_by, verified_at, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,'manual',TRUE,$6,now(),$6,now())
       ON CONFLICT (market_id) DO UPDATE SET
         overview = EXCLUDED.overview,
         market_position = EXCLUDED.market_position,
         strategy = EXCLUDED.strategy,
         citations = EXCLUDED.citations,
         source = 'manual',
         verified = TRUE,
         verified_by = EXCLUDED.verified_by,
         verified_at = now(),
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [req.params.id, body.overview || null, body.market_position || null,
        body.strategy || null, JSON.stringify(body.citations || []), req.user.id],
    );
    await audit({ entityType: 'market', entityId: req.params.id, action: 'profile_update', userId: req.user.id });
    res.json(rows[0]);
  }),
);

/** Sign an AI-gathered profile off once it has been checked against sources. */
router.post(
  '/markets/:id/profile/verify',
  requireRole('broker', 'underwriter', 'admin'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE market_profile SET verified = TRUE, verified_by = $2, verified_at = now()
       WHERE market_id = $1 RETURNING *`,
      [req.params.id, req.user.id],
    );
    if (!rows[0]) throw new NotFoundError('Market profile');
    await audit({ entityType: 'market', entityId: req.params.id, action: 'profile_verify', userId: req.user.id });
    res.json(rows[0]);
  }),
);

/**
 * Gather the group profile, news and five-year financials from the internet.
 * Everything it writes is marked `ai` / unverified: it is a research shortcut,
 * not a source of record, and it replaces prior AI-gathered rows rather than
 * overwriting anything a person keyed in.
 */
router.post(
  '/markets/:id/profile/enrich',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const market = await requireMarket(req.params.id);
    let gathered;
    try {
      gathered = await gatherProfile(market, { years: 5 });
    } catch (e) {
      if (e.code !== 'llm_unavailable') throw e;
      // Nothing is written on a failed gather — the profile is left exactly as
      // the broker last had it, with the reason the research could not run.
      return res.status(503).json({
        error: e.message,
        code: e.code,
        attempts: e.attempts,
        providers: llmProviders(),
      });
    }

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO market_profile (market_id, overview, market_position, strategy, citations,
                                     source, verified, gathered_at, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,'ai',FALSE,now(),$6,now())
         ON CONFLICT (market_id) DO UPDATE SET
           overview = EXCLUDED.overview,
           market_position = EXCLUDED.market_position,
           strategy = EXCLUDED.strategy,
           citations = EXCLUDED.citations,
           source = 'ai',
           verified = FALSE,
           verified_by = NULL,
           verified_at = NULL,
           gathered_at = now(),
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [req.params.id, gathered.overview || null, gathered.market_position || null,
          gathered.strategy || null, JSON.stringify(gathered.citations), req.user.id],
      );

      // Replace the previous gather's news, leaving hand-entered items alone.
      await client.query("DELETE FROM market_news WHERE market_id = $1 AND source = 'ai'", [req.params.id]);
      for (const n of gathered.news) {
        await client.query(
          `INSERT INTO market_news (market_id, headline, summary, url, published_at, source, created_by)
           VALUES ($1,$2,$3,$4,$5,'ai',$6)`,
          [req.params.id, n.headline, n.summary, n.url, n.published_at, req.user.id],
        );
      }

      for (const f of gathered.financials) {
        await client.query(
          `INSERT INTO market_financial (market_id, year, currency, gwp, nwp, net_income,
                                         shareholders_equity, total_assets, loss_ratio,
                                         expense_ratio, combined_ratio, roe, source, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ai',$13,now())
           ON CONFLICT (market_id, year) DO UPDATE SET
             currency = EXCLUDED.currency, gwp = EXCLUDED.gwp, nwp = EXCLUDED.nwp,
             net_income = EXCLUDED.net_income, shareholders_equity = EXCLUDED.shareholders_equity,
             total_assets = EXCLUDED.total_assets, loss_ratio = EXCLUDED.loss_ratio,
             expense_ratio = EXCLUDED.expense_ratio, combined_ratio = EXCLUDED.combined_ratio,
             roe = EXCLUDED.roe, source = 'ai', updated_by = EXCLUDED.updated_by, updated_at = now()
           -- A hand-entered year is the source of record; the gather never overwrites it.
           WHERE market_financial.source = 'ai'`,
          [req.params.id, f.year, f.currency, f.gwp, f.nwp, f.net_income, f.shareholders_equity,
            f.total_assets, f.loss_ratio, f.expense_ratio, f.combined_ratio, f.roe, req.user.id],
        );
      }

      await audit({
        entityType: 'market',
        entityId: req.params.id,
        action: 'profile_enrich',
        userId: req.user.id,
        detail: { provider: gathered.provider, model: gathered.model, news: gathered.news.length, years: gathered.financials.length },
      }, client);
    });

    res.json({ ...await getMarket(req.params.id), gather: { provider: gathered.provider, model: gathered.model } });
  }),
);

// ---- News ----
const newsSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().optional(),
  url: z.string().optional(),
  published_at: z.string().optional(),
});

router.post(
  '/markets/:id/news',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(newsSchema, req.body);
    await requireMarket(req.params.id);
    const { rows } = await query(
      `INSERT INTO market_news (market_id, headline, summary, url, published_at, source, created_by)
       VALUES ($1,$2,$3,$4,$5,'manual',$6) RETURNING *`,
      [req.params.id, body.headline, body.summary || null, body.url || null,
        body.published_at || null, req.user.id],
    );
    res.status(201).json(rows[0]);
  }),
);

router.delete(
  '/markets/:id/news/:newsId',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query(
      'DELETE FROM market_news WHERE id = $1 AND market_id = $2',
      [req.params.newsId, req.params.id],
    );
    if (!rowCount) throw new NotFoundError('News item');
    res.status(204).end();
  }),
);

// ---- Underwriter contacts ----
// The named people at a market, and the address a submission goes to. Kept as
// rows rather than in market.contacts so a submission can point at exactly
// which underwriter it was sent to.

const marketContactSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  role: z.string().max(80).optional(),
  is_primary: z.boolean().optional(),
  active: z.boolean().optional(),
});

router.get(
  '/markets/:marketId/contacts',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM market_contact WHERE market_id = $1 ORDER BY is_primary DESC, name',
      [req.params.marketId],
    );
    res.json(rows);
  }),
);

router.post(
  '/markets/:marketId/contacts',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(marketContactSchema, req.body);
    const { rowCount } = await query('SELECT 1 FROM market WHERE id = $1', [req.params.marketId]);
    if (!rowCount) throw new NotFoundError('Market');
    const { rows } = await query(
      `INSERT INTO market_contact (market_id, name, email, role, is_primary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.marketId, body.name, body.email.toLowerCase(),
        body.role || 'underwriter', body.is_primary ?? false, req.user.id],
    );
    await audit({
      entityType: 'market_contact', entityId: rows[0].id, action: 'create', userId: req.user.id,
      detail: { market_id: req.params.marketId, email: rows[0].email },
    });
    res.status(201).json(rows[0]);
  }),
);

router.patch(
  '/market-contacts/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(marketContactSchema.partial(), req.body);
    const fields = defined({
      name: body.name,
      email: body.email ? body.email.toLowerCase() : undefined,
      role: body.role,
      is_primary: body.is_primary,
      active: body.active,
    });
    if (Object.keys(fields).length === 0) {
      const { rows } = await query('SELECT * FROM market_contact WHERE id = $1', [req.params.id]);
      if (!rows[0]) throw new NotFoundError('Underwriter contact');
      return res.json(rows[0]);
    }
    const upd = buildUpdate({ ...fields, updated_at: new Date() });
    const { rows } = await query(
      `UPDATE market_contact SET ${upd.text} WHERE id = $${upd.nextIndex} RETURNING *`,
      [...upd.values, req.params.id],
    );
    if (!rows[0]) throw new NotFoundError('Underwriter contact');
    await audit({ entityType: 'market_contact', entityId: req.params.id, action: 'update', userId: req.user.id, detail: fields });
    res.json(rows[0]);
  }),
);

/** Deactivate rather than delete: a sent submission still names the address. */
router.delete(
  '/market-contacts/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'UPDATE market_contact SET active = FALSE, updated_at = now() WHERE id = $1 RETURNING *',
      [req.params.id],
    );
    if (!rows[0]) throw new NotFoundError('Underwriter contact');
    await audit({ entityType: 'market_contact', entityId: req.params.id, action: 'deactivate', userId: req.user.id });
    res.json(rows[0]);
  }),
);

// ---- Five-year financials ----
const financialSchema = z.object({
  year: z.number().int().min(1900).max(2200),
  currency: z.string().optional(),
  gwp: z.number().nullable().optional(),
  nwp: z.number().nullable().optional(),
  net_income: z.number().nullable().optional(),
  shareholders_equity: z.number().nullable().optional(),
  total_assets: z.number().nullable().optional(),
  loss_ratio: z.number().nullable().optional(),
  expense_ratio: z.number().nullable().optional(),
  combined_ratio: z.number().nullable().optional(),
  roe: z.number().nullable().optional(),
  note: z.string().optional(),
});

const FINANCIAL_COLUMNS = ['currency', 'gwp', 'nwp', 'net_income', 'shareholders_equity',
  'total_assets', 'loss_ratio', 'expense_ratio', 'combined_ratio', 'roe', 'note'];

/** Upsert a set of financial years as the manual source of record. */
async function upsertFinancials(marketId, years, userId) {
  return withTransaction(async (client) => {
    for (const f of years) {
      await client.query(
        `INSERT INTO market_financial (market_id, year, currency, gwp, nwp, net_income,
                                       shareholders_equity, total_assets, loss_ratio,
                                       expense_ratio, combined_ratio, roe, note, source, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'manual',$14,now())
         ON CONFLICT (market_id, year) DO UPDATE SET
           currency = EXCLUDED.currency, gwp = EXCLUDED.gwp, nwp = EXCLUDED.nwp,
           net_income = EXCLUDED.net_income, shareholders_equity = EXCLUDED.shareholders_equity,
           total_assets = EXCLUDED.total_assets, loss_ratio = EXCLUDED.loss_ratio,
           expense_ratio = EXCLUDED.expense_ratio, combined_ratio = EXCLUDED.combined_ratio,
           roe = EXCLUDED.roe, note = EXCLUDED.note, source = 'manual',
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [marketId, f.year, f.currency || 'USD', f.gwp ?? null, f.nwp ?? null, f.net_income ?? null,
          f.shareholders_equity ?? null, f.total_assets ?? null, f.loss_ratio ?? null,
          f.expense_ratio ?? null, f.combined_ratio ?? null, f.roe ?? null, f.note ?? null, userId],
      );
    }
    await audit({
      entityType: 'market', entityId: marketId, action: 'financials_upload',
      userId, detail: { years: years.map((y) => y.year) },
    }, client);
    const { rows } = await client.query(
      'SELECT * FROM market_financial WHERE market_id = $1 ORDER BY year DESC',
      [marketId],
    );
    return rows;
  });
}

router.get(
  '/markets/:id/financials',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM market_financial WHERE market_id = $1 ORDER BY year DESC',
      [req.params.id],
    );
    res.json(rows);
  }),
);

router.put(
  '/markets/:id/financials',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ financials: z.array(financialSchema).min(1).max(50) }), req.body);
    await requireMarket(req.params.id);
    res.json(await upsertFinancials(req.params.id, body.financials, req.user.id));
  }),
);

/**
 * Upload financials as CSV — one row per year, headers matching the column
 * names (`year,currency,gwp,nwp,net_income,...`). Blank cells stay null so a
 * partial upload doesn't wipe figures that were already keyed in.
 */
router.post(
  '/markets/:id/financials/import',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ csv: z.string().min(1) }), req.body);
    await requireMarket(req.params.id);
    const cell = (row, key) => {
      const v = row[key];
      if (v == null || v === '') return null;
      const n = Number(String(v).replace(/[,\s$£€%]/g, ''));
      return Number.isFinite(n) ? n : null;
    };
    const years = parseCsv(body.csv)
      .map((row) => {
        const year = cell(row, 'year');
        if (year == null) return null;
        const parsed = { year, currency: row.currency || 'USD', note: row.note || null };
        for (const col of FINANCIAL_COLUMNS) {
          if (col === 'currency' || col === 'note') continue;
          parsed[col] = cell(row, col);
        }
        return parsed;
      })
      .filter(Boolean);
    if (!years.length) throw new ConflictError('No rows with a `year` column found in the CSV');
    res.json(await upsertFinancials(req.params.id, years, req.user.id));
  }),
);

router.delete(
  '/markets/:id/financials/:year',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const { rowCount } = await query(
      'DELETE FROM market_financial WHERE market_id = $1 AND year = $2',
      [req.params.id, Number(req.params.year)],
    );
    if (!rowCount) throw new NotFoundError('Financial year');
    res.status(204).end();
  }),
);

export default router;
