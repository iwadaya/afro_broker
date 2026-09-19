// server/src/broking/routes.js — /api/broking endpoints (see docs/broking/PLAN.md).
import { Router } from 'express';
import { asyncHandler } from '../helpers.js';
import { validateBody, validateQuery } from '../lib/validate.js';
import * as svc from './service.js';
import { ApiError } from './errors.js';
import {
  createContractSchema, putHeaderSchema, putPropDetailSchema, putNpStructureSchema, amendUmrSchema, statusSchema, listQuerySchema,
} from './validation.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Contracts are addressed by UUID everywhere except by-umr: a malformed id is a 404,
// never a database error (and never a hint about what exists).
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(String(id))) return res.status(404).json({ error: 'Contract not found', code: 'NOT_FOUND', requestId: res.locals.requestId || null });
  next();
});

router.get('/settings', (req, res) => res.json(svc.settings(req.user)));

router.get('/contracts', validateQuery(listQuerySchema), asyncHandler(async (req, res) => {
  res.json(await svc.listContracts(req.user, res.locals.query));
}));

router.get('/contracts/by-umr/:umr', asyncHandler(async (req, res) => {
  res.json(await svc.findByUmr(req.user, req.params.umr));
}));

router.post('/contracts', validateBody(createContractSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await svc.createContract(req.user, req.body));
}));

router.get('/contracts/:id', asyncHandler(async (req, res) => {
  res.json(await svc.getBundle(req.user, req.params.id));
}));

router.get('/contracts/:id/audit', asyncHandler(async (req, res) => {
  res.json(await svc.getAudit(req.user, req.params.id));
}));

router.get('/contracts/:id/header', asyncHandler(async (req, res) => {
  const b = await svc.getBundle(req.user, req.params.id);
  res.json({ contractId: b.contractId, umr: b.umr, businessType: b.businessType, status: b.status, rowVersion: b.rowVersion, parentContractId: b.parentContractId, parentUmr: b.parentUmr, header: b.header });
}));
router.put('/contracts/:id/header', validateBody(putHeaderSchema), asyncHandler(async (req, res) => {
  res.json(await svc.saveHeader(req.user, req.params.id, req.body));
}));

router.get('/contracts/:id/prop-detail', asyncHandler(async (req, res) => {
  const b = await svc.getBundle(req.user, req.params.id);
  if (b.businessType !== 'PROPORTIONAL') throw new ApiError(400, 'WRONG_BUSINESS_TYPE', 'Treaty Detail applies to proportional contracts only.');
  res.json(b);
}));
router.put('/contracts/:id/prop-detail', validateBody(putPropDetailSchema), asyncHandler(async (req, res) => {
  res.json(await svc.savePropDetail(req.user, req.params.id, req.body));
}));

router.get('/contracts/:id/np-structure', asyncHandler(async (req, res) => {
  const b = await svc.getBundle(req.user, req.params.id);
  if (b.businessType !== 'NON_PROPORTIONAL') throw new ApiError(400, 'WRONG_BUSINESS_TYPE', 'Structure applies to non-proportional contracts only.');
  res.json(b);
}));
router.put('/contracts/:id/np-structure', validateBody(putNpStructureSchema), asyncHandler(async (req, res) => {
  res.json(await svc.saveNpStructure(req.user, req.params.id, req.body));
}));

router.post('/contracts/:id/amend-umr', validateBody(amendUmrSchema), asyncHandler(async (req, res) => {
  res.json(await svc.amendUmr(req.user, req.params.id, req.body));
}));

router.patch('/contracts/:id/status', validateBody(statusSchema), asyncHandler(async (req, res) => {
  res.json(await svc.changeStatus(req.user, req.params.id, req.body));
}));

export default router;
