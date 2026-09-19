import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as svc from './lines.service.js';

const router = Router();
router.use(authenticate);

const writeSchema = z.object({
  market_id: z.string().uuid(),
  written_pct: z.number().min(0),
  to_stand: z.boolean().optional(),
  approach_id: z.string().uuid().optional(),
  market_ref: z.string().optional(),
});

router.get(
  '/layers/:layerId/lines',
  asyncHandler(async (req, res) => {
    res.json(await svc.listLines(req.params.layerId));
  }),
);

router.post(
  '/layers/:layerId/lines',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(writeSchema, req.body);
    res.status(201).json(await svc.writeLine(req.params.layerId, body, req.user.id));
  }),
);

const overrideSchema = z.object({
  signed_pct: z.number().min(0).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
}).refine((b) => b.signed_pct !== undefined || b.notes !== undefined, { message: 'Nothing to change' });

// One cell of the broker's column: a signed share set by hand (never above
// the line written), or a note — the declinature reason, what was said.
router.patch(
  '/layers/:layerId/lines/:marketId',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(overrideSchema, req.body);
    res.json(await svc.overrideLine(req.params.layerId, req.params.marketId, body, req.user.id));
  }),
);

router.post(
  '/layers/:layerId/lines/:marketId/decline',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    res.json(await svc.declineLine(req.params.layerId, req.params.marketId, req.user.id));
  }),
);

// Non-mutating signing-down preview. `?stands=<lineId,lineId>` overrides the
// persisted to-stand flags for the preview only, so the worksheet can recompute
// a provisional stand set without persisting; `stands=` (empty) previews with
// no lines standing.
router.get(
  '/layers/:layerId/signing/preview',
  asyncHandler(async (req, res) => {
    res.json(await svc.previewSigning(req.params.layerId, req.query.stands));
  }),
);

// Apply signing-down (persists signed lines).
router.post(
  '/layers/:layerId/signing/apply',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ accept_shortfall: z.boolean().optional() }), req.body || {});
    res.json(await svc.applySigning(req.params.layerId, { acceptShortfall: body.accept_shortfall }, req.user.id));
  }),
);

// Apply the cedant's signing instruction (client-dictated allocation).
router.post(
  '/layers/:layerId/signing/instruction',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(
      z.object({
        allocations: z.array(z.object({
          market_id: z.string().uuid(),
          signed_pct: z.number().min(0),
        })).min(1),
      }),
      req.body,
    );
    res.json(await svc.applySigningInstruction(req.params.layerId, body.allocations, req.user.id));
  }),
);

// Four-eyes bind: propose then authorise (different user).
router.post(
  '/layers/:layerId/bind/propose',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.proposeBind(req.params.layerId, req.user.id));
  }),
);

router.post(
  '/layers/:layerId/bind/authorise',
  requireRole('underwriter', 'admin'),
  asyncHandler(async (req, res) => {
    res.json(await svc.authoriseBind(req.params.layerId, req.user));
  }),
);

export default router;
