// /broking/:contractId/treaty-detail — the Universe Proportional Treaty Detail
// (PropTreatyDetail.jsx) field for field: header pill, SummaryBar with the
// Triangulations toggle, then the 2×2 grid CONTRACT DETAILS · LIMIT DETAILS ·
// COMMISSIONS · LOSS PARTICIPATION (+ EPI + BROKERAGE & TAXES).
//
// Behaviour ported from Universe (see docs/broking/universe-reference):
//   • treaty mode from the Treaty Type gates QS vs surplus fields ("Not applicable
//     for this treaty type" on the rest); Retention % ⇄ Cession % always sum to 100
//   • Retention/Cession Amount, Total Treaty Capacity, UW Year and the Contract
//     Description are derived live (shared/broking/calcs.js); renewal defaults to
//     inception + 12 months until edited by hand
//   • FIXED / SLIDING and Loss Participation YES / NO dim the inactive block to 35%
//   • required fields come from propMissingRequiredFields (= Universe
//     getMissingRequiredFields) and are highlighted after the first save attempt,
//     with an error summary of "Required: <label>"
//   • Tab order runs pane by pane; Enter moves to the next field; Ctrl+S saves
//     (CaptureScreen); leaving the step autosaves a draft.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Pane from '../components/Pane';
import FormRow, { NA_TYPE } from '../components/FormRow';
import NumericInput from '../components/NumericInput';
import TogglePill from '../components/TogglePill';
import Button from '../components/Button';
import Modal from '../components/Modal';
import SlideTable from '../components/SlideTable';
import CobSelectModal from '../components/CobSelectModal';
import EpiSplitModal from '../components/EpiSplitModal';
import ErrorSummary from '../components/ErrorSummary';
import SaveStatus from '../components/SaveStatus';
import ContractHeaderBar from './ContractHeaderBar';
import { useCedants } from '../hooks/useLookups';
import { useAutosaveOnLeave } from '../hooks/useBrokingContract';
import { useGlobalToast } from '../../hooks/useToast';
import { sliceFromBundle, payloadFromSlice, EMPTY_LP_SLIDES, PROP_TYPE_NAMES } from '../lib/propSlice';
import { fmtComma } from '../lib/format';
import * as calcs from '../../../../shared/broking/calcs.js';

const STEP = 'treaty-detail';
const COMM_OPTIONS = [{ value: 'fixed', label: 'FIXED COMMISSION' }, { value: 'sliding', label: 'SLIDING SCALE' }];
const YES_NO = [{ value: true, label: 'YES' }, { value: false, label: 'NO' }];
const LCF_YEARS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const THIS_YEAR = new Date().getFullYear();
const EXPERIENCE_YEARS = Array.from({ length: 41 }, (_, i) => THIS_YEAR - 40 + i);
const FOCUSABLE = 'input:not([disabled]):not([tabindex="-1"]),select:not([disabled]),button.ab-btn-field';

const byId = (list, id) => (list || []).find((x) => String(x.id) === String(id));

