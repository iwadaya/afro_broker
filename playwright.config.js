// Playwright — end-to-end tests against the built client served by the API
// server on a test database (the same steps CI runs: migrate, seed, build, test).
//
//   npm run test:e2e                      → project "e2e" (identify, capture flows)
//   npm run screenshots                   → project "screenshots" (component previews
//                                           vs the app, both themes → docs/broking/screenshots)
//
// Env: E2E_BASE_URL (reuse a running server), E2E_PORT (default 4100),
//      DATABASE_URL (default the local afro_broker_test database), E2E_SKIP_BUILD=1.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 4100);
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/afro_broker_test';
const withShots = !!process.env.AB_SCREENSHOTS;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-GB',
    timezoneId: 'Africa/Nairobi',
  },
  projects: [
    { name: 'e2e', testMatch: /.*\.spec\.js/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    ...(withShots ? [{ name: 'screenshots', testMatch: /.*\.shots\.js/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }] : []),
  ],
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: `${process.env.E2E_SKIP_BUILD ? '' : 'npm run build --prefix client && '}node server/src/index.js`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NODE_ENV: 'test', PORT: String(PORT), DATABASE_URL, RUN_MIGRATIONS_ON_BOOT: 'false',
      ALLOW_DEMO_AUTH: 'true', BROKING_ENABLED: 'true', BROKING_LLOYDS_BROKER_NO: process.env.BROKING_LLOYDS_BROKER_NO || '0621',
      CORS_ORIGIN: '*', LOG_LEVEL: 'warn',
    },
  },
});
