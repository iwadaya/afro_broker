import { Router } from 'express';
import { query } from '../../db/pool.js';
import { asyncHandler } from '../../lib/http.js';
import { NotFoundError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { llmProviders } from '../../lib/llm.js';
import { aggregateBordereaux, sampleRows } from './analysis.service.js';
import { analyseBordereaux } from './analysis.llm.js';

const router = Router();
router.use(authenticate);

async function loadPlacement(placementId) {
  const { rows } = await query('SELECT * FROM placement WHERE id = $1', [placementId]);
  if (!rows[0]) throw new NotFoundError('Placement');
  const { rows: layers } = await query(
    'SELECT * FROM layer WHERE placement_id = $1 ORDER BY position, created_at', [placementId],
  );
  return { ...rows[0], layers };
}

const loadBordereaux = async (placementId) => (await query(
  'SELECT id, type, source_file, parsed_rows FROM bordereau WHERE placement_id = $1 ORDER BY created_at',
  [placementId],
)).rows;

const latestAnalysis = async (placementId) => (await query(
  `SELECT id, provider, model, aggregates, narrative, sources, created_at
   FROM bordereau_analysis WHERE placement_id = $1 ORDER BY created_at DESC LIMIT 1`,
  [placementId],
)).rows[0] || null;

/* The figures, computed fresh from whatever bordereaux are on file, plus the
   last AI reading of them (if any). No model is called — this is free. */
router.get(
  '/placements/:placementId/analysis',
  asyncHandler(async (req, res) => {
    const placement = await loadPlacement(req.params.placementId);
    const bordereaux = await loadBordereaux(placement.id);
    res.json({
      aggregates: aggregateBordereaux(bordereaux, { currency: placement.currency }),
      analysis: await latestAnalysis(placement.id),
      providers: llmProviders(),
    });
  }),
);

/* Re-read the bordereaux with ChatGPT and store the result. There is no
   fallback provider, but the computed figures are returned either way, so an
   outage costs the narrative and nothing else. */
router.post(
  '/placements/:placementId/analysis',
  requireRole('broker', 'admin', 'underwriter'),
  asyncHandler(async (req, res) => {
    const placement = await loadPlacement(req.params.placementId);
    const bordereaux = await loadBordereaux(placement.id);
    const aggregates = aggregateBordereaux(bordereaux, { currency: placement.currency });

    if (bordereaux.length === 0) {
      res.status(422).json({
        error: 'No bordereaux to analyse — import a premium or claims bordereau first',
        code: 'no_bordereaux',
        aggregates,
      });
      return;
    }

    let result;
    try {
      result = await analyseBordereaux({
        placement,
        aggregates,
        sample: sampleRows(bordereaux),
      });
    } catch (e) {
      if (e.code !== 'llm_unavailable') throw e;
      // The numbers stand on their own — hand them back with the reason the
      // narrative is missing rather than failing the whole request.
      res.status(503).json({
        error: e.message,
        code: e.code,
        attempts: e.attempts,
        aggregates,
        providers: llmProviders(),
      });
      return;
    }

    const { rows } = await query(
      `INSERT INTO bordereau_analysis (placement_id, provider, model, aggregates, narrative, sources, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, provider, model, aggregates, narrative, sources, created_at`,
      [placement.id, result.provider, result.model, JSON.stringify(aggregates),
        JSON.stringify(result.data), JSON.stringify(aggregates.sources), req.user.id],
    );
    await audit({
      entityType: 'placement',
      entityId: placement.id,
      action: 'bordereau_analysis',
      userId: req.user.id,
      detail: { provider: result.provider, model: result.model, bordereaux: bordereaux.length },
    });
    res.status(201).json({ aggregates, analysis: rows[0], attempts: result.attempts });
  }),
);

export default router;
