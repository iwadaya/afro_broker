import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) { setReady(true); return; }
    api('GET', '/auth/me')
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  async function login(email, password) {
    const { token, user: u } = await api('POST', '/auth/login', { email, password });
    setToken(token);
    setUser(u);
    return u;
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, ready, login, logout }}>
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
