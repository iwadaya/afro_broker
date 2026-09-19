// IdentityField — the first thing captured on every contract (design system
// components/IdentityField/README.md): the Lloyd's UMR validated for FORMAT as it
// is typed and for UNIQUENESS on blur, plus the business type and an optional
// "Renewal of" link to a prior-year contract.
//
// The consumer provides:
//   lloydsBrokerNo     the broker's 4-digit Lloyd's number → pre-fills "B0621"
//   onCheck(umr)       GET /api/broking/contracts/by-umr/:umr — resolves to the owner
//                      (200 body) or rejects with an HttpError (404 = available)
//   onCreate(payload)  POST /api/broking/contracts → { contractId, umr, businessType }
//   onSearch(term)     optional: search prior contracts for the "Renewal of" picker
//   onCreated(result)  called after a successful create (the screen routes onwards)
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Pane from './Pane';
import FormRow from './FormRow';
import TogglePill from './TogglePill';
import Button from './Button';
import Badge from './Badge';
import { normaliseUmr, isValidUmr, umrFormatMessage, UMR_MAX_LENGTH } from '../../../../shared/broking/calcs.js';
import { firstCaptureStep } from '../steps';

export const BUSINESS_TYPES = [
  { value: 'PROPORTIONAL', label: 'Proportional' },
  { value: 'NON_PROPORTIONAL', label: 'Non-proportional' },
];

const IDLE_MESSAGE = 'B + 4-digit broker no. + up to 12 characters';

export function describeOwner(o) {
  return [o?.cedant, o?.treatyType, o?.uwYear].filter(Boolean).join(' ') || 'another contract';
}

/** Derive the status line from the typed value + the last uniqueness check. */
export function umrStatus(umr, check) {
  const u = normaliseUmr(umr);
  const prefixOnly = u.length <= 5;
  if (prefixOnly) return { kind: 'idle', text: IDLE_MESSAGE };
  const format = umrFormatMessage(u);
  if (format) return { kind: 'bad', text: format };
  if (check && check.umr === u) {
    if (check.state === 'checking') return { kind: 'idle', text: `Checking ${u}…` };
    if (check.state === 'available') return { kind: 'ok', text: `✓ ${u} is available` };
    if (check.state === 'taken') return { kind: 'taken', text: `UMR ${u} is already used by ${describeOwner(check.owner)} — open it or change the reference.`, owner: check.owner };
    if (check.state === 'other-org') return { kind: 'taken', text: `UMR ${u} is already used by a contract in another organisation — change the reference.` };
    if (check.state === 'error') return { kind: 'bad', text: check.message || 'Could not check the UMR — try again.' };
  }
  return { kind: 'idle', text: 'Format OK — checking on leave' };
}

