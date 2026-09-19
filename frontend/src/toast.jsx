import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

/*
 * One transient confirmation at a time. An action says what it did in a
 * sentence; the toast shows it for a few seconds and goes, and a new one
 * replaces the last. Moving to another screen clears it — a tab change
 * within the same screen does not, since the desk's actions move the
 * work on a stage as they land.
 */
const TTL_MS = 6000;
const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const seq = useRef(0);
  const { pathname } = useLocation();

  const show = useCallback((text, { tone = 'info' } = {}) => {
    seq.current += 1;
    setToast({ id: seq.current, text, tone });
  }, []);
  const dismiss = useCallback(() => setToast(null), []);

  useEffect(() => { setToast(null); }, [pathname]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), TTL_MS);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toast && (
          <div className={`toast toast-${toast.tone}`}>
            <span className="toast-text">{toast.text}</span>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={dismiss}>×</button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}

/** The one call an action makes: `toast('Sent to 12 reinsurers.')`. */
export function useToast() {
  return useContext(ToastContext);
}
