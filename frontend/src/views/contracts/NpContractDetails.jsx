import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, ErrorBanner } from '../../components.jsx';
import { useScreenHead } from '../../shell.jsx';
import { useHasRole } from '../../auth.jsx';
import { useToast } from '../../toast.jsx';
import { rememberContract } from '../../TopBar.jsx';
import { useContractHeader, ContractDetailsPane, ContractSummary, enterMovesToNextField } from './ContractDetailsPane.jsx';
import { npMissingRequiredFields } from './calcs.js';

/**
 * Contracts → Non-proportional: the Universe NP Treaty Detail's LEFT PANE
 * only — CONTRACT DETAILS, with the non-proportional treaty types (Risk XL,
 * CAT XL, Risk & CAT XL, Stop Loss, Aggregate XL) and the classes of
 * business picker — beside nothing: the tool's right pane, the structure
 * terms, is not part of this tool. The same dropdowns, the same derived UW
 * year and contract description, the same renewal default, and the same
 * required set (Country, Cedant, Treaty Type, Classes of Business, Broker,
 * Currency, Treaty Inception Date, Experience Start Year), highlighted after
 * the first save attempt. Ctrl+S saves.
 */
export default function NpContractDetails() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const canEdit = useHasRole('broker', 'admin');
  const placement = useFetch('GET', id ? `/placements/${id}` : null, [id]);
  const pd = isNew ? NEW_CONTRACT : placement.data;
  useScreenHead('Contracts · Non-proportional', 'Contract Details', pd?.reference || 'NEW');

  const h = useContractHeader({ pd, isNew, basis: 'NP' });
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const gridRef = useRef(null);
  const saveRef = useRef(null);
  const ro = !canEdit || busy;

  const missingList = useMemo(() => (h.ed ? npMissingRequiredFields(h.requiredSlice) : []), [h.ed, h.requiredSlice]);
  const missing = new Set(attempted ? missingList : []);

  async function save() {
    if (ro || !h.ed) return;
    setAttempted(true);
    setError(null);
    if (missingList.length) {
      window.scrollTo(0, 0);
      return;
    }
    setBusy(true);
    try {
      const cedantId = await h.resolveCedantId();
      const header = { cedant_id: cedantId, ...h.headerPayload() };
      let pid = id;
      if (isNew) pid = (await api('POST', '/placements', header)).id;
      else await api('PATCH', `/placements/${id}`, header);
      rememberContract({ id: pid, reference: pd?.reference || h.contractDescription, subtitle: h.cedName });
      if (isNew) {
        // Land on the contract's own URL; the confirmation follows the move,
        // since a route change clears whatever toast was showing.
        navigate(`/contracts/non-proportional/${pid}`, { replace: true });
        setTimeout(() => toast('Contract details saved.'), 0);
      } else {
        toast('Contract details saved.');
        placement.reload();
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  saveRef.current = save;

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') { e.preventDefault(); saveRef.current?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (placement.error) return <ErrorBanner error={placement.error} />;
  if (!pd || !h.ed) return null;

  return (
    <div className="screen contract-screen">
      <ContractSummary h={h} />
      {h.contractDescription && (
        <div className="td-contract"><span className="td-contract-label">Contract:</span>{h.contractDescription}</div>
      )}
      {attempted && missingList.length > 0 && (
        <div className="err banner" data-testid="required-summary">Required: {missingList.join(', ')}</div>
      )}
      <ErrorBanner error={error} />

      {/* The left pane only: the grid keeps the Universe layout, and the
          contract details sit in its first column. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div className="td-grid" ref={gridRef} onKeyDown={enterMovesToNextField(gridRef)} data-testid="np-contract-details">
        <ContractDetailsPane h={h} missing={missing} disabled={ro} contract={isNew ? null : pd} />
      </div>

      <div className="contract-actions">
        <Link className="btn btn-secondary" to="/contracts">← Contracts</Link>
        <span className="contract-actions-gap" />
        {!isNew && (
          <span className="muted small">
            {pd.reference} · {pd.status ? String(pd.status).toLowerCase().replace(/_/g, ' ') : ''}
          </span>
        )}
        {canEdit && (
          <button type="button" className="np-green-pill" disabled={busy} onClick={save} data-testid="save-contract-details">
            {busy ? 'Saving…' : 'Save contract details'}
          </button>
        )}
      </div>
    </div>
  );
}

/** The contract behind /contracts/non-proportional: nothing stored yet. */
const NEW_CONTRACT = {
  id: null, reference: '', status: 'DRAFT', layers: [], quote_structures: [], class: '', currency: 'USD', notes: '',
};
