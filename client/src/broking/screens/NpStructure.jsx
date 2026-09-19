// /broking/:contractId/structure — the Universe NP Structure screen: header pill
// NON-PROPORTIONAL TREATY: STRUCTURE, RISK XL / CAT XL pills from the treaty
// type, the programme strip (the terms Universe keeps in the NP Treaty Detail
// right pane) and the layer table — or the Stop Loss / Aggregate XL variants.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Pane from '../components/Pane';
import FormRow from '../components/FormRow';
import NumericInput from '../components/NumericInput';
import Button from '../components/Button';
import ErrorSummary from '../components/ErrorSummary';
import SaveStatus from '../components/SaveStatus';
import LayerTable, { TypePills } from '../components/LayerTable';
import StopLossTable from '../components/StopLossTable';
import AggregateXlTable from '../components/AggregateXlTable';
import ContractHeaderBar from './ContractHeaderBar';
import { useAutosaveOnLeave } from '../hooks/useBrokingContract';
import { useGlobalToast } from '../../hooks/useToast';
import { npStructureReducer, hydrateFromBundle } from '../state/npStructureReducer';
import { structurePayloadFromSlice, structureMissing, XL_TYPES, ACCOUNTING_METHODS, ACCOUNTS } from '../lib/npSlice';
import { isStopLossType, isAggregateXlType } from '../../../../shared/broking/calcs.js';

const STEP = 'structure';

