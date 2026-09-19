// SummaryBar — key facts · UMR chip (click copies) · UUID chip · status badge ·
// optional renewal badge · an actions menu (Amend UMR) · optional extra controls
// (Triangulations available toggle on proportional screens).
import { useEffect, useRef, useState } from 'react';
import Badge from './Badge';

function Fact({ value }) { return <b>{value || '—'}</b>; }

export default function SummaryBar({ facts = [], umr, contractId, status, parentUmr, extra = null, onAmendUmr = null, actions = [] }) {
  const [copied, setCopied] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  async function copy(kind, text) {
    try { await navigator.clipboard?.writeText(text); setCopied(kind); setTimeout(() => setCopied(''), 1500); } catch { /* clipboard unavailable */ }
  }
  const shortId = contractId ? `${contractId.slice(0, 8)}…${contractId.slice(-4)}` : 'Assigned on create';
  const menuItems = [...(onAmendUmr ? [{ label: 'Amend UMR…', onClick: onAmendUmr }] : []), ...actions];

  return (
    <div className="ab-summary" data-testid="summary-bar">
      {facts.map((f, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && <span className="ab-sep">·</span>}
          <Fact value={f} />
        </span>
      ))}
      {parentUmr && <Badge variant="info">Renewal of {parentUmr}</Badge>}
      <span className="ab-right">
        {umr && (
          <button type="button" className="ab-id" title="Click to copy the UMR" aria-label={`UMR ${umr}, click to copy`} onClick={() => copy('umr', umr)}>
            <span className="ab-id-k">UMR</span><span className="ab-id-v" data-testid="umr-chip">{copied === 'umr' ? 'Copied' : umr}</span>
          </button>
        )}
        {contractId && (
          <button type="button" className="ab-id" title={`UUID ${contractId} — click to copy`} aria-label={`UUID ${contractId}, click to copy`} onClick={() => copy('uuid', contractId)}>
            <span className="ab-id-k">UUID</span><span className="ab-uuid" style={{ paddingRight: 10 }}>{copied === 'uuid' ? 'Copied' : shortId}</span>
          </button>
        )}
        {status && <Badge status={status} />}
        {extra}
        {menuItems.length > 0 && (
          <span className="ab-menu" ref={menuRef}>
            <button type="button" className="ab-btn ghost sm" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="Contract actions" onClick={() => setMenuOpen((o) => !o)}>⋯</button>
            {menuOpen && (
              <div className="ab-menu-list" role="menu">
                {menuItems.map((it) => (
                  <button key={it.label} type="button" role="menuitem" disabled={it.disabled} onClick={() => { setMenuOpen(false); it.onClick(); }}>{it.label}</button>
                ))}
              </div>
            )}
          </span>
        )}
      </span>
    </div>
  );
}
