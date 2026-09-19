// NOTE: NODE_ENV must be 'test' BEFORE the imports below evaluate (ESM hoists
// imports, so an assignment here would run too late). It is set by the `test`
// npm script (`NODE_ENV=test ...`). The guard in resetDb() is the real
// safety net: it refuses to drop a schema unless the live database is a test DB.
import bcrypt from 'bcryptjs';
import { reset } from '../src/db/migrate.js';
import { query, pool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/middleware/auth.js';
import { installTermSchemas } from '../src/domain/termSchemas/index.js';

export { pool };

let app;
export function getApp() {
  if (!app) app = createApp();
  return app;
}

/**
 * Reset the schema for a clean test. Refuses to run unless connected to a
 * database whose name marks it as a test database — a hard guard so a
 * misconfigured NODE_ENV can never DROP SCHEMA on dev/prod again.
 */
export async function resetDb() {
  const { rows } = await query('SELECT current_database() AS db');
  const db = rows[0].db;
  if (!/test/i.test(db)) {
    throw new Error(
      `Refusing to reset non-test database "${db}". Run tests with NODE_ENV=test and TEST_DATABASE_URL pointing at a *_test database.`,
    );
  }
  await reset({ silent: true });
  // Term schemas (§1.3) are reference data the system cannot create a
  // structure without, so a reset database gets them exactly as boot does.
  await installTermSchemas();
}

/** Create a user directly and return { user, token }. */
export async function makeUser(role, email) {
  const hash = await bcrypt.hash('password123', 10);
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *`,
    [email || `${role}-${Math.random().toString(36).slice(2, 8)}@test.local`, `${role} user`, hash, role],
  );
  return { user: rows[0], token: signToken(rows[0]) };
}

/** Tiny fetch-based client against the in-process app (no network listener). */
import { createServer } from 'node:http';

export async function withServer(fn) {
  const server = createServer(getApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, { token, body, raw } = {}) => {
    const resp = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // `raw` hands back the untouched Response — for file downloads, where the
    // body is binary and the headers are half the assertion.
    if (raw) return resp;
    let data = null;
    const text = await resp.text();
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: resp.status, body: data };
  };
  try {
    return await fn(api);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
