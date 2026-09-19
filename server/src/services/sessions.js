// server/src/services/sessions.js — server-side session lifecycle (pattern from Universe).
import { pool } from '../db/pool.js';
import { AUTH_TOKEN_TTL_SECONDS } from '../lib/authToken.js';

export async function createSession({ userId, ttlSeconds = AUTH_TOKEN_TTL_SECONDS, ip = null, userAgent = null }, client = pool) {
  if (!userId) throw new Error('createSession: userId required');
  const { rows } = await client.query(
    `INSERT INTO public.auth_session (user_id, expires_at, ip, user_agent)
     VALUES ($1, now() + ($2 || ' seconds')::interval, $3, $4)
     RETURNING session_id, expires_at`,
    [userId, String(Math.max(1, Math.floor(ttlSeconds))), ip, userAgent],
  );
  const { rows: er } = await client.query(`SELECT session_epoch FROM public.uw_user WHERE user_id = $1`, [userId]);
  return { sessionId: rows[0].session_id, expiresAt: rows[0].expires_at, epoch: er[0]?.session_epoch ?? 0 };
}

export async function revokeSession(sessionId, reason = 'LOGOUT', client = pool) {
  if (!sessionId) return false;
  const { rowCount } = await client.query(
    `UPDATE public.auth_session SET revoked_at = now(), revoked_reason = $2 WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  return rowCount > 0;
}

export async function revokeAllForUser(userId, reason = 'ADMIN', client = pool) {
  if (!userId) return 0;
  const { rowCount } = await client.query(
    `UPDATE public.auth_session SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  await client.query(`UPDATE public.uw_user SET session_epoch = session_epoch + 1, updated_at = now() WHERE user_id = $1`, [userId]);
  return rowCount;
}