export default function IdentityField({ lloydsBrokerNo, onCheck, onCreate, onSearch = null, onCreated = null, initialBusinessType = 'PROPORTIONAL' }) {
  const prefix = `B${lloydsBrokerNo || ''}`;
  const [umr, setUmr] = useState(prefix);
  const [businessType, setBusinessType] = useState(initialBusinessType);
  const [check, setCheck] = useState(null);           // { umr, state, owner?, message? }
  const [parent, setParent] = useState(null);         // chosen renewal parent (list row)
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const seq = useRef(0);

  // Pre-fill once the broker number arrives (settings load asynchronously).
  useEffect(() => { setUmr((cur) => (cur === 'B' || cur === '' ? prefix : cur)); }, [prefix]);

  const status = useMemo(() => umrStatus(umr, check), [umr, check]);
  const available = status.kind === 'ok';

  function onInput(e) {
    const v = normaliseUmr(e.target.value).slice(0, UMR_MAX_LENGTH);
    setUmr(v); setCreateError('');
  }

  async function verify(value = umr) {
    const u = normaliseUmr(value);
    if (!isValidUmr(u)) return null;
    // Already answered for this exact reference: no second round trip on every blur.
    if (check && check.umr === u && ['available', 'taken', 'other-org'].includes(check.state)) return check;
    const my = ++seq.current;
    setCheck({ umr: u, state: 'checking' });
    try {
      const owner = await onCheck(u);
      if (my !== seq.current) return null;
      const next = owner?.ownedByOtherOrganisation ? { umr: u, state: 'other-org' } : { umr: u, state: 'taken', owner };
      setCheck(next); return next;
    } catch (e) {
      if (my !== seq.current) return null;
      const next = e?.status === 404 ? { umr: u, state: 'available' }
        : { umr: u, state: 'error', message: e?.body?.error || e?.message || 'Could not check the UMR — try again.' };
      setCheck(next); return next;
    }
  }

  async function create() {
    if (!available || creating) return;
    setCreating(true); setCreateError('');
    try {
      const result = await onCreate({ umr: normaliseUmr(umr), businessType, parentContractId: parent?.contractId || null });
      onCreated?.(result);
    } catch (e) {
      const body = e?.body || {};
      if (e?.status === 409 && body.code === 'UMR_TAKEN') {
        setCheck(body.ownedByOtherOrganisation ? { umr: normaliseUmr(umr), state: 'other-org' }
          : { umr: normaliseUmr(umr), state: 'taken', owner: { contractId: body.contractId, cedant: body.cedant, treatyType: body.treatyType, uwYear: body.uwYear, businessType } });
      } else {
        setCreateError(body.error || e?.message || 'Could not create the contract.');
      }
    } finally { setCreating(false); }
  }

  function chooseParent(row) {
    setParent(row);
    if (row) setBusinessType(row.businessType);   // a renewal keeps the parent's business type
  }

  const openHref = status.owner?.contractId ? `/broking/${status.owner.contractId}/${firstCaptureStep(status.owner.businessType || 'PROPORTIONAL')}` : null;

  return (
    <Pane title="Identify contract" tag="Step 1" data-testid="identity-field">
      <FormRow label="UMR" htmlFor="umr" required missing={status.kind === 'bad' || status.kind === 'taken'}
        hint={(
          <div id="umr-status" className={`ab-umr-status is-${status.kind === 'taken' ? 'bad' : status.kind}`} role="status" aria-live="polite" data-testid="umr-status">
            <span>{status.text}</span>
            {openHref && <Link to={openHref} data-testid="umr-open-link">Open it</Link>}
          </div>
        )}>
        <input id="umr" className={`ab-in ab-umr-input${status.kind === 'bad' || status.kind === 'taken' ? ' is-error' : ''}`} value={umr}
          maxLength={UMR_MAX_LENGTH} autoComplete="off" spellCheck={false} aria-describedby="umr-status" aria-invalid={status.kind === 'bad' || status.kind === 'taken'}
          onChange={onInput} onBlur={() => verify()} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); verify(); } }} />
      </FormRow>
      <FormRow label="Business type" required disabledReason={parent ? 'A renewal keeps the parent contract\'s business type' : null}>
        <TogglePill options={BUSINESS_TYPES} value={businessType} onChange={setBusinessType} ariaLabel="Business type" disabled={!!parent} />
      </FormRow>
      <FormRow label="Renewal of" htmlFor="renewal-of" hint={parent ? <div className="ab-help">Header, classes and details are copied from {parent.umr}; the inception date rolls forward 12 months.</div> : null}>
        {parent ? (
          <span className="ab-inline-fields">
            <span className="ab-id"><span className="ab-id-k">UMR</span><span className="ab-id-v" data-testid="parent-umr">{parent.umr}</span></span>
            <Badge variant="info">{[parent.cedantName, parent.treatyTypeName, parent.uwYear].filter(Boolean).join(' ')}</Badge>
            <Button size="sm" onClick={() => chooseParent(null)}>Clear</Button>
          </span>
        ) : (
          <RenewalSearch onSearch={onSearch} onPick={chooseParent} />
        )}
      </FormRow>
      <FormRow label="Contract ID"><span className="ab-uuid" data-testid="uuid">Assigned on create</span></FormRow>
      {createError && <div className="ab-notice danger" role="alert">{createError}</div>}
      <div className="ab-actions">
        <Button variant="primary" onClick={create} disabled={!available || creating} data-testid="create-contract">{creating ? 'Creating…' : 'Create contract'}</Button>
      </div>
    </Pane>
  );
}

/** "Renewal of" — search prior UMRs / cedants and pick the parent contract. */
function RenewalSearch({ onSearch, onPick }) {
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (!onSearch || term.trim().length < 2) { setRows([]); return undefined; }
    let cancelled = false;
    const t = setTimeout(() => {
      Promise.resolve(onSearch(term.trim())).then((r) => { if (!cancelled) { setRows((Array.isArray(r) ? r : []).slice(0, 8)); setOpen(true); setActive(-1); } }).catch(() => { if (!cancelled) setRows([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [term, onSearch]);
  const pick = (row) => { onPick(row); setTerm(''); setRows([]); setOpen(false); };
  const onKeyDown = (e) => {
    if (!open || rows.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(rows[active]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };
  return (
    <div className="ab-search">
      <input id="renewal-of" className="ab-in" placeholder={onSearch ? 'Search prior UMR or cedant…' : 'Not available'} disabled={!onSearch} value={term}
        autoComplete="off" role="combobox" aria-expanded={open && rows.length > 0} aria-controls="renewal-options" aria-autocomplete="list"
        onChange={(e) => setTerm(e.target.value)} onFocus={() => rows.length && setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKeyDown} />
      {open && rows.length > 0 && (
        <ul id="renewal-options" className="ab-search-pop" role="listbox">
          {rows.map((r, i) => (
            <li key={r.contractId} role="option" aria-selected={i === active} className={i === active ? 'is-active' : ''} onMouseDown={(e) => { e.preventDefault(); pick(r); }}>
              <span className="ab-mono">{r.umr}</span>
              <span className="ab-help">{[r.cedantName, r.treatyTypeName, r.uwYear].filter(Boolean).join(' · ') || (r.businessType === 'NON_PROPORTIONAL' ? 'Non-proportional' : 'Proportional')}</span>
            </li>
          ))}
        </ul>
      )}
      {open && term.trim().length >= 2 && rows.length === 0 && <div className="ab-help" style={{ marginTop: 4 }}>No prior contracts match.</div>}
    </div>
  );
}
