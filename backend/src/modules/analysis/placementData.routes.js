// The Data screen: the placement's screens read as one, compared with the
// prior year or an uploaded expiring pack, and the AI's reading of it.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { llmProviders } from '../../lib/llm.js';
import { dataContext, uploadExpiringPack, latestAnalysis, rawDocuments } from './placementData.service.js';
import { analysePlacementData } from './placementData.llm.js';

const router = Router();
router.use(authenticate);

/** What the comparison hands the screen — the basis without the raw documents. */
const presentComparison = (comparison) => ({
  basis: comparison.basis,
  compared_to: comparison.compared_to,
  prior: comparison.prior
    ? { placement: comparison.prior.placement, screens: comparison.prior.screens, structures: comparison.prior.structures, retentions: comparison.prior.retentions }
    : null,
  analysis: comparison.analysis || null,
  documents: comparison.documents || [],
  extracted: comparison.extracted || null,
});

router.get(
  '/placements/:placementId/data-analysis',
  asyncHandler(async (req, res) => {
    const { digest, comparison, computed } = await dataContext(req.params.placementId);
    res.json({
      digest,
      comparison: presentComparison(comparison),
      computed,
      analysis: await latestAnalysis(req.params.placementId),
      providers: llmProviders(),
    });
  }),
);

router.post(
  '/placements/:placementId/data-analysis',
  requireRole('broker', 'admin', 'underwriter'),
  asyncHandler(async (req, res) => {
    const { placement, digest, comparison, computed } = await dataContext(req.params.placementId);
    const forModel = comparison.basis === 'expiring_pack'
      ? { ...comparison, raw_documents: await rawDocuments(comparison.analysis.id) }
      : comparison;
    let result;
    try {
      result = await analysePlacementData({ digest, computed, comparison: forModel }, req.app.locals.llmClients || {});
    } catch (e) {
      if (e.code !== 'llm_unavailable') throw e;
      res.status(503).json({
        error: e.message, code: e.code, attempts: e.attempts,
        digest, comparison: presentComparison(comparison), computed, providers: llmProviders(),
      });
      return;
    }
    const { rows } = await query(
      `INSERT INTO placement_data_analysis (placement_id, basis, compared_to, provider, model, digest, computed, narrative, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, basis, compared_to, provider, model, narrative, computed, created_at`,
      [placement.id, comparison.basis, comparison.compared_to, result.provider, result.model,
        JSON.stringify(digest), JSON.stringify(computed), JSON.stringify(result.data), req.user.id],
    );
    await audit({
      entityType: 'placement', entityId: placement.id, action: 'data_analysis', userId: req.user.id,
      detail: { basis: comparison.basis, compared_to: comparison.compared_to, provider: result.provider, model: result.model, changes: computed.changes.length },
    });
    res.status(201).json({ digest, comparison: presentComparison(comparison), computed, analysis: rows[0], attempts: result.attempts });
  }),
);

const uploadSchema = z.object({
  filename: z.string().min(1).max(300),
  mime_type: z.string().min(1).max(200).optional(),
  content_base64: z.string().min(1),
});

/** The expiring renewal pack of a placement new to the house, in the other broker's format. */
router.post(
  '/placements/:placementId/expiring-pack',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(uploadSchema, req.body || {});
    const uploaded = await uploadExpiringPack(req.params.placementId, body, req.user);
    await audit({
      entityType: 'placement', entityId: req.params.placementId, action: 'expiring_pack_upload', userId: req.user.id,
      detail: { analysis_id: uploaded.analysis_id, filename: body.filename, size_bytes: uploaded.document.size_bytes },
    });
    const { digest, comparison, computed } = await dataContext(req.params.placementId);
    res.status(201).json({ ...uploaded, digest, comparison: presentComparison(comparison), computed });
  }),
);

export default router;
