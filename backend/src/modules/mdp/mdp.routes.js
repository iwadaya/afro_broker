import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as svc from './mdp.service.js';
import { ConflictError } from '../../lib/errors.js';

const router = Router();
router.use(authenticate);


router.get(
  '/layers/:layerId/mdp',
  asyncHandler(async (req, res) => {
    res.json(await svc.getMdp(req.params.layerId));
  }),
);

// Issuing without independent approval is no longer permitted. Historical
// MDPs and settlement status remain readable through the original API.
router.post('/layers/:layerId/mdp', requireRole('broker','admin'), asyncHandler(async () => {
  throw new ConflictError('Use the Premium workspace: MDP notes require approval by a second person');
}));

// Track a debit note: pending → sent → paid.
router.post(
  '/mdp-notes/:id/status',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ status: z.enum(['sent', 'paid']) }), req.body);
    res.json(await svc.setNoteStatus(req.params.id, body.status, req.user.id));
  }),
);

export default router;

