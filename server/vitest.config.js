// server/vitest.config.js — Node-side unit + integration tests.
// Integration tests (tests/integration/*.integration.test.js) skip unless
// TEST_WITH_DB=1 and DATABASE_URL point at a migrated + seeded database:
//   scripts/test-db.sh
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    env: { ALLOW_DEMO_AUTH: 'true', BROKING_ENABLED: 'true', BROKING_LLOYDS_BROKER_NO: process.env.BROKING_LLOYDS_BROKER_NO || '0621' },
    setupFiles: ['./tests/setup/env-isolation.js'],
    include: ['src/**/*.test.js', 'tests/**/*.test.js', '../shared/**/*.test.js'],
    exclude: ['**/node_modules/**', '../shared/**/*.crosscheck.test.*'],
    testTimeout: 15_000,
    hookTimeout: 20_000,
  },
});
