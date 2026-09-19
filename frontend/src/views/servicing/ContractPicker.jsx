import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The premium and claims workspaces open on a question — which contract? —
 * asked the way the renewal wizard asks it: the country, then the cedant,
 * then the contract, each list following the pick above it. Choosing one
 * hands its id back and the workspace shows the whole placed structure.
 * Rendered through a portal so it takes the app's dialog styling rather
 * than the servicing screen's own control sizes.
 */
const NO_COUNTRY = 'Country not recorded';
const countryOf = t => t.country || NO_COUNTRY;
const year = v => String(v || '').slice(0, 4);
const describe = t => `${year(t.inception)} · ${t.reference} · ${t.class_of_business || t.class || 'Class not recorded'} · ${t.currency}${t.awaiting_review ? ' · awaiting review' : ''}`;
const tally = (list, key) => {
  const counts = new Map();
  for (const t of list) counts.set(key(t), (counts.get(key(t)) || 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
};

export default function ContractPicker({ kicker, title, contracts, loading = false, error = '', currentId = '', onChoose, onClose }) {
  const current = contracts.find(t => t.id === currentId);
  const [country, setCountry] = useState(current ? countryOf(current) : '');
  const [cedant, setCedant] = useState(current?.cedant_name || '');
  const [contract, setContract] = useState(current?.id || '');
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const countries = useMemo(() => tally(contracts, countryOf), [contracts]);
  const inCountry = useMemo(() => contracts.filter(t => countryOf(t) === country), [contracts, country]);
  const cedants = useMemo(() => tally(inCountry, t => t.cedant_name), [inCountry]);
  const candidates = useMemo(() => inCountry.filter(t => t.cedant_name === cedant).sort((a, b) => String(b.inception).localeCompare(String(a.inception))), [inCountry, cedant]);
  const steps = [['Country', !!country], ['Cedant', !!cedant], ['Contract', !!contract]];
  const firstOpen = steps.findIndex(([, done]) => !done);
  return createPortal(<div className="renew-modal">
    <div className="renew-backdrop" role="presentation" onClick={onClose} />
    <div className="renew-panel" role="dialog" aria-modal="true" aria-labelledby="sv-pick-title" data-testid="servicing-contract-picker">
      <div className="renew-head">
        <div><div className="renew-kicker">{kicker}</div><div className="renew-title" id="sv-pick-title">{title}</div></div>
        <button type="button" className="renew-x" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="renew-steps">
        {steps.map(([name, done], i) => <div key={name} className={`renew-step ${done ? 'done' : i === firstOpen ? 'active' : ''}`}><span className="dot" /><span>{name}</span></div>)}
      </div>
      <div className="renew-body">
        {error && <p role="alert" className="pw-error">{error}</p>}
        <div className="renew-field">
          <label className="renew-label" htmlFor="sv-pick-country">1) Select Country</label>
          <select id="sv-pick-country" ref={first} className="input" value={country} onChange={e => { setCountry(e.target.value); setCedant(''); setContract(''); }}>
            <option value="">{loading ? 'Loading…' : contracts.length ? 'Select country…' : 'No placed contracts yet'}</option>
            {countries.map(([name, n]) => <option key={name} value={name}>{name} ({n})</option>)}
          </select>
        </div>
        <div className="renew-field">
          <label className="renew-label" htmlFor="sv-pick-cedant">2) Select Cedant</label>
          <select id="sv-pick-cedant" className="input" value={cedant} disabled={!country} onChange={e => { setCedant(e.target.value); setContract(''); }}>
            <option value="">{country ? 'Select cedant…' : 'Select country first…'}</option>
            {cedants.map(([name, n]) => <option key={name} value={name}>{name} ({n})</option>)}
          </select>
        </div>
        <div className="renew-field">
          <label className="renew-label" htmlFor="sv-pick-contract">3) Select Contract</label>
          <select id="sv-pick-contract" className="input" value={contract} disabled={!cedant} onChange={e => setContract(e.target.value)}>
            <option value="">{cedant ? 'Select contract…' : 'Select cedant first…'}</option>
            {candidates.map(t => <option key={t.id} value={t.id}>{describe(t)}</option>)}
          </select>
        </div>
        <div className="renew-actions">
          <button type="button" className="renew-btn renew-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="renew-btn renew-btn--primary" disabled={!contract} onClick={() => onChoose(contract)}>Open contract</button>
        </div>
      </div>
    </div>
  </div>, document.body);
}
