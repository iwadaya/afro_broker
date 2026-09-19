import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const repoRoot = path.resolve(__dirname, '../..');

const env = process.env.NODE_ENV || 'development';
const isTest = env === 'test';
const isProd = env === 'production';

/** Parse a boolean-ish env var, falling back when unset or empty. */
function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Split a comma-separated env var into a trimmed, non-empty list. */
function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// The development fallback below must never reach production: a predictable
// signing key lets anyone mint a valid admin token.
const DEV_JWT_SECRET = 'dev-secret-change-me';

function resolveJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!isProd) return secret || DEV_JWT_SECRET;
  if (!secret || secret === DEV_JWT_SECRET) {
    throw new Error('JWT_SECRET must be set to a strong, unique value in production');
  }
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }
  return secret;
}

export const config = {
  env,
  isTest,
  isProd,
  port: Number(process.env.PORT || 4000),
  databaseUrl: isTest
    ? process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    : process.env.DATABASE_URL,
  // Managed Postgres (Render, RDS, …) terminates TLS with a certificate chain
  // Node won't verify by default, so verification is relaxed when SSL is on.
  databaseSsl: bool(process.env.DATABASE_SSL, false),
  databasePoolMax: Number(process.env.DATABASE_POOL_MAX || 10),
  jwt: {
    secret: resolveJwtSecret(),
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  // Empty in production means same-origin only — the single-service deploy
  // serves the SPA and the API from one origin, so no CORS headers are needed.
  corsOrigins: list(process.env.CORS_ORIGINS),
  // Serve the built frontend from the API process (single-origin deployment).
  static: {
    enabled: bool(process.env.SERVE_STATIC, isProd),
    dir: process.env.STATIC_DIR
      ? path.resolve(repoRoot, process.env.STATIC_DIR)
      : path.resolve(repoRoot, 'frontend/dist'),
  },
  // Render (and most PaaS) put the app behind a reverse proxy; without this
  // every request looks like it comes from the proxy and rate limiting breaks.
  trustProxy: bool(process.env.TRUST_PROXY, isProd),
  rateLimit: {
    enabled: bool(process.env.RATE_LIMIT_ENABLED, !isTest),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
    maxLoginFailures: Number(process.env.RATE_LIMIT_LOGIN_FAILURES || 10),
  },
  // Applying migrations on boot keeps single-service deploys simple. Platforms
  // with a release phase should disable this and run `npm run migrate` there.
  migrateOnBoot: bool(process.env.MIGRATE_ON_BOOT, true),
  // The clause corpus is content, not schema, so migrations do not carry it and
  // a deploy with no shell has no way to run `npm run seed`. Load it once, on
  // the first boot of a database. Off in test, where fixtures seed explicitly.
  seedWordingLibraryOnBoot: bool(process.env.SEED_WORDING_LIBRARY_ON_BOOT, !isTest),
  // D5 — hybrid sender: mail goes out as the broker, with a shared placements
  // mailbox on reply-to. The reply-to is plus-addressed with the contract year
  // id, which is what lets a reply be attached to the right placement later
  // without guessing.
  mail: {
    replyToMailbox: process.env.MAIL_REPLY_TO_MAILBOX || 'placements',
    replyToDomain: process.env.MAIL_REPLY_TO_DOMAIN || '',
  },
  // Demo sign-in: with DEMO_PASSWORD set, every user's password is reset to it
  // at boot and the login screen offers a dropdown of users with it filled
  // in. For demonstrations only — clear it for real use.
  demoPassword: process.env.DEMO_PASSWORD || '',
  // Demo auto sign-in: opening the app signs the visitor in as this user
  // with no login screen — an email, or a truthy value for the first demo
  // user (a broker). Anyone with the URL gets that user's session, so this
  // is for demonstrations only; empty (the default) turns it off.
  demoAutoLogin: process.env.DEMO_AUTO_LOGIN || '',
  // Where the browser is sent back to after Microsoft's sign-in. Empty means
  // the API's own origin (the single-service deploy serves the SPA); in
  // development the SPA is on the Vite server.
  appUrl: process.env.APP_URL ?? (isProd ? '' : 'http://localhost:5173'),
  outlook: {
    configured: Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET),
    syncIntervalMs: Number(process.env.MAIL_SYNC_INTERVAL_MS || 5 * 60 * 1000),
  },
  // First-run admin for platforms with no shell access. Only ever used when the
  // users table is empty; ignored entirely once any user exists.
  bootstrapAdmin: {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || '',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
    name: process.env.BOOTSTRAP_ADMIN_NAME || 'Administrator',
  },
  universe: {
    apiUrl: process.env.UNIVERSE_API_URL || '',
    apiKey: process.env.UNIVERSE_API_KEY || '',
  },
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL (or TEST_DATABASE_URL in test) must be set');
}
