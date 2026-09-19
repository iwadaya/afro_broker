// GET /api/config — public runtime flags the SPA needs before/after login.
import { Router } from 'express';
import { env } from '../config/env.js';

const router = Router();
router.get('/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ brokingEnabled: env.brokingEnabled, appName: 'Afro_Asian_Business_Intelligence' });
});
export default router;
