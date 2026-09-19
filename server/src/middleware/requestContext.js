// server/src/middleware/requestContext.js — authentication (pattern from Universe).
// Identity comes from a VERIFIED token in the httpOnly `auth_token` cookie; the
// user row (role, org) is re-read from the DB on every request, and the token's
// session id + epoch are checked against auth_session / uw_user.session_epoch so
// logout and revocation take effect immediately. Under ALLOW_DEMO_AUTH (dev/test
// only) a Bearer header or an `x-user-id` header naming a seeded user is honoured.
import { pool } from '../db/pool.js';
import { verifyAuthToken } from '../lib/authToken.js';
import { verifyCsrfToken } from '../lib/csrf.js';
import { readCookie, AUTH_COOKIE, CSRF_COOKIE, CSRF_HEADER } from '../lib/authCookies.js';
import { logger } from '../lib/logger.js';

export const ROLE_CODES = new Set(['ADMIN', 'BROKER', 'VIEWER']);

function demoAuthAllowed() { return process.env.ALLOW_DEMO_AUTH === 'true'; }

function extractToken(req) {
  const cookieToken = readCookie(req, AUTH_COOKIE);
  if (cookieToken) return { token: cookieToken, via: 'cookie' };
  if (demoAuthAllowed()) {
    const h = req.header('authorization');
    if (h && /^Bearer\s+/i.test(h)) return { token: h.replace(/^Bearer\s+/i, '').trim(), via: 'bearer' };
  }
  return { token: null, via: null };
}

const USER_SELECT = `
  SELECT u.user_id, u.username, u.display_name, u.role_code, u.org_id, u.session_epoch,
         u.must_change_password, o.name AS org_name, o.lloyds_broker_no`;

export function mapUserRow(u, { sessionId = null, source = 'token' } = {}) {
  return {
    userId: u.user_id,
    username: u.username,
    displayName: u.display_name,
    roleCode: u.role_code,
    orgId: u.org_id,
    orgName: u.org_name,
    lloydsBrokerNo: u.lloyds_broker_no || null,
    mustChangePassword: u.must_change_password === true,
    sessionId,
    source,
  };
}

async function loadUserAndSession(sub, sid, epoch) {
  try {
    const { rows } = await pool.query(
      `${USER_SELECT},
              s.session_id AS sess_id, s.revoked_at, (s.expires_at <= now()) AS expired
         FROM public.uw_user u
         JOIN public.bk_org o ON o.org_id = u.org_id
         LEFT JOIN public.auth_session s ON s.session_id = $2 AND s.user_id = u.user_id
        WHERE u.user_id = $1 AND u.is_active = true
        LIMIT 1`,
      [sub, sid || null],
    );
    const u = rows[0];
    if (!u) return null;
    if (!u.sess_id || u.revoked_at || u.expired) return null;
    if (Number(epoch) !== Number(u.session_epoch)) return null;
    return mapUserRow(u, { sessionId: u.sess_id });
  } catch (e) {
    logger.warn('loadUserAndSession failed', { error: e.message });
    return null;
  }
}

/** Dev/test only: `x-user-id` names a seeded, active user. */
async function demoUserFromHeaders(req) {
  const id = req.header('x-user-id');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  try {
    const { rows } = await pool.query(
      `${USER_SELECT} FROM public.uw_user u JOIN public.bk_org o ON o.org_id = u.org_id
        WHERE u.user_id = $1 AND u.is_active = true LIMIT 1`, [id]);
    return rows[0] ? mapUserRow(rows[0], { source: 'demo-header' }) : null;
  } catch { return null; }
}

export async function authenticate(req, _res, next) {
  try {
    const { token, via } = extractToken(req);
    if (token) {
      const payload = verifyAuthToken(token);
      if (payload && payload.sub) {
        const user = await loadUserAndSession(payload.sub, payload.sid, payload.epoch);
        if (user) { req.user = user; req.authVia = via; return next(); }
      }
    }
    const demo = demoAuthAllowed() ? await demoUserFromHeaders(req) : null;
    req.user = demo;
    req.authVia = demo ? 'demo-header' : null;
    return next();
  } catch (e) {
    logger.warn('authenticate failed', { error: e.message });
    req.user = null; req.authVia = null;
    return next();
  }
}

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT = new Set(['/auth/login', '/auth/logout']);

/** CSRF double-submit guard for cookie-authenticated mutations. */
export function csrfProtection(req, res, next) {
  const method = String(req.method || 'GET').toUpperCase();
  if (CSRF_SAFE_METHODS.has(method)) return next();
  if (req.authVia !== 'cookie') return next();
  if (CSRF_EXEMPT.has(req.path)) return next();
  const headerToken = req.header(CSRF_HEADER);
  const cookieToken = readCookie(req, CSRF_COOKIE);
  if (headerToken && cookieToken && headerToken === cookieToken && verifyCsrfToken(headerToken)) return next();
  return res.status(403).json({ error: 'Invalid or missing CSRF token.', code: 'CSRF_FAILED' });
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED', requestId: res.locals?.requestId || null });
}

export function requireRole(...codes) {
  const allowed = new Set(codes.map((c) => String(c).toUpperCase()));
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.', code: 'UNAUTHORIZED' });
    if (allowed.has(String(req.user.roleCode || '').toUpperCase())) return next();
    return res.status(403).json({ error: `Requires role: ${codes.join(', ')}.`, code: 'FORBIDDEN' });
  };
}

/** Audit actor from VERIFIED identity only. */
export function actorFromReq(req) {
  return { id: req?.user?.userId ?? null, role: req?.user?.roleCode ?? null, name: req?.user?.displayName ?? null, via: req?.authVia ?? null };
}