export default function NpStructure({ contract, stepRef, markAttempted }) {
  const { bundle, save: saveBundle, saving, savedAt, saveError, reload } = contract;
  const showToast = useGlobalToast();
  const [state, dispatch] = useReducer(npStructureReducer, bundle, hydrateFromBundle);
  const [attempted, setAttempted] = useState(false);
  const [serverMessage, setServerMessage] = useState(null);
  const dirtyRef = useRef(false); const saveRef = useRef(null); const stateRef = useRef(state);
  const hydratedVersion = useRef(bundle?.rowVersion ?? null);
  useEffect(() => { stateRef.current = state; dirtyRef.current = state.dirty; }, [state]);
  useEffect(() => {
    if (!bundle) return;
    if (hydratedVersion.current === bundle.rowVersion && hydratedVersion.current !== null) return;
    hydratedVersion.current = bundle.rowVersion;
    dispatch({ type: 'hydrate', bundle });
  }, [bundle]);

  const typeName = state.typeName || bundle?.header?.treatyTypeName || '';
  const stopLoss = isStopLossType(typeName); const aggXl = isAggregateXlType(typeName);
  const currency = bundle?.header?.currencyCode || '';
  const missing = useMemo(() => structureMissing(state.layers, typeName), [state.layers, typeName]);
  const missingRef = useRef(missing); useEffect(() => { missingRef.current = missing; }, [missing]);
  const shown = attempted ? missing : [];

  const doSave = useCallback(async ({ draft = false } = {}) => {
    if (!draft) {
      setAttempted(true);
      if (missingRef.current.length) { markAttempted?.(STEP, true); return { ok: false, missing: missingRef.current }; }
    }
    const cur = stateRef.current;
    const res = await saveBundle('np-structure', structurePayloadFromSlice({ programme: cur.programme, layers: cur.layers }, cur.typeName), { draft });
    if (res.ok) { dirtyRef.current = false; dispatch({ type: 'clean' }); if (!draft) { markAttempted?.(STEP, false); showToast('Structure saved.'); } }
    else if (!res.conflict) setServerMessage([res.message, ...(res.fields || []).map((f) => `${f.path}: ${f.message}`)].filter(Boolean).join(' — '));
    return res;
  }, [saveBundle, markAttempted, showToast]);
  useEffect(() => { saveRef.current = doSave; if (stepRef) stepRef.current = { save: doSave }; }, [doSave, stepRef]);
  useAutosaveOnLeave({ dirtyRef, saveRef });

  const setProg = (key) => (value) => { setServerMessage(null); dispatch({ type: 'programme/edited', key, value }); };
  const updateLayer = useCallback((idx, field, value) => { setServerMessage(null); dispatch({ type: 'layer/fieldEdited', idx, field, value }); }, []);
  const addLayer = useCallback(() => dispatch({ type: 'layer/added' }), []);
  const deleteLast = useCallback(() => dispatch({ type: 'layer/lastDeleted' }), []);
  const onPaste = useCallback((startRow, field, matrix) => dispatch({ type: 'layer/pasted', startRow, field, matrix }), []);

  if (!bundle) return null;
  const h = bundle.header || {};
  const facts = [h.cedantName, h.countryName, h.brokerName, h.currencyCode, h.treatyTypeName, (h.classNames || []).join(', ')];
  const p = state.programme;
  const table = stopLoss
    ? <StopLossTable layers={state.layers} currency={currency} onUpdateLayer={updateLayer} onAddLayer={addLayer} onDeleteLastLayer={deleteLast} />
    : aggXl
      ? <AggregateXlTable layers={state.layers} currency={currency} onUpdateLayer={updateLayer} onAddLayer={addLayer} onDeleteLastLayer={deleteLast} />
      : <LayerTable layers={state.layers} mode={state.mode} currency={currency} onUpdateLayer={updateLayer} onAddLayer={addLayer} onDeleteLastLayer={deleteLast} onPaste={onPaste} />;

  return (
    <>
      <ContractHeaderBar bundle={bundle} step={STEP} facts={facts} onAmended={() => reload()} extra={<TypePills mode={state.mode} />} />
      <ErrorSummary missing={shown} message={serverMessage} />
      <Pane title="Programme" tag="Terms" className="ab-programme" data-testid="programme-strip">
        <FormRow label="Deductible" htmlFor="np-deductible" hint={aggXl ? null : <div className="ab-help">Layer-1 attachment; changing it re-cascades every attachment.</div>}>
          <NumericInput id="np-deductible" kind="money" value={p.deductible} onChange={setProg('deductible')} currency={currency} placeholder="e.g. 1,000,000" />
        </FormRow>
        <FormRow label="Type of XL" htmlFor="np-xltype">
          <select id="np-xltype" className="ab-sel" value={p.xlType || ''} onChange={(e) => setProg('xlType')(e.target.value)}><option value="">Select…</option>{XL_TYPES.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        </FormRow>
        <FormRow label="Accounting Method" htmlFor="np-accounting">
          <select id="np-accounting" className="ab-sel" value={p.accountingMethod || ''} onChange={(e) => setProg('accountingMethod')(e.target.value)}><option value="">Select…</option>{ACCOUNTING_METHODS.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        </FormRow>
        <FormRow label="Accounts" htmlFor="np-accounts">
          <select id="np-accounts" className="ab-sel" value={p.accounts || ''} onChange={(e) => setProg('accounts')(e.target.value)}><option value="">Select…</option>{ACCOUNTS.map((x) => <option key={x} value={x}>{x}</option>)}</select>
        </FormRow>
        <FormRow label="Est. GNPI" htmlFor="np-estgnpi" hint={<div className="ab-help">Default EGNPI for new layers.</div>}>
          <NumericInput id="np-estgnpi" kind="money" value={p.estGnpi} onChange={setProg('estGnpi')} currency={currency} placeholder="e.g. 50,000,000" />
        </FormRow>
        <FormRow label="Brokerage %" htmlFor="np-brokerage"><NumericInput id="np-brokerage" kind="pct" value={p.brokeragePct} onChange={setProg('brokeragePct')} placeholder="e.g. 10%" /></FormRow>
        <FormRow label="Taxes %" htmlFor="np-taxes"><NumericInput id="np-taxes" kind="pct" value={p.taxesPct} onChange={setProg('taxesPct')} placeholder="e.g. 2%" /></FormRow>
        <FormRow label="No Claims Bonus %" htmlFor="np-ncb"><NumericInput id="np-ncb" kind="pct" value={p.noClaimsBonusPct} onChange={setProg('noClaimsBonusPct')} placeholder="e.g. 5%" /></FormRow>
        <FormRow label="Profit Commission %" htmlFor="np-pc"><NumericInput id="np-pc" kind="pct" value={p.profitCommissionPct} onChange={setProg('profitCommissionPct')} placeholder="e.g. 10%" /></FormRow>
      </Pane>
      <div style={{ marginTop: 18 }}>{table}</div>
      <div className="ab-footer-actions">
        <SaveStatus savedAt={savedAt} dirty={state.dirty} saving={saving} error={saveError?.message} />
        <Button to={`/broking/${bundle.contractId}/contract-details`}>Back</Button>
        <Button variant="primary" onClick={() => doSave({ draft: false })} disabled={saving} data-testid="save-structure">Save structure</Button>
      </div>
    </>
  );
}
