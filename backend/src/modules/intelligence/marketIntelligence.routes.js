import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { llmProviders } from '../../lib/llm.js';
import { parseYear } from '../dashboards/portfolioBook.js';
import * as intel from './marketIntelligence.service.js';

/**
 * Market intelligence — behind the "Market intelligence" button on
 * Portfolio intelligence: a market by country or region, read from the
 * book, the AI's research of the internet, and the brokers' own visits and
 * notes. See marketIntelligence.service.js for the reading of each.
 *
 * Reading is open to everyone signed in. A broker (or admin) logs trips and
 * notes and runs a gather; a trip or note is its author's to change, or an
 * admin's. Signing a brief off is open to the same roles that verify a
 * counterparty profile.
 */
const router = Router();
router.use(authenticate);

const scopeSchema = z.object({
  scope_type: z.enum(['country', 'region']),
  scope_key: z.string().min(1).max(100),
});
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');

const visitBase = z.object({
  country_code: z.string().min(1).max(100),
  city: z.string().max(200).optional(),
  purpose: z.string().max(2000).optional(),
  start_date: dateStr,
  end_date: dateStr,
  cost_amount: z.number().min(0).optional(),
  cost_currency: z.string().min(3).max(8).optional(),
  cedant_ids: z.array(z.string().uuid()).max(50).optional(),
  notes: z.string().max(20000).optional(),
});

const fileSchema = z.object({ filename: z.string().min(1).max(300), data: z.string().min(1) });
const noteBase = z.object({
  level: z.enum(['cedant', 'country', 'region']),
  cedant_id: z.string().uuid().optional(),
  country_code: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  visit_id: z.string().uuid().nullable().optional(),
  noted_on: dateStr.optional(),
  title: z.string().max(300).optional(),
  body: z.string().max(60000).optional(),
  file: fileSchema.optional(),
});

const scopeOf = (q) => {
  if (!q.scope_type && !q.scope_key) return null;
  const { scope_type, scope_key } = validate(scopeSchema, q);
  return { type: scope_type, key: scope_key };
};

// ---- The map, and one scope in full ----

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await intel.overview());
}));

router.get('/scope', asyncHandler(async (req, res) => {
  const { scope_type, scope_key } = validate(scopeSchema, req.query);
  res.json(await intel.scopeView({ type: scope_type, key: scope_key, year: parseYear(req.query.year) }));
}));

// ---- The brief ----

/**
 * Gather the scope's brief from the internet. Nothing is written when the
 * research cannot run — the last brief stands, with the reason.
 */
router.post(
  '/brief/gather',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const { scope_type, scope_key } = validate(scopeSchema, req.body);
    try {
      res.json(await intel.gather({ type: scope_type, key: scope_key }, req.user));
    } catch (e) {
      if (e.code !== 'llm_unavailable') throw e;
      res.status(503).json({ error: e.message, code: e.code, attempts: e.attempts, providers: llmProviders() });
    }
  }),
);

router.post(
  '/brief/:id/verify',
  requireRole('broker', 'underwriter', 'admin'),
  asyncHandler(async (req, res) => {
    res.json(await intel.verifyBrief(req.params.id, req.user));
  }),
);

// ---- Market visits ----

router.get('/visits', asyncHandler(async (req, res) => {
  const scope = scopeOf(req.query);
  const mine = req.query.mine === 'true' || req.query.mine === '1';
  const s = scope ? await intel.requireScope(scope.type, scope.key) : null;
  res.json(await intel.visitsView({ scope: s, userId: mine ? req.user.id : null }));
}));

router.post(
  '/visits',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await intel.createVisit(validate(visitBase, req.body), req.user));
  }),
);

router.patch(
  '/visits/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    res.json(await intel.updateVisit(req.params.id, validate(visitBase.partial(), req.body), req.user));
  }),
);

router.delete(
  '/visits/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await intel.deleteVisit(req.params.id, req.user);
    res.status(204).end();
  }),
);

// ---- Notes ----

router.get('/notes', asyncHandler(async (req, res) => {
  const scope = scopeOf(req.query);
  const s = scope ? await intel.requireScope(scope.type, scope.key) : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 500);
  res.json(await intel.listNotes({
    scope: s,
    cedantId: req.query.cedant_id || null,
    visitId: req.query.visit_id || null,
    level: intel.NOTE_LEVELS.includes(req.query.level) ? req.query.level : null,
    limit,
  }));
}));

router.post(
  '/notes',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await intel.createNote(validate(noteBase, req.body), req.user));
  }),
);

router.patch(
  '/notes/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(noteBase.omit({ level: true }).partial(), req.body);
    res.json(await intel.updateNote(req.params.id, body, req.user));
  }),
);

router.delete(
  '/notes/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await intel.deleteNote(req.params.id, req.user);
    res.status(204).end();
  }),
);

export default router;
