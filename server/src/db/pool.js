// server/src/db/pool.js — pg pool (pattern from Universe db/pool.js, smaller defaults).
import pkg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pkg;
// DATE (oid 1082) comes back as the literal 'YYYY-MM-DD' — no local-timezone Date objects.
types.setTypeParser(1082, (v) => v);

function redact(value) {
  try { const url = new URL(value); if (url.password) url.password = '***'; return url.toString(); }
  catch { return String(value).replace(/:[^@]*@/, ':***@'); }
}

const poolMax = Number(process.env.DB_POOL_MAX) || 10;
const poolMin = Number(process.env.DB_POOL_MIN) || 0;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: poolMax,
  min: poolMin,
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30_000,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 5_000,
  statement_timeout: 30_000,
  query_timeout: 30_000,
  keepAlive: true,
});

pool.on('error', (err) => { logger.error('pg pool error', { message: err.message, code: err.code }); });
logger.info('DB pool configured', { url: redact(env.databaseUrl), max: poolMax, min: poolMin });

export function getPoolStats() {
  return { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount, max: poolMax, min: poolMin };
}

let poolsClosed = false;
export async function closePools() {
  if (poolsClosed) return;
  poolsClosed = true;
  await pool.end();
}

export async function verifyDatabaseConnection() {
  const client = await pool.connect();
  try { await client.query('select 1'); } finally { client.release(); }
}
