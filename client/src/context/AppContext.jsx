// Central app state: the signed-in user + runtime config (BROKING_ENABLED).
import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react';
import { getSession, setSession as persistSession, clearSession } from '../utils/auth';
import { api } from '../api';

const AppContext = createContext(null);

export function AppProvider({ children, initialConfig = null }) {
  const [session, setSessionState] = useState(() => getSession());
  const [config, setConfig] = useState(initialConfig);

  useEffect(() => {
    if (config) return;
    let cancelled = false;
    api.getConfig().then((c) => { if (!cancelled) setConfig(c || { brokingEnabled: false }); })
      .catch(() => { if (!cancelled) setConfig({ brokingEnabled: false }); });
    return () => { cancelled = true; };
  }, [config]);

  const signIn = useCallback((s) => { persistSession(s); setSessionState(getSession()); }, []);
  const signOut = useCallback(() => { clearSession(); setSessionState(null); }, []);

  const value = useMemo(() => ({
    session, config, signIn, signOut,
    brokingEnabled: !!(config?.brokingEnabled ?? session?.brokingEnabled),
  }), [session, config, signIn, signOut]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be used within AppProvider');
  return ctx;
}

export default AppContext;
