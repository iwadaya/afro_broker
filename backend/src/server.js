import { createApp } from './app.js';
import { config } from './config.js';
import { bootstrapAdmin, bootstrapDemoPassword, bootstrapWordingLibrary, bootstrapTermSchemas } from './db/bootstrap.js';
import { up } from './db/migrate.js';
import { ensureReferenceData } from './db/ensureReferenceData.js';
import { pool } from './db/pool.js';
import { startPremiumDeliveryWorker } from './modules/premium/premium.service.js';
import { startInboxPolling } from './modules/negotiation/replies.js';
import { startReminderPolling } from './modules/analysis/renewalDesk.service.js';

async function main() {
  // Apply pending migrations on boot (idempotent). Deployments with a release
  // phase should set MIGRATE_ON_BOOT=false and run `npm run migrate` there.
  if (config.migrateOnBoot) await up({ silent: true });
  // No-op unless BOOTSTRAP_ADMIN_* is set and the users table is empty.
  await bootstrapAdmin();
  // No-op unless DEMO_PASSWORD is set (demo sign-in: one password for everyone).
  await bootstrapDemoPassword();
  // No-op unless this database has never had the wording library loaded.
  await bootstrapWordingLibrary();
  await bootstrapTermSchemas();
  // The Universe modelling tool's startup step: assert the canonical
  // reference data (countries, currencies, brokers, treaty types, classes).
  await ensureReferenceData();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Universe Broking backend listening on :${config.port} (${config.env})`);
  });
  // Read the connected Outlook inbox for underwriters' replies while running
  // (a no-op until a mailbox is connected).
  const stopPolling = config.outlook.configured && !config.isTest ? startInboxPolling(config.outlook.syncIntervalMs) : () => {};
  // The renewal desk's response-deadline reminders: three days before the
  // deadline, once, to every underwriter who has not replied.
  const stopPremiumDelivery = config.isTest ? () => {} : startPremiumDeliveryWorker();
  const stopReminders = config.isTest ? () => {} : startReminderPolling();

  const shutdown = async () => {
    stopPolling();
    stopReminders();
    stopPremiumDelivery();
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

