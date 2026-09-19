// server/src/config/env.js — validated environment (pattern from Universe config/env.js).
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../../.env'),
  path.resolve(__dirname, '../../.env'),
];
let loadedEnvPath = null;
for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false });
    loadedEnvPath = loadedEnvPath || candidate;
  }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1).default('postgresql://postgres:postgres@localhost:5432/afro_broker'),
  CLIENT_DIST_DIR: z.string().optional(),
  CORS_ORIGIN: z.string().default('*'),
  RUN_MIGRATIONS_ON_BOOT: z.string().optional(),
  AUTH_JWT_SECRET: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  // Broking module feature flag (default OFF) + the org's Lloyd's broker number.
  BROKING_ENABLED: z.string().optional(),
  BROKING_LLOYDS_BROKER_NO: z.string().regex(/^\d{4}$/, 'must be exactly 4 digits').optional().or(z.literal('')),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export function toBool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const values = parsed.data;
const nodeEnv = values.NODE_ENV;

function resolveAuthSecret() {
  const raw = values.AUTH_JWT_SECRET;
  if (raw && raw.length) return raw;
  if (nodeEnv === 'production') return '';
  return randomBytes(32).toString('hex');
}

const rootDir = path.resolve(__dirname, '../../..');

export const env = Object.freeze({
  loadedEnvPath,
  rootDir,
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: values.PORT,
  databaseUrl: values.DATABASE_URL,
  clientDistDir: values.CLIENT_DIST_DIR ? path.resolve(rootDir, values.CLIENT_DIST_DIR) : path.resolve(rootDir, 'client/dist'),
  corsOrigin: values.CORS_ORIGIN,
  runMigrationsOnBoot: toBool(values.RUN_MIGRATIONS_ON_BOOT, false),
  authJwtSecret: resolveAuthSecret(),
  sessionSecret: values.SESSION_SECRET || '',
  brokingEnabled: toBool(values.BROKING_ENABLED, false),
  lloydsBrokerNo: values.BROKING_LLOYDS_BROKER_NO || '',
});

const MIN_SECRET_LEN = 32;
function isPlaceholderSecret(value) { return /^CHANGE_ME/i.test(value); }

/** Pure checks (testable). Empty array = OK. Only enforced in production. */
export function checkProductionConfig({ nodeEnv: ne, authJwtSecret: auth, sessionSecret: sess, allowDemoAuth } = {}) {
  const errors = [];
  if (ne !== 'production') return errors;
  if (!auth) errors.push('AUTH_JWT_SECRET is required in production.');
  else if (isPlaceholderSecret(auth)) errors.push('AUTH_JWT_SECRET must not be a placeholder.');
  else if (auth.length < MIN_SECRET_LEN) errors.push(`AUTH_JWT_SECRET must be at least ${MIN_SECRET_LEN} characters.`);
  if (sess && (isPlaceholderSecret(sess) || sess.length < MIN_SECRET_LEN)) errors.push(`SESSION_SECRET must be a real secret of at least ${MIN_SECRET_LEN} characters.`);
  if (toBool(allowDemoAuth, false)) errors.push('ALLOW_DEMO_AUTH must not be enabled in production.');
  return errors;
}

export function validateEnv() {
  const errors = checkProductionConfig({
    nodeEnv: process.env.NODE_ENV || 'development',
    authJwtSecret: process.env.AUTH_JWT_SECRET || '',
    sessionSecret: process.env.SESSION_SECRET || '',
    allowDemoAuth: process.env.ALLOW_DEMO_AUTH,
  });
  if (errors.length) {
    console.error('[env] Refusing to start with an insecure configuration:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
  return env;
}
