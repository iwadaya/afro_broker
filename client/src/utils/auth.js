// Session metadata lives in localStorage; the auth token itself ONLY in the
// server's httpOnly cookie (pattern from Universe utils/auth.js).
const SESSION_KEY = 'AABI_SESSION_V1';

function safeStorage(action) { try { return action(window.localStorage); } catch { return null; } }

export function getSession() {
  const raw = safeStorage((s) => s.getItem(SESSION_KEY));
  if (!raw) return null;
  try { const parsed = JSON.parse(raw); return parsed?.userId ? parsed : null; } catch { return null; }
}

export function setSession(sessionData) {
  const safe = { ...(sessionData || {}) };
  delete safe.token;
  safeStorage((s) => s.setItem(SESSION_KEY, JSON.stringify(safe)));
}

export function clearSession() { safeStorage((s) => s.removeItem(SESSION_KEY)); }

/** The readable double-submit CSRF cookie, echoed as X-CSRF-Token on mutations. */
export function getCsrfToken() {
  try { const m = /(?:^|;\s*)csrf_token=([^;]+)/.exec(document.cookie || ''); return m ? decodeURIComponent(m[1]) : ''; }
  catch { return ''; }
}

export function getUserDisplayName() { return getSession()?.displayName || 'User'; }
export function getUserId() { return getSession()?.userId || ''; }
export function getLloydsBrokerNo() { return getSession()?.lloydsBrokerNo || ''; }
