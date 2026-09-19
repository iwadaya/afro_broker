import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';

const AuthContext = createContext(null);

/* Demo auto sign-in: a fresh visit with no session asks the server for the
   demo user's session (DEMO_AUTO_LOGIN) and lands on the dashboard with no
   login screen. Signing out is remembered for the tab, so the login screen
   stays until the visitor signs in again or opens a new tab. */
const SIGNED_OUT_KEY = 'ub_signed_out';

function signedOut() {
  try { return sessionStorage.getItem(SIGNED_OUT_KEY) === '1'; } catch { return false; }
}
function rememberSignedOut(flag) {
  try {
    if (flag) sessionStorage.setItem(SIGNED_OUT_KEY, '1');
    else sessionStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    // Storage can be unavailable; auto sign-in then simply runs on every load.
  }
}

/** The demo user's session, when the server offers one: { token, user } or null. */
async function fetchAutoLogin() {
  const r = await api('POST', '/auth/auto-login');
  return r?.enabled ? r : null;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const accept = ({ token, user: u }) => {
      if (!alive) return;
      setToken(token);
      setUser(u);
    };
    // No session, and not signed out on purpose: take the demo session if
    // the server offers one. A stored session that no longer works (expired,
    // or the signing key changed) is dropped and treated the same way.
    const auto = () => (signedOut() ? Promise.resolve(null) : fetchAutoLogin().catch(() => null))
      .then((r) => { if (r) accept(r); });
    (getToken()
      ? api('GET', '/auth/me').then((u) => { if (alive) setUser(u); }).catch(() => { setToken(null); return auto(); })
      : auto()
    ).finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, []);

  async function login(email, password) {
    const { token, user: u } = await api('POST', '/auth/login', { email, password });
    rememberSignedOut(false);
    setToken(token);
    setUser(u);
    return u;
  }

  /** Sign in as the demo user without a password (the login screen's "Continue as"). */
  async function autoLogin() {
    const r = await fetchAutoLogin();
    if (!r) throw new Error('Auto sign-in is not enabled');
    rememberSignedOut(false);
    setToken(r.token);
    setUser(r.user);
    return r.user;
  }

  function logout() {
    rememberSignedOut(true);
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, ready, login, logout, autoLogin }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

/** True if the current user holds any of the given roles. */
/** Roles a role stands in for: a senior broker is a broker who also approves
    renewal packs, so anything offered to a broker is offered to them. */
const IMPLIED_ROLES = { senior_broker: ['broker'] };

export function hasRole(userRole, roles) {
  return roles.includes(userRole) || (IMPLIED_ROLES[userRole] || []).some((r) => roles.includes(r));
}

export function useHasRole(...roles) {
  const { user } = useAuth();
  return !!user && hasRole(user.role, roles);
}
