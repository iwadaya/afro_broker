import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as svc from './claimNotifications.service.js';
import { searchContracts, contractContext } from './claimsDesk.service.js';

const router = Router();
router.use(authenticate);

const ingestSchema = z.object({
  source: z.string().max(200).optional(),
  message_id: z.string().max(400).optional(),
  received_at: z.string().datetime({ offset: true }).optional(),
  subject: z.string().max(1000).optional(),
  sender: z.string().max(400).optional(),
  body: z.string().min(1).max(200000),
});

/* The claims stage: the contracts the desk can open, and one contract's claims. */
router.get(
  '/claims/contracts',
  asyncHandler(async (req, res) => res.json(await searchContracts(req.query.q || ''))),
);

router.get(
  '/claims/contracts/:placementId',
  asyncHandler(async (req, res) => res.json(await contractContext(req.params.placementId))),
);

router.get(
  '/claim-notifications',
  asyncHandler(async (req, res) => res.json(await svc.listNotifications({
    placement_id: req.query.placement_id || undefined, status: req.query.status || undefined,
  }))),
);

/** An inbound loss advice: read, matched, held for triage. */
router.post(
  '/claim-notifications/ingest',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(ingestSchema, req.body);
    const out = await svc.ingestNotification(body, { userId: req.user.id });
    res.status(out.duplicate ? 200 : 201).json(out);
  }),
);

router.get(
  '/claim-notifications/:id',
  asyncHandler(async (req, res) => res.json(await svc.getNotification(req.params.id))),
);

router.post(
  '/claim-notifications/:id/match',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ placement_id: z.string().uuid() }), req.body);
    res.json(await svc.matchToPlacement(req.params.id, body.placement_id, req.user));
  }),
);

/** Load the claim and issue the preliminary loss advice to the whole signed panel, in one step. */
router.post(
  '/claim-notifications/:id/load',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ placement_id: z.string().uuid().optional() }), req.body || {});
    const out = await svc.loadNotification(req.params.id, body, req.user);
    res.status(out.already ? 200 : 201).json(out);
  }),
);

router.post(
  '/claim-notifications/:id/park',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ notes: z.string().max(2000).optional() }), req.body || {});
    res.json(await svc.parkNotification(req.params.id, body, req.user));
  }),
);

export default router;
