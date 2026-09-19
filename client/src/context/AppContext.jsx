// Central app state: the signed-in user + runtime config (BROKING_ENABLED).
import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react';
import { getSession, setSession as persistSession, clearSession } from '../utils/auth';
import { api, SESSION_EXPIRED_EVENT, peekSessionExpiry, clearSessionExpiry } from '../api';

const AppContext = createContext(null);
export const SESSION_EXPIRED_NOTICE = 'Your session has expired. Sign in again to continue.';

export function AppProvider({ children, initialConfig = null }) {
  const [session, setSessionState] = useState(() => getSession());
  const [config, setConfig] = useState(initialConfig);
  // AuthBootstrap re-validates the stored session before this provider mounts; when
  // that check got a 401 the record is still there, so the sign-in screen can say why.
  const [authNotice, setAuthNotice] = useState(() => (!getSession() && peekSessionExpiry() ? SESSION_EXPIRED_NOTICE : ''));
  useEffect(() => { clearSessionExpiry(); }, []);

  // A 401 on any later call (see api.request) means the cookie session is gone:
  // sign out and tell the user why they are back on the sign-in screen.
  useEffect(() => {
    const onExpired = () => { clearSession(); setSessionState(null); setAuthNotice(SESSION_EXPIRED_NOTICE); };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => {
    if (config) return;
    let cancelled = false;
    api.getConfig().then((c) => { if (!cancelled) setConfig(c || { brokingEnabled: false }); })
      .catch(() => { if (!cancelled) setConfig({ brokingEnabled: false }); });
    return () => { cancelled = true; };
  }, [config]);

  const signIn = useCallback((s) => { persistSession(s); setSessionState(getSession()); setAuthNotice(''); }, []);
  const signOut = useCallback(() => { clearSession(); setSessionState(null); setAuthNotice(''); }, []);

  const value = useMemo(() => ({
    session, config, signIn, signOut, authNotice,
    brokingEnabled: !!(config?.brokingEnabled ?? session?.brokingEnabled),
  }), [session, config, signIn, signOut, authNotice]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}

export default AppContext;
