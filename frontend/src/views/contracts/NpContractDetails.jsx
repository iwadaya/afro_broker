import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, ErrorBanner } from '../../components.jsx';
import { useScreenHead } from '../../shell.jsx';
import { useHasRole } from '../../auth.jsx';
import { useToast } from '../../toast.jsx';
import { rememberContract } from '../../TopBar.jsx';
import WizardNav from '../../WizardNav.jsx';
import { Fr } from '../treatyDetail.jsx';
import { useContractHeader, ContractDetailsPane, ContractSummary, enterMovesToNextField } from './ContractDetailsPane.jsx';
import {
  emptyNpTerms, npTermsOf, withNpStructure, detailPath, documentsPath,
  NP_XL_TYPES, NP_ACCOUNTING_METHODS, NP_ACCOUNTS,
} from './contractModel.js';
import { NumField } from './propTerms.jsx';
import { npMissingRequiredFields, toNumber } from './calcs.js';

/**
 * Contracts → Non-proportional: the Universe NP Treaty Detail — the
 * CONTRACT DETAILS pane on the left, with the non-proportional treaty types
 * (Risk XL, CAT XL, Risk & CAT XL, Stop Loss, Aggregate XL) and the classes
 * of business picker, the same dropdowns, derived UW year, contract
 * description and renewal default as the proportional page; and the
 * STRUCTURE pane on the right: the layer configuration (number of layers,
 * the expiring number, deductible, maximum retention, accounting method,
 * type of XL, accounts) and the premium & commissions (Est. GNPI,
 * brokerage, taxes, no claims bonus, profit commission). The required set
 * is the contract details' (country, cedant, treaty type, classes, broker,
 * currency, inception, experience start year), highlighted after the first
 * save attempt; the structure terms are optional. The dock at the foot of
 * the window floats and fades when idle: Back, Save, and Save & next to the
 * Documents step. Ctrl+S saves.
 *
 * The contract is a placement: the details go on its header, the structure
 * terms on its non-proportional structure, and Est. GNPI is its estimated
 * premium so the calendar reads the treaty's size.
 */
