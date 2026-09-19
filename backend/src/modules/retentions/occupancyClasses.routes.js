// Occupancy classes — the "class / % of capacity" grading behind the table of
// retentions. Everyone reads it (the retentions table grades against it);
// only an admin maintains it.
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './occupancyClasses.service.js';

const router = Router();
router.use(authenticate);

const classSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullish(),
  capacity_pct: z.number().min(0).max(100),
  occupancies: z.array(z.string().min(1).max(120)).max(200).optional(),
  position: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

// Every field is editable, so a patch is the same shape with nothing required.
const patchSchema = classSchema.partial();

const replaceSchema = z.object({
  classes: z.array(classSchema.extend({ id: z.string().uuid().optional() })).max(50),
});

router.get(
  '/occupancy-classes',
  asyncHandler(async (_req, res) => res.json(await service.listClasses())),
);

router.post(
  '/occupancy-classes',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = validate(classSchema, req.body);
    res.status(201).json(await service.createClass(body, req.user.id));
  }),
);

/** Save the table as edited: add, remove and re-order in one go. */
router.put(
  '/occupancy-classes',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = validate(replaceSchema, req.body);
    res.json(await service.replaceClasses(body.classes, req.user.id));
  }),
);

router.patch(
  '/occupancy-classes/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = validate(patchSchema, req.body);
    res.json(await service.updateClass(req.params.id, body, req.user.id));
  }),
);

router.delete(
  '/occupancy-classes/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    await service.deleteClass(req.params.id, req.user.id);
    res.status(204).end();
  }),
);

export default router;
