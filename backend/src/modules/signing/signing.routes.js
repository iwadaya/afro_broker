import { Router } from 'express';
import { asyncHandler } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { searchContracts, contractSignings } from './signing.service.js';

/*
 * The signing workflow's entry: which contract, then its programme and its
 * signings. Read-only — applying a signing stays on the layer's own
 * endpoints (/layers/:id/signing/*), where the four-eyes and status rules live.
 */
const router = Router();
router.use(authenticate);

/** The contracts a signing can be explored on — the chooser's list. */
router.get(
  '/signing/contracts',
  asyncHandler(async (req, res) => res.json(await searchContracts(req.query.q || '', { limit: req.query.limit }))),
);

/** One contract: the programme, and the written and signed line of every market on it. */
router.get(
  '/signing/contracts/:placementId',
  asyncHandler(async (req, res) => res.json(await contractSignings(req.params.placementId))),
);

export default router;
