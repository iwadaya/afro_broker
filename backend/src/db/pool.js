import pg from 'pg';
import { config } from '../config.js';

// Treat NUMERIC as JS number for our percentage/premium math. Values stay well
// within double precision (percentages 0–100 at 4dp, premiums at 2dp).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  // Managed providers present a chain Node won't verify out of the box; the
  // connection is still encrypted, we just don't pin the CA.
  ...(config.databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run a function inside a transaction. The callback receives a client with
 * `query`. Rolls back on throw, commits otherwise.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a function while holding a Postgres session advisory lock, so two app
 * instances booting against the same database cannot both do the same one-time
 * work. The lock is held on its own connection; the callback is free to use the
 * pool as normal.
 */
export async function withAdvisoryLock(key, fn) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [key]);
    return await fn();
  } finally {
    // Best effort: a dead connection has dropped the lock anyway.
    await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
