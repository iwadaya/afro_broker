// AmendUmrDialog — the audited "Amend UMR" action: new UMR (normalised as typed,
// format message live, uniqueness on blur) + a reason, then POST amend-umr.
import { useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import FormRow from './FormRow';
import { api, errorBody } from '../../api';
import { normaliseUmr, umrFormatMessage, isValidUmr } from '../../../../shared/broking/calcs.js';

export default function AmendUmrDialog({ open, contractId, currentUmr, onClose, onAmended }) {
  const [umr, setUmr] = useState(currentUmr || '');
  const [reason, setReason] = useState('');
  const [check, setCheck] = useState({ state: 'idle', text: umrFormatMessage(currentUmr) || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function onInput(v) {
    const n = normaliseUmr(v); setUmr(n); setError('');
    const msg = umrFormatMessage(n);
    if (n === currentUmr) setCheck({ state: 'bad', text: 'This is the current UMR — enter a different reference.' });
    else setCheck(msg ? { state: 'bad', text: msg } : { state: 'idle', text: 'Format OK — checking on leave' });
  }
  async function onBlur() {
    if (!isValidUmr(umr) || umr === currentUmr) return;
    setCheck({ state: 'idle', text: 'Checking…' });
    try {
      const r = await api.broking.byUmr(umr);
      const owner = r.ownedByOtherOrganisation ? 'another organisation' : [r.cedant, r.treatyType, r.uwYear].filter(Boolean).join(' ') || 'another contract';
      setCheck({ state: 'bad', text: `UMR ${umr} is already used by ${owner} — change the reference.` });
    } catch (e) {
      if (e.status === 404) setCheck({ state: 'ok', text: `✓ ${umr} is available` });
      else setCheck({ state: 'bad', text: errorBody(e)?.error || 'Could not check the UMR' });
    }
  }
  async function submit() {
    setBusy(true); setError('');
    try {
      const r = await api.broking.amendUmr(contractId, { newUmr: umr, reason });
      onAmended?.(r);
    } catch (e) {
      setError(errorBody(e)?.error || e.message || 'Amend failed');
    } finally { setBusy(false); }
  }
  const canSubmit = check.state === 'ok' && reason.trim().length >= 3 && !busy;
  return (
    <Modal open={open} onClose={onClose} title="Amend UMR" tag="Audited"
      footer={<><span className="ab-help">The previous reference is kept in the UMR history.</span><span className="ab-right"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={!canSubmit}>Amend UMR</Button></span></>}>
      <FormRow label="Current UMR"><span className="ab-id"><span className="ab-id-k">UMR</span><span className="ab-id-v">{currentUmr}</span></span></FormRow>
      <FormRow label="New UMR" htmlFor="amend-umr" required>
        <input id="amend-umr" className="ab-in ab-umr-input" value={umr} maxLength={17} autoComplete="off" spellCheck={false}
          onChange={(e) => onInput(e.target.value)} onBlur={onBlur} />
        <div className={`ab-umr-status is-${check.state}`} data-testid="amend-umr-status">{check.text}</div>
      </FormRow>
      <FormRow label="Reason" htmlFor="amend-reason" required>
        <textarea id="amend-reason" className="ab-in" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is the reference changing?" />
      </FormRow>
      {error && <div className="ab-umr-status is-bad" role="alert">{error}</div>}
    </Modal>
  );
}
