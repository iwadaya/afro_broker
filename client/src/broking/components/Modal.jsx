// Modal — accessible dialog (pattern from Universe ui/Modal): focus moves in and is
// trapped, Esc and backdrop close, focus returns on close.
import { useEffect, useId, useRef } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function Modal({ open, onClose, title, tag, footer = null, wide = false, closeOnBackdrop = true, children }) {
  const panelRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement;
    const panel = panelRef.current;
    const first = panel?.querySelector(FOCUSABLE);
    (first || panel)?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return; }
      if (e.key !== 'Tab' || !panel) return;
      const els = Array.from(panel.querySelectorAll(FOCUSABLE));
      if (!els.length) { e.preventDefault(); panel.focus(); return; }
      const firstEl = els[0], lastEl = els[els.length - 1], active = document.activeElement;
      if (e.shiftKey && (active === firstEl || active === panel)) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="ab ab-modal-backdrop" role="presentation" onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose?.(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`ab-modal${wide ? ' wide' : ''}`}>
        <div className="ab-modal-head">
          <h2 className="ab-modal-title" id={titleId}>{title}</h2>
          <span className="ab-table-bar">
            {tag && <span className="ab-tag">{tag}</span>}
            <button type="button" className="ab-btn ghost sm" aria-label="Close dialog" onClick={() => onClose?.()}>✕</button>
          </span>
        </div>
        <div className="ab-modal-body">{children}</div>
        {footer && <div className="ab-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