export default function PropTreatyDetail({ contract, lookups, stepRef, markAttempted }) {
  const { bundle, save: saveBundle, saving, savedAt, saveError, reload } = contract;
  const showToast = useGlobalToast();
  const [s, setS] = useState(() => sliceFromBundle(bundle));
  const [attempted, setAttempted] = useState(false);
  const [serverMessage, setServerMessage] = useState(null);
  const [modal, setModal] = useState(null);           // 'cob' | 'sliding' | 'corridors' | 'epi'
  const dirtyRef = useRef(false);
  const saveRef = useRef(null);
  const sRef = useRef(s);
  const hydratedVersion = useRef(bundle?.rowVersion ?? null);
  const gridRef = useRef(null);
  useEffect(() => { sRef.current = s; }, [s]);

  /* Hydrate from every new server version (initial load, a save, a reload after a 409). */
  useEffect(() => {
    if (!bundle) return;
    if (hydratedVersion.current === bundle.rowVersion && hydratedVersion.current !== null) return;
    hydratedVersion.current = bundle.rowVersion;
    setS(sliceFromBundle(bundle));
    dirtyRef.current = false;
  }, [bundle]);

  const update = useCallback((patch) => {
    dirtyRef.current = true;
    setServerMessage(null);
    setS((cur) => ({ ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) }));
  }, []);

  /* ── lookups + derived ── */
  const { countries = [], currencies = [], brokers = [], classes = [] } = lookups || {};
  const treatyTypes = useMemo(() => (lookups?.treatyTypes || []).filter((t) => (t.category ? t.category === 'PROPORTIONAL' : PROP_TYPE_NAMES.has(t.name))), [lookups?.treatyTypes]);
  const cedants = useCedants(s.countryId);
  const h = bundle?.header || {};
  const typeName = byId(treatyTypes, s.treatyTypeId)?.name || (String(s.treatyTypeId) === String(h.treatyTypeId) ? h.treatyTypeName : '') || '';
  const tMode = calcs.treatyModeFromType(typeName);
  const isQS = calcs.isQsMode(tMode);
  const isSurplus = calcs.isSurplusMode(tMode);
  const isFixed = s.commissionMode !== 'sliding';
  const lpOn = s.lossPartEnabled === true;
  const currencyCode = byId(currencies, s.currencyId)?.code || (String(s.currencyId) === String(h.currencyId) ? h.currencyCode : '') || '';
  const country = byId(countries, s.countryId);
  const countryName = country?.name || (String(s.countryId) === String(h.countryId) ? h.countryName : '') || '';
  const countryCode = country?.code || (String(s.countryId) === String(h.countryId) ? h.countryCode : '') || '';
  const cedantName = byId(cedants, s.cedantId)?.name || (String(s.cedantId) === String(h.cedantId) ? h.cedantName : '') || '';
  const brokerName = byId(brokers, s.brokerId)?.name || (String(s.brokerId) === String(h.brokerId) ? h.brokerName : '') || '';
  const cobNames = useMemo(() => (s.classIds || []).map((id) => byId(classes, id)?.name || (h.classIds || []).includes(id) && h.classNames?.[(h.classIds || []).indexOf(id)]).filter(Boolean), [s.classIds, classes, h.classIds, h.classNames]);
  const cobText = !cobNames.length ? 'Select classes…' : cobNames.length <= 2 ? cobNames.join(', ') : `${cobNames.slice(0, 2).join(', ')} +${cobNames.length - 2} more`;
  const uwYear = calcs.uwYearFromInception(s.inceptionDate);
  const description = calcs.buildContractDescription({ uwYear, cedantName, treatyTypeName: typeName, classNames: cobNames, countryCode });
  const retentionAmt = isQS ? calcs.retentionAmt(s.qsLimit, s.retentionPct) : null;
  const cessionAmt = isQS ? calcs.cessionAmt(s.qsLimit, s.cessionPct) : null;
  const capacity = s.treatyTypeId ? calcs.totalCapacity({ mode: tMode, qsLimit: s.qsLimit, surplusMaxRetention: s.surplusMaxRetention, numLines: s.numLines }) : null;
  const slidingRows = (s.slidingTable || []).filter((r) => r.lossRatioPct || r.commissionPct).length;
  const corridorCount = (s.lpSlides || []).filter((r) => r.minLr || r.maxLr || r.share).length;
  const epiSplitCount = (s.epiSplit || []).filter((r) => String(r.premium || '').trim()).length;

  const missing = useMemo(() => calcs.propMissingRequiredFields(s, { tMode, commMode: s.commissionMode }), [s, tMode]);
  const missingRef = useRef(missing);
  useEffect(() => { missingRef.current = missing; }, [missing]);
  const shown = attempted ? missing : [];
  const miss = (label) => shown.includes(label);

  /* ── save (explicit: validated; draft: on leave / Ctrl+S never blocks) ── */
  const doSave = useCallback(async ({ draft = false } = {}) => {
    if (!draft) {
      setAttempted(true);
      if (missingRef.current.length) { markAttempted?.(STEP, true); return { ok: false, missing: missingRef.current }; }
    }
    const res = await saveBundle('prop-detail', payloadFromSlice(sRef.current), { draft });
    if (res.ok) {
      dirtyRef.current = false;
      if (!draft) { markAttempted?.(STEP, false); showToast('Treaty detail saved.'); }
    } else if (!res.conflict) {
      const details = (res.fields || []).map((f) => `${f.path}: ${f.message}`);
      setServerMessage([res.message, ...details].filter(Boolean).join(' — '));
    }
    return res;
  }, [saveBundle, markAttempted, showToast]);
  useEffect(() => { saveRef.current = doSave; if (stepRef) stepRef.current = { save: doSave }; }, [doSave, stepRef]);
  useAutosaveOnLeave({ dirtyRef, saveRef });

  /* ── handlers (Universe) ── */
  const onRetention = (v) => update({ retentionPct: v, cessionPct: String(calcs.cessionFromRetention(v)) });
  const onCession = (v) => update({ cessionPct: v, retentionPct: String(calcs.retentionFromCession(v)) });
  const onInception = (v) => update((cur) => ({ inceptionDate: v, ...(cur._renewalManual ? {} : { renewalDate: calcs.defaultRenewalDate(v) }) }));
  const onRenewal = (v) => update({ renewalDate: v, _renewalManual: true });
  const openEpiSplit = () => { if (!(s.classIds || []).length) { showToast('Select Lines of Business first'); return; } setModal('epi'); };

  /* Enter moves to the next field, and from the last field of a pane to the next pane. */
  const onGridKeyDown = (e) => {
    if (e.key !== 'Enter' || !gridRef.current) return;
    const t = e.target; const tag = t.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT') return;
    e.preventDefault();
    const panes = Array.from(gridRef.current.querySelectorAll('.ab-pane'));
    const focusables = (pane) => Array.from(pane.querySelectorAll(FOCUSABLE));
    const pi = panes.findIndex((p) => p.contains(t));
    if (pi < 0) return;
    const list = focusables(panes[pi]); const i = list.indexOf(t);
    if (i >= 0 && i < list.length - 1) list[i + 1].focus();
    else { const next = panes[pi + 1] ? focusables(panes[pi + 1]) : []; next[0]?.focus(); }
  };

  if (!bundle) return null;
  const facts = [cedantName, countryName, brokerName, currencyCode, typeName, cobNames.join(', ')];
  const na = (enabled) => (enabled ? null : NA_TYPE);

  return (
    <>
      <ContractHeaderBar bundle={bundle} step={STEP} facts={facts} onAmended={() => reload()}
        extra={<><span className="ab-help" style={{ margin: 0 }}>Triangulations available</span>
          <TogglePill options={YES_NO} value={s.triangulationsAvailable !== false} onChange={(v) => update({ triangulationsAvailable: v })} ariaLabel="Triangulations available" /></>} />
      <ErrorSummary missing={shown} message={serverMessage} />

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Enter→next-field is a bubbling keyboard enhancement over the native inputs */}
      <div className="ab-grid-2" ref={gridRef} onKeyDown={onGridKeyDown} data-testid="prop-treaty-detail">
        {/* ═══ CONTRACT DETAILS ═══ */}
        <Pane title="Contract Details" tag="Input">
          <FormRow label="Country" htmlFor="pt-country" required missing={miss('Country')}>
            <select id="pt-country" className="ab-sel" value={s.countryId || ''} onChange={(e) => update({ countryId: e.target.value, cedantId: '' })}>
              <option value="">Select country…</option>{countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FormRow>
          <FormRow label="Cedant Name" htmlFor="pt-cedant" required missing={miss('Cedant Name')}>
            <select id="pt-cedant" className="ab-sel" value={s.cedantId || ''} onChange={(e) => update({ cedantId: e.target.value })} disabled={!s.countryId}>
              <option value="">{s.countryId ? 'Select cedant…' : 'Select country first…'}</option>
              {cedants.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              {s.cedantId && !byId(cedants, s.cedantId) && h.cedantName && <option value={s.cedantId}>{h.cedantName}</option>}
            </select>
          </FormRow>
          <FormRow label="Treaty Type" htmlFor="pt-type" required missing={miss('Treaty Type')}>
            <select id="pt-type" className="ab-sel" value={s.treatyTypeId || ''} onChange={(e) => update({ treatyTypeId: e.target.value })}>
              <option value="">Select treaty type…</option>{treatyTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </FormRow>
          <FormRow label="Line of Business" htmlFor="pt-cob" required missing={miss('Line of Business')}>
            <button id="pt-cob" type="button" className={`ab-btn-field${cobNames.length ? '' : ' is-placeholder'}`} onClick={() => setModal('cob')} aria-haspopup="dialog" data-testid="cob-button">
              <span>{cobText}</span><span className="ab-help" aria-hidden="true">▾</span>
            </button>
          </FormRow>
          <FormRow label="Broker" htmlFor="pt-broker" required missing={miss('Broker')}>
            <select id="pt-broker" className="ab-sel" value={s.brokerId || ''} onChange={(e) => update({ brokerId: e.target.value })}>
              <option value="">Select broker…</option>{brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </FormRow>
          <FormRow label="Contract ID" htmlFor="pt-uuid"><input id="pt-uuid" className="ab-in is-derived ab-uuid" readOnly tabIndex={-1} value={bundle.contractId} aria-readonly="true" /></FormRow>
          <FormRow label="Alt. Contract ID" htmlFor="pt-alt"><input id="pt-alt" className="ab-in" value={s.altContractId || ''} onChange={(e) => update({ altContractId: e.target.value })} placeholder="External system reference…" /></FormRow>
          <FormRow label="Currency" htmlFor="pt-currency" required missing={miss('Currency')}>
            <select id="pt-currency" className="ab-sel" value={s.currencyId || ''} onChange={(e) => update({ currencyId: e.target.value })}>
              <option value="">Select currency…</option>{currencies.map((c) => <option key={c.id} value={c.id}>{c.code || c.name}</option>)}
            </select>
          </FormRow>
          <FormRow label="Treaty Inception Date" htmlFor="pt-inception" required missing={miss('Treaty Inception Date')}>
            <input id="pt-inception" className="ab-in" type="date" value={s.inceptionDate || ''} onChange={(e) => onInception(e.target.value)} />
          </FormRow>
          <FormRow label="Treaty Renewal Date" htmlFor="pt-renewal" hint={!s._renewalManual && s.inceptionDate ? <div className="ab-help">Defaults to inception + 12 months until edited.</div> : null}>
            <input id="pt-renewal" className="ab-in" type="date" value={s.renewalDate || ''} onChange={(e) => onRenewal(e.target.value)} />
          </FormRow>
          <FormRow label="UW Year" htmlFor="pt-uwyear"><input id="pt-uwyear" className="ab-in is-derived" readOnly tabIndex={-1} value={uwYear || ''} title="Auto-derived from Treaty Inception Date" aria-readonly="true" /></FormRow>
          <FormRow label="Experience Start Year" htmlFor="pt-expyear" required missing={miss('Experience Start Year')}>
            <select id="pt-expyear" className="ab-sel" value={s.experienceStartYear || ''} onChange={(e) => update({ experienceStartYear: e.target.value })}>
              <option value="">Select start year…</option>{EXPERIENCE_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </FormRow>
          <FormRow label="Contract Description" htmlFor="pt-desc"><input id="pt-desc" className="ab-in is-derived" readOnly tabIndex={-1} value={description} aria-readonly="true" data-testid="contract-description" /></FormRow>
        </Pane>

        {/* ═══ LIMIT DETAILS ═══ */}
        <Pane title="Limit Details" tag="Capacity">
          <FormRow label="QS 100% Limit" htmlFor="pt-qslimit" required={isQS} missing={miss('QS 100% Limit')} disabledReason={na(isQS)}>
            <NumericInput id="pt-qslimit" kind="money" value={s.qsLimit} onChange={(v) => update({ qsLimit: v })} currency={currencyCode} placeholder="e.g. 1,000,000" disabled={!isQS} title={na(isQS) || undefined} />
          </FormRow>
          <FormRow label="Retention %" htmlFor="pt-retpct" required={isQS} missing={miss('Retention %')} disabledReason={na(isQS)}>
            <NumericInput id="pt-retpct" kind="pct" value={s.retentionPct} onChange={onRetention} placeholder="e.g. 50%" disabled={!isQS} title={na(isQS) || undefined} />
          </FormRow>
          <FormRow label="Retention Amount" htmlFor="pt-retamt"><NumericInput id="pt-retamt" kind="derived" value={retentionAmt} currency={currencyCode} placeholder="auto" /></FormRow>
          <FormRow label="Cession %" htmlFor="pt-cespct" disabledReason={na(isQS)}>
            <NumericInput id="pt-cespct" kind="pct" value={s.cessionPct} onChange={onCession} placeholder="e.g. 50%" disabled={!isQS} title={na(isQS) || undefined} />
          </FormRow>
          <FormRow label="Cession Amount" htmlFor="pt-cesamt"><NumericInput id="pt-cesamt" kind="derived" value={cessionAmt} currency={currencyCode} placeholder="auto" /></FormRow>
          <FormRow label="Surplus Max Retention" htmlFor="pt-smr" required={isSurplus} missing={miss('Surplus Max Retention')} disabledReason={na(isSurplus)}>
            <NumericInput id="pt-smr" kind="money" value={s.surplusMaxRetention} onChange={(v) => update({ surplusMaxRetention: v })} currency={currencyCode} placeholder="e.g. 1,000,000" disabled={!isSurplus} title={na(isSurplus) || undefined} />
          </FormRow>
          <FormRow label="Number of Lines" htmlFor="pt-lines" required={isSurplus} missing={miss('Number of Lines')} disabledReason={na(isSurplus)}>
            <NumericInput id="pt-lines" kind="number" min={0} value={s.numLines} onChange={(v) => update({ numLines: v })} placeholder="e.g. 5" disabled={!isSurplus} title={na(isSurplus) || undefined} />
          </FormRow>
          <FormRow label="Total Treaty Capacity" htmlFor="pt-capacity"><NumericInput id="pt-capacity" kind="derived" value={capacity} currency={currencyCode} /></FormRow>
          <FormRow label="Event Limit" htmlFor="pt-eventlimit"><NumericInput id="pt-eventlimit" kind="money" value={s.eventLimit} onChange={(v) => update({ eventLimit: v })} currency={currencyCode} placeholder="e.g. 3,000,000" /></FormRow>
          <FormRow label="AAL" htmlFor="pt-aal"><NumericInput id="pt-aal" kind="money" value={s.aal} onChange={(v) => update({ aal: v })} currency={currencyCode} placeholder="e.g. 10,000,000" /></FormRow>
        </Pane>

        {/* ═══ COMMISSIONS ═══ */}
        <Pane title="Commissions" headRight={<TogglePill options={COMM_OPTIONS} value={isFixed ? 'fixed' : 'sliding'} onChange={(v) => update({ commissionMode: v })} ariaLabel="Commission mode" />}>
          <p className="ab-help">Choose between a single fixed commission or a sliding scale commission structure.</p>
          <div className={isFixed ? '' : 'ab-dim'} data-testid="fixed-block" aria-disabled={!isFixed}>
            <div className="ab-mini">Fixed commission</div>
            <FormRow label="QS Commission %" htmlFor="pt-fixqs" required={isFixed && isQS} missing={miss('Fixed QS Commission %')} disabledReason={na(isQS)}>
              <NumericInput id="pt-fixqs" kind="pct" value={s.fixedCommissionQSPct} onChange={(v) => update({ fixedCommissionQSPct: v })} placeholder="e.g. 30%" disabled={!isFixed || !isQS} title={na(isQS) || undefined} />
            </FormRow>
            <FormRow label="Surplus Commission %" htmlFor="pt-fixsurplus" required={isFixed && isSurplus} missing={miss('Fixed Surplus Commission %')} disabledReason={na(isSurplus)}>
              <NumericInput id="pt-fixsurplus" kind="pct" value={s.fixedCommissionSurplusPct} onChange={(v) => update({ fixedCommissionSurplusPct: v })} placeholder="e.g. 30%" disabled={!isFixed || !isSurplus} title={na(isSurplus) || undefined} />
            </FormRow>
          </div>
          <div className={isFixed ? 'ab-dim' : ''} style={{ marginTop: 14 }} data-testid="sliding-block" aria-disabled={isFixed}>
            <div className="ab-mini">Sliding scale</div>
            <FormRow label="Min Loss Ratio %" htmlFor="pt-slminlr" required={!isFixed} missing={miss('Sliding Min Loss Ratio %')}><NumericInput id="pt-slminlr" kind="pct" value={s.slidingMinLossRatio} onChange={(v) => update({ slidingMinLossRatio: v })} placeholder="e.g. 40%" disabled={isFixed} /></FormRow>
            <FormRow label="Max Loss Ratio %" htmlFor="pt-slmaxlr" required={!isFixed} missing={miss('Sliding Max Loss Ratio %')}><NumericInput id="pt-slmaxlr" kind="pct" value={s.slidingMaxLossRatio} onChange={(v) => update({ slidingMaxLossRatio: v })} placeholder="e.g. 80%" disabled={isFixed} /></FormRow>
            <FormRow label="Min Commission %" htmlFor="pt-slmincomm" required={!isFixed} missing={miss('Sliding Min Commission %')}><NumericInput id="pt-slmincomm" kind="pct" value={s.slidingMinCommission} onChange={(v) => update({ slidingMinCommission: v })} placeholder="e.g. 20%" disabled={isFixed} /></FormRow>
            <FormRow label="Max Commission %" htmlFor="pt-slmaxcomm" required={!isFixed} missing={miss('Sliding Max Commission %')}><NumericInput id="pt-slmaxcomm" kind="pct" value={s.slidingMaxCommission} onChange={(v) => update({ slidingMaxCommission: v })} placeholder="e.g. 35%" disabled={isFixed} /></FormRow>
            <div className={`ab-fr${miss('Provisional Commission %') || miss('Sliding Scale table (need ≥2 complete rows)') ? ' is-missing' : ''}`}>
              <span />
              <span className="ab-row-actions">
                <Button variant="warn" onClick={() => setModal('sliding')} disabled={isFixed} data-testid="sliding-modal-button">Enter slide manually</Button>
                <span className="ab-help">{slidingRows} row(s){s.provisionalCommissionPct ? ` · provisional ${s.provisionalCommissionPct}%` : ''}</span>
              </span>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <div className="ab-mini">Additional</div>
            <FormRow label="Management Expenses %" htmlFor="pt-mgmt"><NumericInput id="pt-mgmt" kind="pct" value={s.mgmtExpensesPct} onChange={(v) => update({ mgmtExpensesPct: v })} placeholder="e.g. 5%" /></FormRow>
            <FormRow label="Profit Commission %" htmlFor="pt-pc"><NumericInput id="pt-pc" kind="pct" value={s.profitCommissionPct} onChange={(v) => update({ profitCommissionPct: v })} placeholder="e.g. 10%" /></FormRow>
            <FormRow label="Loss Carry Forward (LCF)" htmlFor="pt-lcf">
              <select id="pt-lcf" className="ab-sel" value={s.lcfYears || ''} onChange={(e) => update({ lcfYears: e.target.value })}>
                <option value="">None</option>
                {LCF_YEARS.map((n) => <option key={n} value={n}>{n} year{n > 1 ? 's' : ''}</option>)}
                <option value="extinction">Extinction</option>
              </select>
            </FormRow>
          </div>
        </Pane>

        {/* ═══ LOSS PARTICIPATION + EPI + BROKERAGE & TAXES ═══ */}
        <Pane title="Loss Participation" headRight={<TogglePill options={YES_NO} value={lpOn} onChange={(v) => update({ lossPartEnabled: v })} ariaLabel="Loss participation enabled" />}>
          <p className="ab-help">Capture loss participation corridors where the reinsurer share changes above a given loss ratio.</p>
          <div className={lpOn ? '' : 'ab-dim'} data-testid="lp-block" aria-disabled={!lpOn}>
            <FormRow label="Min Loss Ratio %" htmlFor="pt-lpminlr" required={lpOn} missing={miss('LP Min Loss Ratio %')}><NumericInput id="pt-lpminlr" kind="pct" max={1000} value={s.minLossRatioPct} onChange={(v) => update({ minLossRatioPct: v })} placeholder="e.g. 70%" disabled={!lpOn} /></FormRow>
            <FormRow label="Max Loss Ratio %" htmlFor="pt-lpmaxlr" required={lpOn} missing={miss('LP Max Loss Ratio %')}><NumericInput id="pt-lpmaxlr" kind="pct" max={1000} value={s.maxLossRatioPct} onChange={(v) => update({ maxLossRatioPct: v })} placeholder="e.g. 100%" disabled={!lpOn} /></FormRow>
            <FormRow label="Reinsurer Share %" htmlFor="pt-lpshare" required={lpOn} missing={miss('LP Reinsurer Share %')}><NumericInput id="pt-lpshare" kind="pct" value={s.reinsurerSharePct} onChange={(v) => update({ reinsurerSharePct: v })} placeholder="e.g. 50%" disabled={!lpOn} /></FormRow>
            <div className="ab-fr"><span /><span className="ab-row-actions">
              <Button variant="warn" onClick={() => setModal('corridors')} disabled={!lpOn} data-testid="corridors-modal-button">Enter slides manually</Button>
              {corridorCount > 0 && <span className="ab-help" style={{ color: 'var(--accent-strong)', fontWeight: 700 }}>✓ {corridorCount} corridor(s)</span>}
            </span></div>
          </div>
          <div className="ab-mini" style={{ marginTop: 16 }}>EPI</div>
          <FormRow label="Quota Share EPI" htmlFor="pt-qsepi" required={isQS} missing={miss('Quota Share EPI')} disabledReason={na(isQS)}>
            <NumericInput id="pt-qsepi" kind="money" value={s.quotaShareEpi} onChange={(v) => update({ quotaShareEpi: v })} currency={currencyCode} placeholder="e.g. 10,000,000" disabled={!isQS} title={na(isQS) || undefined} />
          </FormRow>
          <FormRow label="Surplus EPI" htmlFor="pt-surplusepi" required={isSurplus} missing={miss('Surplus EPI')} disabledReason={na(isSurplus)}>
            <NumericInput id="pt-surplusepi" kind="money" value={s.surplusEpi} onChange={(v) => update({ surplusEpi: v })} currency={currencyCode} placeholder="e.g. 5,000,000" disabled={!isSurplus} title={na(isSurplus) || undefined} />
          </FormRow>
          <div className="ab-fr"><span /><span className="ab-row-actions">
            <Button variant="warn" onClick={openEpiSplit} data-testid="epi-split-button">EPI split</Button>
            <span className="ab-help">{epiSplitCount > 0 ? `${epiSplitCount} class(es)` : (s.classIds || []).length ? 'Equal split unless entered' : ''}</span>
          </span></div>
          <div className="ab-mini" style={{ marginTop: 16 }}>Brokerage &amp; taxes</div>
          <FormRow label="Brokerage %" htmlFor="pt-brokerage"><NumericInput id="pt-brokerage" kind="pct" value={s.brokeragePct} onChange={(v) => update({ brokeragePct: v })} placeholder="e.g. 5%" /></FormRow>
          <FormRow label="Taxes %" htmlFor="pt-taxes"><NumericInput id="pt-taxes" kind="pct" value={s.taxesPct} onChange={(v) => update({ taxesPct: v })} placeholder="e.g. 2%" /></FormRow>
          <FormRow label="Loss Cap %" htmlFor="pt-losscap"><NumericInput id="pt-losscap" kind="pct" max={1000} value={s.lossCapPct} onChange={(v) => update({ lossCapPct: v })} placeholder="e.g. 5%" /></FormRow>
        </Pane>
      </div>

      <div className="ab-footer-actions">
        <SaveStatus savedAt={savedAt} dirty={dirtyRef.current} saving={saving} error={saveError?.message} />
        <Button to={`/broking/${bundle.contractId}/identify`}>Back</Button>
        <Button variant="primary" onClick={() => doSave({ draft: false })} disabled={saving} data-testid="save-treaty-detail">Save treaty detail</Button>
      </div>

      {/* ── Modals ── */}
      {modal === 'cob' && (
        <CobSelectModal open selected={s.classIds || []} classList={classes} onClose={() => setModal(null)}
          onSave={(ids) => { update({ classIds: ids }); setModal(null); }} />
      )}
      {modal === 'sliding' && (
        <Modal open title="Sliding Scale Commission Table" tag="Manual" onClose={() => setModal(null)} wide>
          <SlideTable kind="sliding" rows={s.slidingTable} provisional={s.provisionalCommissionPct} onCancel={() => setModal(null)}
            onSave={(rows, prov) => { update({ slidingTable: rows, provisionalCommissionPct: prov }); setModal(null); showToast('Sliding scale saved.'); }} />
        </Modal>
      )}
      {modal === 'corridors' && (
        <Modal open title="Stepped Loss Participation" tag="Up to 5 corridors" onClose={() => setModal(null)}>
          <SlideTable kind="corridors" rows={s.lpSlides} onCancel={() => setModal(null)}
            onSave={(rows) => { update({ lpSlides: [...rows, ...EMPTY_LP_SLIDES()].slice(0, 5) }); setModal(null); showToast('Loss participation corridors saved.'); }} />
        </Modal>
      )}
      {modal === 'epi' && (
        <EpiSplitModal open split={s.epiSplit} classIds={s.classIds || []} classList={classes} qsEpi={s.quotaShareEpi} surplusEpi={s.surplusEpi} currency={currencyCode}
          onClose={() => setModal(null)} onSave={(rows) => { update({ epiSplit: rows }); setModal(null); showToast(`EPI split saved (${fmtComma(String(Math.round(rows.reduce((t, r) => t + (Number(r.premium) || 0), 0))))}).`); }} />
      )}
    </>
  );
}
