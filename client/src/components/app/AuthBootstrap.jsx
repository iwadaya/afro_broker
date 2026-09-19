// Verify a stored session against the server before any protected route renders
// (pattern from Universe AuthBootstrap). Only a definitive 401 logs out.
import { useCallback, useEffect, useState } from 'react';
import { getSession, setSession, clearSession } from '../../utils/auth';
import { api } from '../../api';

export default function AuthBootstrap({ children }) {
  const [phase, setPhase] = useState(() => (getSession() ? 'checking' : 'ready'));
  const verify = useCallback(async () => {
    const session = getSession();
    if (!session) { setPhase('ready'); return; }
    setPhase('checking');
    try {
      const res = await api.getMe();
      if (res?.session?.userId) setSession({ ...session, ...res.session });
      setPhase('ready');
    } catch (err) {
      if (err?.status === 401) { clearSession(); setPhase('ready'); }
      else setPhase('offline');
    }
  }, []);
  useEffect(() => { verify(); }, [verify]);

  if (phase === 'checking') return <div className="ab ab-boot">Checking your session…</div>;
  if (phase === 'offline') {
    return (
      <div className="ab ab-boot">
        <p>We could not verify your session. You are still signed in. Check your connection and try again.</p>
        <button type="button" className="ab-btn primary" onClick={verify}>Retry</button>
      </div>
    );
  }
  return children;
}