export default function NpContractDetails() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const canEdit = useHasRole('broker', 'admin');
  const placement = useFetch('GET', id ? `/placements/${id}` : null, [id]);
  const pd = isNew ? NEW_CONTRACT : placement.data;
  useScreenHead('Contracts · Non-proportional · 1 of 3', 'Contract Details', pd?.reference || 'NEW');

  const h = useContractHeader({ pd, isNew, basis: 'NP' });
  const [terms, setTerms] = useState(emptyNpTerms);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const gridRef = useRef(null);
  const saveRef = useRef(null);
  const ro = !canEdit || busy;
  const ccy = h.currencyCode || 'CCY';

  // The stored structure terms, hydrated with the placement.
  useEffect(() => {
    if (!pd) return;
    setTerms(npTermsOf(pd));
  }, [pd?.id, pd?.updated_at]);
  const set = (patch) => setTerms((t) => ({ ...t, ...patch }));

  const missingList = useMemo(() => (h.ed ? npMissingRequiredFields(h.requiredSlice) : []), [h.ed, h.requiredSlice]);
  const missing = new Set(attempted ? missingList : []);

  /** Write the contract: the header, the structure terms, the estimated
      premium. Resolves to the contract's id, or null when held or failed. */
  async function persist() {
    if (ro || !h.ed) return null;
    setAttempted(true);
    setError(null);
    if (missingList.length) {
      window.scrollTo(0, 0);
      return null;
    }
    setBusy(true);
    try {
      const cedantId = await h.resolveCedantId();
      const gnpi = toNumber(terms.estGnpi);
      const header = { cedant_id: cedantId, ...h.headerPayload(), ...(gnpi != null ? { est_gwp: gnpi } : {}) };
      const structure = { basis: 'NP', npTreatyType: h.treatyTypeName, np: { ...terms } };
      let pid = id;
      if (isNew) {
        const created = await api('POST', '/placements', header);
        pid = created.id;
        await api('PATCH', `/placements/${pid}`, { quote_structures: [{ ...structure, layers: [] }] });
      } else {
        await api('PATCH', `/placements/${id}`, { ...header, quote_structures: withNpStructure(pd, structure) });
      }
      rememberContract({ id: pid, reference: pd?.reference || h.contractDescription, subtitle: h.cedName });
      return pid;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const pid = await persist();
    if (!pid) return;
    if (isNew) {
      // Land on the contract's own URL; the confirmation follows the move,
      // since a route change clears whatever toast was showing.
      navigate(detailPath('NP', pid), { replace: true });
      setTimeout(() => toast('Contract details saved.'), 0);
    } else {
      toast('Contract details saved.');
      placement.reload();
    }
  }

  /** Save & next: the Documents step, once the contract is written. */
  async function saveAndNext() {
    if (!canEdit) { if (!isNew) navigate(documentsPath('NP', id)); return; }
    const pid = await persist();
    if (!pid) return;
    navigate(documentsPath('NP', pid));
    setTimeout(() => toast('Contract details saved.'), 0);
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

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div className="td-grid" ref={gridRef} onKeyDown={enterMovesToNextField(gridRef)} data-testid="np-contract-details">
        {/* ═══ CONTRACT DETAILS (left) ═══ */}
        <ContractDetailsPane h={h} missing={missing} disabled={ro} contract={isNew ? null : pd} />

        {/* ═══ STRUCTURE (right) ═══ */}
        <div className="td-card td-card--pane" data-testid="np-structure">
          <div className="td-card-head">
            <span className="td-card-label">STRUCTURE</span>
            <span className="td-card-tag">TERMS</span>
          </div>
          <div className="td-card-body">
            <div className="td-block">
              <div className="td-mini">Layer configuration</div>
              <Fr label="Number of Layers">
                <NumField value={terms.numLayers} onChange={(v) => set({ numLayers: v })} readOnly={ro}
                  placeholder="e.g. 4" aria-label="Number of Layers" inputMode="numeric" />
              </Fr>
              <Fr label="Expiring · Number of Layers">
                <NumField value={terms.expiringNumLayers} onChange={(v) => set({ expiringNumLayers: v })} readOnly={ro}
                  placeholder="e.g. 4" aria-label="Expiring · Number of Layers" inputMode="numeric" />
              </Fr>
              <Fr label={`Deductible (${ccy})`} hint="The first layer's attachment">
                <NumField value={terms.deductible} onChange={(v) => set({ deductible: v })} readOnly={ro}
                  placeholder="e.g. 1,000,000" aria-label="Deductible" />
              </Fr>
              <Fr label={`Maximum Retention (${ccy})`}>
                <NumField value={terms.maxRetention} onChange={(v) => set({ maxRetention: v })} readOnly={ro}
                  placeholder="e.g. 5,000,000" aria-label="Maximum Retention" />
              </Fr>
              <Fr label="Accounting Method">
                <select className="fi" value={terms.accountingMethod} disabled={ro} aria-label="Accounting Method"
                  onChange={(e) => set({ accountingMethod: e.target.value })}>
                  <option value="">Select…</option>
                  {terms.accountingMethod && !NP_ACCOUNTING_METHODS.includes(terms.accountingMethod) && (
                    <option value={terms.accountingMethod}>{terms.accountingMethod}</option>
                  )}
                  {NP_ACCOUNTING_METHODS.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </Fr>
              <Fr label="Type of XL">
                <select className="fi" value={terms.xlType} disabled={ro} aria-label="Type of XL"
                  onChange={(e) => set({ xlType: e.target.value })}>
                  <option value="">Select…</option>
                  {terms.xlType && !NP_XL_TYPES.includes(terms.xlType) && <option value={terms.xlType}>{terms.xlType}</option>}
                  {NP_XL_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </Fr>
              <Fr label="Accounts">
                <select className="fi" value={terms.accounts} disabled={ro} aria-label="Accounts"
                  onChange={(e) => set({ accounts: e.target.value })}>
                  <option value="">Select…</option>
                  {terms.accounts && !NP_ACCOUNTS.includes(terms.accounts) && <option value={terms.accounts}>{terms.accounts}</option>}
                  {NP_ACCOUNTS.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </Fr>
            </div>
            <div className="td-block">
              <div className="td-mini">Premium &amp; commissions</div>
              <Fr label={`Est. GNPI (${ccy})`} hint="Estimated gross net premium income — the treaty's size on the calendar">
                <NumField value={terms.estGnpi} onChange={(v) => set({ estGnpi: v })} readOnly={ro}
                  placeholder="e.g. 50,000,000" aria-label="Est. GNPI" />
              </Fr>
              <Fr label="Brokerage %">
                <NumField suffix="%" value={terms.brokeragePct} onChange={(v) => set({ brokeragePct: v })} readOnly={ro}
                  placeholder="e.g. 10%" aria-label="Brokerage %" />
              </Fr>
              <Fr label="Taxes %">
                <NumField suffix="%" value={terms.taxesPct} onChange={(v) => set({ taxesPct: v })} readOnly={ro}
                  placeholder="e.g. 2%" aria-label="Taxes %" />
              </Fr>
              <Fr label="No Claims Bonus %">
                <NumField suffix="%" value={terms.noClaimsBonusPct} onChange={(v) => set({ noClaimsBonusPct: v })} readOnly={ro}
                  placeholder="e.g. 5%" aria-label="No Claims Bonus %" />
              </Fr>
              <Fr label="Profit Commission %">
                <NumField suffix="%" value={terms.profitCommissionPct} onChange={(v) => set({ profitCommissionPct: v })} readOnly={ro}
                  placeholder="e.g. 10%" aria-label="Profit Commission %" />
              </Fr>
            </div>
          </div>
        </div>
      </div>

      {/* The floating dock: Back to the register, Save, Save & next to Documents. */}
      <WizardNav
        hasPrev onBack={() => navigate('/contracts')} backLabel="Contracts"
        hasNext onNext={saveAndNext} nextLabel="Documents"
        nextText={canEdit ? 'Save & next: Documents' : 'Next: Documents'}
        nextDisabled={busy || (!canEdit && isNew)}
        nextTitle={!canEdit && isNew ? 'Nothing to open yet' : ''}
      >
        {canEdit && (
          <button type="button" className="wizard-dock-btn wizard-dock-btn--save" disabled={busy} onClick={save}
            data-testid="save-contract-details">
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
      </WizardNav>
    </div>
  );
}

/** The contract behind /contracts/non-proportional: nothing stored yet. */
const NEW_CONTRACT = {
  id: null, reference: '', status: 'DRAFT', layers: [], quote_structures: [], class: '', currency: 'USD', notes: '',
};
