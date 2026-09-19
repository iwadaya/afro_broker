// client/src/api.js — centralised HTTP client (trimmed port of Universe api.ts).
// Every method returns parsed JSON or throws an HttpError carrying the server
// body ({ error, code, ... }) so screens can branch on `code` (STALE_WRITE,
// UMR_TAKEN, VALIDATION_FAILED, …).
import { getCsrfToken, clearSession } from './utils/auth';
import { httpFetch, HttpError } from './utils/httpClient.js';

export { HttpError };

/**
 * A 401 outside sign-in means the cookie session is gone (expired, revoked, server
 * restarted) while the client still holds its stored copy. request() clears the
 * copy, records the expiry and fires this event on window; AppContext signs the
 * user out and shows why. AuthBootstrap's boot check runs BEFORE the provider
 * mounts, so the record (peekSessionExpiry) is what carries the notice across.
 */
export const SESSION_EXPIRED_EVENT = 'aabi:session-expired';
const AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/logout']);
let sessionExpiry = null;
export function peekSessionExpiry() { return sessionExpiry; }
export function clearSessionExpiry() { sessionExpiry = null; }
const enc = encodeURIComponent;

const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const CACHEABLE = new Set(['/api/brokers', '/api/treaty-types', '/api/class-of-business', '/api/ref/lists/country/items', '/api/ref/lists/currency/items']);
export function clearClientRefCache() { _cache.clear(); }

export async function request(path, { method = 'GET', body, headers = {}, signal, timeoutMs, retry } = {}) {
  const m = method.toUpperCase();
  const cacheable = m === 'GET' && CACHEABLE.has(path);
  if (cacheable) {
    const hit = _cache.get(path);
    if (hit && Date.now() < hit.expiresAt) return hit.promise;
  }
  const init = {
    method: m,
    credentials: 'include',
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(m !== 'GET' && m !== 'HEAD' ? { 'X-CSRF-Token': getCsrfToken() } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal, timeoutMs, retry,
  };
  const run = httpFetch(path, init).then(async (res) => {
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  });
  if (cacheable) _cache.set(path, { promise: run, expiresAt: Date.now() + CACHE_TTL });
  try { return await run; } catch (e) {
    if (cacheable) _cache.delete(path);
    // The cookie session is gone (expired, revoked, server restarted) while the
    // client still holds its stored copy: drop it and let the app return to sign-in.
    if (e?.status === 401 && !AUTH_PATHS.has(path.split('?')[0])) {
      clearSession();
      sessionExpiry = { path, at: Date.now() };
      try { window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: { path } })); } catch { /* non-browser */ }
    }
    throw e;
  }
}

/** Parse the JSON body an HttpError carries ({ error, code, … }) or null. */
export function errorBody(e) {
  if (!e || !e.body) return null;
  if (typeof e.body === 'object') return e.body;
  try { return JSON.parse(e.body); } catch { return { error: String(e.body) }; }
}

export const api = {
  // ── auth / config ──
  getConfig: () => request('/api/config'),
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST', body: {} }),
  getMe: () => request('/api/auth/me'),
  // ── reference data (Universe shapes: { id, name, ... }) ──
  listBrokers: () => request('/api/brokers'),
  listTreatyTypes: () => request('/api/treaty-types'),
  listClassOfBusiness: () => request('/api/class-of-business'),
  getRefListItems: (key) => request(`/api/ref/lists/${enc(key)}/items`),
  listCedants: ({ countryId } = {}) => request(`/api/cedants${countryId ? `?country_id=${enc(countryId)}` : ''}`),
  // ── broking module (/api/broking) ──
  broking: {
    settings: () => request('/api/broking/settings'),
    listContracts: (search = '') => request(`/api/broking/contracts${search ? `?search=${enc(search)}` : ''}`),
    byUmr: (umr) => request(`/api/broking/contracts/by-umr/${enc(umr)}`),
    create: (body) => request('/api/broking/contracts', { method: 'POST', body }),
    getContract: (id) => request(`/api/broking/contracts/${enc(id)}`),
    getHeader: (id) => request(`/api/broking/contracts/${enc(id)}/header`),
    putHeader: (id, body) => request(`/api/broking/contracts/${enc(id)}/header`, { method: 'PUT', body }),
    getPropDetail: (id) => request(`/api/broking/contracts/${enc(id)}/prop-detail`),
    putPropDetail: (id, body) => request(`/api/broking/contracts/${enc(id)}/prop-detail`, { method: 'PUT', body }),
    getNpStructure: (id) => request(`/api/broking/contracts/${enc(id)}/np-structure`),
    putNpStructure: (id, body) => request(`/api/broking/contracts/${enc(id)}/np-structure`, { method: 'PUT', body }),
    amendUmr: (id, body) => request(`/api/broking/contracts/${enc(id)}/amend-umr`, { method: 'POST', body }),
    setStatus: (id, body) => request(`/api/broking/contracts/${enc(id)}/status`, { method: 'PATCH', body }),
    audit: (id) => request(`/api/broking/contracts/${enc(id)}/audit`),
  },
};

export default api;
