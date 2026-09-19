// /broking/:contractId/contract-details — the Universe NP Treaty Detail LEFT PANE
// only (NpTreatyDetail.jsx CONTRACT DETAILS), beside the contract's identity.
// NP treaty types: Risk XL · CAT XL · Risk & CAT XL · Stop Loss · Aggregate XL;
// the class picker is labelled "Classes of Business". The Universe right pane's
// structure terms live on the Structure screen's programme strip instead.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Pane from '../components/Pane';
import FormRow from '../components/FormRow';
import Button from '../components/Button';
import Badge from '../components/Badge';
import CobSelectModal from '../components/CobSelectModal';
import ErrorSummary from '../components/ErrorSummary';
import SaveStatus from '../components/SaveStatus';
import ContractHeaderBar from './ContractHeaderBar';
import { useCedants } from '../hooks/useLookups';
import { useAutosaveOnLeave } from '../hooks/useBrokingContract';
import { useGlobalToast } from '../../hooks/useToast';
import { headerSliceFromBundle, headerPayloadFromSlice, NP_TYPE_NAMES } from '../lib/npSlice';
import { formatDateTime } from '../lib/format';
import * as calcs from '../../../../shared/broking/calcs.js';

const STEP = 'contract-details';
const THIS_YEAR = new Date().getFullYear();
const EXPERIENCE_YEARS = Array.from({ length: 41 }, (_, i) => THIS_YEAR - 40 + i);
const byId = (list, id) => (list || []).find((x) => String(x.id) === String(id));

function surfaceFor(typeName) {
  if (calcs.isStopLossType(typeName)) return 'Stop Loss layers (Attach LR %, Limit LR %, EPI)';
  if (calcs.isAggregateXlType(typeName)) return 'Aggregate XL layers (Aggregate Limit, Aggregate Deductible, Deductible, AAD, Risk, Cat)';
  const mode = calcs.perilModeFromTreatyType(typeName);
  return `Layer table — ${mode === 'RISK' ? 'RISK XL (cat cover locked off)' : mode === 'CAT' ? 'CAT XL (risk cover locked off)' : 'Risk and Cat covers editable per layer'}`;
}

