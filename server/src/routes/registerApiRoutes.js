import lookupsRouter from './lookups.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Authenticated API routers. The broking module is mounted at /api/broking only
 * when BROKING_ENABLED=true (feature flag, default off).
 */
export async function registerApiRoutes(app) {
  app.use('/api', lookupsRouter);
  if (env.brokingEnabled) {
    const { default: brokingRouter } = await import('../broking/index.js');
    app.use('/api/broking', brokingRouter);
    logger.info('broking module mounted at /api/broking');
  } else {
    logger.info('broking module disabled (BROKING_ENABLED is off)');
  }
}
