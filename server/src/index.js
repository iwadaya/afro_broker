import { logger } from './lib/logger.js';
import { bootstrap } from './startup/bootstrap.js';

bootstrap().catch((error) => {
  logger.error('application startup failed', { error });
  process.exit(1);
});
