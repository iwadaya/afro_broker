import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { claimsWorkspaceService as svc } from './claimsWorkspace.service.js';
const router = Router(); router.use(authenticate);
const uuid = value => validate(z.string().uuid(), value);
const number = z.union([z.number(), z.string().min(1).max(30)]);
const input = z.object({ name: z.string().trim().min(1).max(300), reference: z.string().max(120).optional(), description: z.string().max(5000).optional(), loss_date: z.string(), cat_event: z.boolean(), retained_loss: number, paid: number, outstanding: number }).strict();
router.get('/claims-workspace/contracts', asyncHandler(async (_req, res) => res.json(await svc.contracts())));
router.get('/claims-workspace/contracts/:id', asyncHandler(async (req, res) => res.json(await svc.workspace(uuid(req.params.id)))));
router.post('/claims-workspace/contracts/:id/preview', requireRole('broker','admin'), asyncHandler(async (req, res) => {
  const body = validate(z.object({ input, claim_id: z.string().uuid().optional() }).strict(), req.body);
  res.json(await svc.preview(uuid(req.params.id), body.input, body.claim_id));
}));
router.get('/claims-workspace/claims/:id', asyncHandler(async (req, res) => res.json(await svc.detail(uuid(req.params.id)))));
router.put('/claims-workspace/claims/:id', requireRole('broker','admin'), asyncHandler(async (req, res) => {
  const body = validate(z.object({ placement_id: z.string().uuid(), input, revision: z.number().int().nonnegative() }).strict(), req.body);
  res.json(await svc.save(uuid(req.params.id), body.placement_id, body.input, body.revision, req.user));
}));
router.post('/claims-workspace/claims/:id/submit', requireRole('broker','admin'), asyncHandler(async (req, res) => res.json(await svc.submit(uuid(req.params.id), validate(z.object({ reviewer_id: z.string().uuid() }).strict(), req.body).reviewer_id, req.user))));
router.post('/claims-workspace/claims/:id/approve', requireRole('senior_broker','underwriter','admin'), asyncHandler(async (req, res) => res.json(await svc.approve(uuid(req.params.id), req.user))));
router.post('/claims-workspace/claims/:id/reopen', requireRole('broker','admin'), asyncHandler(async (req, res) => res.json(await svc.reopen(uuid(req.params.id), req.user))));
router.post('/claims-workspace/claims/:id/return', requireRole('senior_broker','underwriter','admin'), asyncHandler(async (req, res) => res.json(await svc.returnDraft(uuid(req.params.id), validate(z.object({ reason: z.string().trim().min(5).max(2000) }).strict(), req.body).reason, req.user))));
export default router;