export default function NpContractDetails({ contract, lookups, stepRef, markAttempted }) {
  const { bundle, save: saveBundle, saving, savedAt, saveError, reload } = contract;
  const navigate = useNavigate();
  const showToast = useGlobalToast();
  const [s, setS] = useState(() => headerSliceFromBundle(bundle));
  const [attempted, setAttempted] = useState(false);
  const [serverMessage, setServerMessage] = useState(null);
  const [cobOpen, setCobOpen] = useState(false);
  const dirtyRef = useRef(false); const saveRef = useRef(null); const sRef = useRef(s);
  const hydratedVersion = useRef(bundle?.rowVersion ?? null);
  useEffect(() => { sRef.current = s; }, [s]);
  useEffect(() => {
    if (!bundle) return;
    if (hydratedVersion.current === bundle.rowVersion && hydratedVersion.current !== null) return;
    hydratedVersion.current = bundle.rowVersion;
    setS(headerSliceFromBundle(bundle)); dirtyRef.current = false;
  }, [bundle]);
  const update = useCallback((patch) => { dirtyRef.current = true; setServerMessage(null); setS((cur) => ({ ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) })); }, []);

  const { countries = [], currencies = [], brokers = [], classes = [] } = lookups || {};
  const treatyTypes = useMemo(() => (lookups?.treatyTypes || []).filter((t) => (t.category ? t.category === 'NON_PROPORTIONAL' : NP_TYPE_NAMES.has(t.name))), [lookups?.treatyTypes]);
  const cedants = useCedants(s.countryId);
  const h = bundle?.header || {};
  const typeName = byId(treatyTypes, s.treatyTypeId)?.name || (String(s.treatyTypeId) === String(h.treatyTypeId) ? h.treatyTypeName : '') || '';
  const country = byId(countries, s.countryId);
  const countryName = country?.name || (String(s.countryId) === String(h.countryId) ? h.countryName : '') || '';
  const countryCode = country?.code || (String(s.countryId) === String(h.countryId) ? h.countryCode : '') || '';
  const cedantName = byId(cedants, s.cedantId)?.name || (String(s.cedantId) === String(h.cedantId) ? h.cedantName : '') || '';
  const brokerName = byId(brokers, s.brokerId)?.name || (String(s.brokerId) === String(h.brokerId) ? h.brokerName : '') || '';
  const currencyCode = byId(currencies, s.currencyId)?.code || (String(s.currencyId) === String(h.currencyId) ? h.currencyCode : '') || '';
  const cobNames = useMemo(() => (s.classIds || []).map((id) => byId(classes, id)?.name || ((h.classIds || []).includes(id) ? h.classNames?.[(h.classIds || []).indexOf(id)] : null)).filter(Boolean), [s.classIds, classes, h.classIds, h.classNames]);
  const cobText = !cobNames.length ? 'Select classes…' : cobNames.length <= 2 ? cobNames.join(', ') : `${cobNames.slice(0, 2).join(', ')} +${cobNames.length - 2} more`;
  const uwYear = calcs.uwYearFromInception(s.inceptionDate);
  const description = calcs.buildContractDescription({ uwYear, cedantName, treatyTypeName: typeName, classNames: cobNames, countryCode });

  const missing = useMemo(() => calcs.npMissingRequiredFields(s), [s]);
  const missingRef = useRef(missing); useEffect(() => { missingRef.current = missing; }, [missing]);
  const shown = attempted ? missing : [];
  const miss = (label) => shown.includes(label);

  const doSave = useCallback(async ({ draft = false } = {}) => {
    if (!draft) {
      setAttempted(true);
      if (missingRef.current.length) { markAttempted?.(STEP, true); return { ok: false, missing: missingRef.current }; }
    }
    const res = await saveBundle('header', headerPayloadFromSlice(sRef.current), { draft });
    if (res.ok) { dirtyRef.current = false; if (!draft) { markAttempted?.(STEP, false); showToast('Contract details saved.'); } }
    else if (!res.conflict) setServerMessage([res.message, ...(res.fields || []).map((f) => `${f.path}: ${f.message}`)].filter(Boolean).join(' — '));
    return res;
  }, [saveBundle, markAttempted, showToast]);
  useEffect(() => { saveRef.current = doSave; if (stepRef) stepRef.current = { save: doSave }; }, [doSave, stepRef]);
  useAutosaveOnLeave({ dirtyRef, saveRef });

  const saveAndNext = async () => { const r = await doSave({ draft: false }); if (r.ok) navigate(`/broking/${bundle.contractId}/structure`); };
  const onInception = (v) => update((cur) => ({ inceptionDate: v, ...(cur._renewalManual ? {} : { renewalDate: calcs.defaultRenewalDate(v) }) }));

  if (!bundle) return null;
  const facts = [cedantName, countryName, brokerName, currencyCode, typeName, cobNames.join(', ')];
  return (
    <>
      <ContractHeaderBar bundle={bundle} step={STEP} facts={facts} onAmended={() => reload()} />
      <ErrorSummary missing={shown} message={serverMessage} />
      <div className="ab-grid-2" data-testid="np-contract-details">
        <Pane title="Contract Details" tag="Input">
          <FormRow label="Country" htmlFor="np-country" required missing={miss('Country')}>
            <select id="np-country" className="ab-sel" value={s.countryId || ''} onChange={(e) => update({ countryId: e.target.value, cedantId: '' })}>
              <option value="">Select country…</option>{countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FormRow>
          <FormRow label="Cedant Name" htmlFor="np-cedant" required missing={miss('Cedant Name')}>
            <select id="np-cedant" className="ab-sel" value={s.cedantId || ''} onChange={(e) => update({ cedantId: e.target.value })} disabled={!s.countryId}>
              <option value="">{s.countryId ? 'Select cedant…' : 'Select country first…'}</option>
              {cedants.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              {s.cedantId && !byId(cedants, s.cedantId) && h.cedantName && <option value={s.cedantId}>{h.cedantName}</option>}
            </select>
          </FormRow>
          <FormRow label="Treaty Type" htmlFor="np-type" required missing={miss('Treaty Type')} hint={typeName ? <div className="ab-help">Structure surface: {surfaceFor(typeName)}</div> : null}>
            <select id="np-type" className="ab-sel" value={s.treatyTypeId || ''} onChange={(e) => update({ treatyTypeId: e.target.value })}>
              <option value="">Select treaty type…</option>{treatyTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </FormRow>
          <FormRow label="Classes of Business" htmlFor="np-cob" required missing={miss('Classes of Business')}>
            <button id="np-cob" type="button" className={`ab-btn-field${cobNames.length ? '' : ' is-placeholder'}`} onClick={() => setCobOpen(true)} aria-haspopup="dialog" data-testid="cob-button">
              <span>{cobText}</span><span className="ab-help" aria-hidden="true">▾</span>
            </button>
          </FormRow>
          <FormRow label="Broker" htmlFor="np-broker" required missing={miss('Broker')}>
            <select id="np-broker" className="ab-sel" value={s.brokerId || ''} onChange={(e) => update({ brokerId: e.target.value })}>
              <option value="">Select broker…</option>{brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </FormRow>
          <FormRow label="Contract ID" htmlFor="np-uuid"><input id="np-uuid" className="ab-in is-derived ab-uuid" readOnly tabIndex={-1} value={bundle.contractId} aria-readonly="true" /></FormRow>
          <FormRow label="Currency" htmlFor="np-currency" required missing={miss('Currency')}>
            <select id="np-currency" className="ab-sel" value={s.currencyId || ''} onChange={(e) => update({ currencyId: e.target.value })}>
              <option value="">Select currency…</option>{currencies.map((c) => <option key={c.id} value={c.id}>{c.code || c.name}</option>)}
            </select>
          </FormRow>
          <FormRow label="Treaty Inception Date" htmlFor="np-inception" required missing={miss('Treaty Inception Date')}>
            <input id="np-inception" className="ab-in" type="date" value={s.inceptionDate || ''} onChange={(e) => onInception(e.target.value)} />
          </FormRow>
          <FormRow label="Treaty Renewal Date" htmlFor="np-renewal" hint={!s._renewalManual && s.inceptionDate ? <div className="ab-help">Defaults to inception + 12 months until edited.</div> : null}>
            <input id="np-renewal" className="ab-in" type="date" value={s.renewalDate || ''} onChange={(e) => update({ renewalDate: e.target.value, _renewalManual: true })} />
          </FormRow>
          <FormRow label="UW Year" htmlFor="np-uwyear"><input id="np-uwyear" className="ab-in is-derived" readOnly tabIndex={-1} value={uwYear || ''} title="Auto-derived from Inception Date" aria-readonly="true" /></FormRow>
          <FormRow label="Experience Start Year" htmlFor="np-expyear" required missing={miss('Experience Start Year')}>
            <select id="np-expyear" className="ab-sel" value={s.experienceStartYear || ''} onChange={(e) => update({ experienceStartYear: e.target.value })}>
              <option value="">Select start year…</option>{EXPERIENCE_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </FormRow>
          <FormRow label="Contract Description" htmlFor="np-desc"><input id="np-desc" className="ab-in is-derived" readOnly tabIndex={-1} value={description} aria-readonly="true" data-testid="contract-description" /></FormRow>
        </Pane>
        <Pane title="Identity" tag="Read-only">
          <FormRow label="UMR"><span className="ab-id"><span className="ab-id-k">UMR</span><span className="ab-id-v">{bundle.umr}</span></span></FormRow>
          <FormRow label="Contract ID"><span className="ab-uuid" data-testid="uuid">{bundle.contractId}</span></FormRow>
          <FormRow label="Business type"><Badge variant="info">Non-proportional</Badge></FormRow>
          <FormRow label="Status"><Badge status={bundle.status} /></FormRow>
          <FormRow label="Renewal of">{bundle.parentUmr ? <span className="ab-id"><span className="ab-id-k">UMR</span><span className="ab-id-v">{bundle.parentUmr}</span></span> : <span className="ab-help">— (new business)</span>}</FormRow>
          <FormRow label="Created"><span className="ab-help">{formatDateTime(bundle.createdAt)}{bundle.createdBy ? ` by ${bundle.createdBy}` : ''}</span></FormRow>
          <p className="ab-help" style={{ marginTop: 8 }}>The Treaty Type decides the Structure surface: Risk XL, CAT XL and Risk &amp; CAT XL use the layer table; Stop Loss and Aggregate XL use their Universe variants.</p>
        </Pane>
      </div>
      <div className="ab-footer-actions">
        <SaveStatus savedAt={savedAt} dirty={dirtyRef.current} saving={saving} error={saveError?.message} />
        <Button to={`/broking/${bundle.contractId}/identify`}>Back</Button>
        <Button onClick={() => doSave({ draft: false })} disabled={saving} data-testid="save-contract-details">Save</Button>
        <Button variant="primary" onClick={saveAndNext} disabled={saving} data-testid="save-and-next">Save &amp; next: Structure</Button>
      </div>
      {cobOpen && <CobSelectModal open selected={s.classIds || []} classList={classes} title="Select Classes of Business" onClose={() => setCobOpen(false)} onSave={(ids) => { update({ classIds: ids }); setCobOpen(false); }} />}
    </>
  );
}
