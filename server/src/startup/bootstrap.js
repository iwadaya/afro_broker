import { createApp } from '../app.js';
import { env, validateEnv } from '../config/env.js';
import { verifyDatabaseConnection } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { runMigrations } from './runMigrations.js';

export async function bootstrap() {
  validateEnv();
  logger.info('startup configuration loaded', {
    nodeEnv: env.nodeEnv, envFile: env.loadedEnvPath || null, port: env.port,
    clientDistDir: env.clientDistDir, runMigrationsOnBoot: env.runMigrationsOnBoot,
    brokingEnabled: env.brokingEnabled, lloydsBrokerNo: env.lloydsBrokerNo || null,
  });
  await verifyDatabaseConnection();
  logger.info('database connection verified');
  if (env.runMigrationsOnBoot) { await runMigrations(); logger.info('migrations complete'); }
  else logger.info('migrations skipped (RUN_MIGRATIONS_ON_BOOT is off)');

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info('http server listening', { port: env.port, url: `http://localhost:${env.port}` });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}
