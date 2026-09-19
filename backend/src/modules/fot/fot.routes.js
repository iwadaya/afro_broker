import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as svc from './fot.service.js';

const router = Router();
router.use(authenticate);

const proposeSchema = z.object({
  agreed_terms: z.record(z.any()),
  agreed_date: z.string().optional(),
});

router.get(
  '/layers/:layerId/fot',
  asyncHandler(async (req, res) => {
    res.json(await svc.listFot(req.params.layerId));
  }),
);

router.get(
  '/layers/:layerId/fot/active',
  asyncHandler(async (req, res) => {
    res.json(await svc.getActiveFot(req.params.layerId));
  }),
);

// Propose firm order terms — any broker/admin. Opens the four-eyes request.
router.post(
  '/layers/:layerId/fot',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(proposeSchema, req.body);
    res.status(201).json(await svc.proposeFot(req.params.layerId, body, req.user.id));
  }),
);

// Authorise-to-bind — four-eyes. Must be a different user, underwriter/admin.
router.post(
  '/layers/:layerId/fot/authorise',
  requireRole('underwriter', 'admin'),
  asyncHandler(async (req, res) => {
    res.json(await svc.authoriseFot(req.params.layerId, req.user));
  }),
);

export default router;
