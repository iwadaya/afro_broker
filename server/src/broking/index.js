// server/src/broking/index.js — AABI broking API, mounted at /api/broking by
// routes/registerApiRoutes.js only when BROKING_ENABLED=true, after the shared
// authenticate → csrfProtection → requireAuth chain (every route needs a user).
import { Router } from 'express';
import { requireAuth } from '../middleware/requestContext.js';
import routes from './routes.js';
import { ApiError } from './errors.js';

const router = Router();
router.use(requireAuth);
router.get('/status', (_req, res) => res.json({ module: 'broking', ok: true }));
router.use(routes);

// Module errors carry their details (fields, current/expected, missing, …) in the body.
router.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, code: err.code, requestId: res.locals.requestId || null, ...err.details });
  }
  next(err);
});

export default router;
