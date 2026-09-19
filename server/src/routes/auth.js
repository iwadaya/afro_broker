// server/src/routes/auth.js — login / logout / me (trimmed port of Universe routes/auth.js).
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { verifyPassword, needsRehash, hashPassword } from '../lib/passwordHash.js';
import { signAuthToken, verifyAuthToken } from '../lib/authToken.js';
import { setAuthCookies, clearAuthCookies, readCookie, AUTH_COOKIE } from '../lib/authCookies.js';
import { createSession, revokeSession } from '../services/sessions.js';
import { mapUserRow } from '../middleware/requestContext.js';
import { env } from '../config/env.js';

const router = Router();

const DEMO_PASSWORD = 'demo2026';
// Fixed dummy hash so an unknown username costs the same as a real check (no timing oracle).
const DUMMY_PASSWORD_HASH = 'scrypt$15$8$1$00000000000000000000000000000000$' + '0'.repeat(128);

function clientIp(req) { try { return req.ip || req.socket?.remoteAddress || null; } catch { return null; } }

export function buildSession(user) {
  return {
    userId: user.userId, username: user.username, displayName: user.displayName,
    roleCode: user.roleCode, orgId: user.orgId, orgName: user.orgName,
    lloydsBrokerNo: user.lloydsBrokerNo, mustChangePassword: user.mustChangePassword,
    brokingEnabled: env.brokingEnabled,
  };
}

const PUBLIC_AUTH = new Set(['POST /auth/login', 'POST /auth/logout']);
router.use((req, res, next) => {
  if (PUBLIC_AUTH.has(`${req.method} ${req.path}`)) return next();
  if (req.user) return next();
  return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
});

router.post('/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.', code: 'VALIDATION_FAILED' });
  const { rows } = await pool.query(
    `SELECT u.*, o.name AS org_name, o.lloyds_broker_no
       FROM public.uw_user u JOIN public.bk_org o ON o.org_id = u.org_id
      WHERE (lower(u.username) = $1 OR lower(u.email) = $1) AND u.is_active = true
      LIMIT 1`,
    [String(username).trim().toLowerCase()],
  );
  if (!rows.length) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return res.status(401).json({ error: 'Invalid credentials.', code: 'UNAUTHORIZED' });
  }
  const user = rows[0];
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await verifyPassword(password, user.password_hash || DUMMY_PASSWORD_HASH);
    return res.status(401).json({ error: 'Invalid credentials.', code: 'UNAUTHORIZED' });
  }
  const storedHash = user.password_hash;
  const hashMatches = typeof storedHash === 'string' && storedHash.startsWith('scrypt$') && await verifyPassword(password, storedHash);
  const passwordOk = (process.env.ALLOW_DEMO_AUTH === 'true' && password === DEMO_PASSWORD) || hashMatches;
  if (!passwordOk) {
    pool.query(
      `UPDATE public.uw_user SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts >= 4 THEN now() + interval '15 minutes' ELSE locked_until END,
         updated_at = now() WHERE user_id = $1`, [user.user_id]).catch(() => {});
    return res.status(401).json({ error: 'Invalid credentials.', code: 'UNAUTHORIZED' });
  }
  pool.query(`UPDATE public.uw_user SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE user_id = $1`, [user.user_id]).catch(() => {});
  if (hashMatches && needsRehash(storedHash)) {
    hashPassword(password).then((fresh) => pool.query(`UPDATE public.uw_user SET password_hash = $2, updated_at = now() WHERE user_id = $1`, [user.user_id, fresh])).catch(() => {});
  }
  const sess = await createSession({ userId: user.user_id, ip: clientIp(req), userAgent: req.headers['user-agent'] || null });
  setAuthCookies(res, signAuthToken({ sub: user.user_id, sid: sess.sessionId, epoch: sess.epoch }));
  res.json({ session: buildSession(mapUserRow(user, { sessionId: sess.sessionId })) });
}));

router.post('/auth/logout', asyncHandler(async (req, res) => {
  const token = readCookie(req, AUTH_COOKIE);
  const payload = token ? verifyAuthToken(token) : null;
  if (payload?.sid) await revokeSession(payload.sid, 'LOGOUT').catch(() => false);
  clearAuthCookies(res);
  res.json({ ok: true });
}));

router.get('/auth/me', asyncHandler(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated.', code: 'UNAUTHORIZED' });
  res.json({ session: buildSession(req.user) });
}));

export default router;
