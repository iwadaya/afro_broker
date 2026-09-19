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
import { propTermsOf, withPropStructure, detailPath, documentsPath } from './contractModel.js';
import {
  emptyPropTerms, propCalcs, totalEpiOf, fmtAmount, NumField, Derived, MiniPills,
  SlidingScaleModal, LpSlidesModal, EpiSplitModal,
} from './propTerms.jsx';
import { toNumber, cessionFromRetention, retentionFromCession, propMissingRequiredFields } from './calcs.js';

/**
 * Contracts → Proportional: the Universe proportional Treaty Detail, field
 * for field — the summary strip with the Triangulations toggle, then the
 * 2×2 grid CONTRACT DETAILS · LIMIT DETAILS · COMMISSIONS · LOSS
 * PARTICIPATION (with EPI and BROKERAGE & TAXES). The treaty type gates the
 * quota-share and surplus fields ("Not applicable for this treaty type"),
 * Retention % and Cession % always sum to 100, the amounts, the capacity,
 * the UW year and the contract description derive live, the renewal date
 * defaults to inception + 12 months until edited, FIXED / SLIDING and YES /
 * NO dim the inactive block, and the required fields are highlighted after
 * the first save attempt with a "Required: …" summary. Enter moves field to
 * field and pane to pane; Ctrl+S saves.
 *
 * The contract is a placement: the details go on its header, the terms on
 * its proportional structure, and its quota-share / surplus layers carry
 * the capacity and EPI so the calendar and the portfolio read them.
 */
const NA = 'Not applicable for this treaty type';
const LCF_YEARS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function PropTreatyDetail() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const canEdit = useHasRole('broker', 'admin');
  const placement = useFetch('GET', id ? `/placements/${id}` : null, [id]);
  const pd = isNew ? NEW_CONTRACT : placement.data;
  useScreenHead('Contracts · Proportional · 1 of 3', 'Treaty Detail', pd?.reference || 'NEW');

  const h = useContractHeader({ pd, isNew, basis: 'PROP' });
  const [terms, setTerms] = useState(emptyPropTerms);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // 'sliding' | 'lp' | 'epi'
  const gridRef = useRef(null);
  const saveRef = useRef(null);

  // The stored terms, hydrated with the placement.
  useEffect(() => {
    if (!pd) return;
    setTerms(propTermsOf(pd));
  }, [pd?.id, pd?.updated_at]);
  const set = (patch) => setTerms((t) => ({ ...t, ...patch }));

  const ro = !canEdit || busy;
  const c = propCalcs(terms, h.treatyTypeName);
  const isQS = c.hasQS;
  const isSurplus = c.hasSurplus;
  const isFixed = terms.commissionMode !== 'sliding';
  const lpOn = terms.lossPartEnabled === true;
  const ccy = h.currencyCode || 'CCY';
  const slidingRows = (terms.slidingTable || []).filter((r) => r.lossRatioPct || r.commissionPct).length;
  const corridorCount = (terms.lpSlides || []).filter((r) => r.minLr || r.maxLr || r.share).length;
  const epiSplitCount = (terms.epiSplit || []).filter((r) => String(r.premium ?? '').trim()).length;

  // Universe: the required fields for the treaty mode and the commission mode.
  const missingList = useMemo(() => (h.ed
    ? propMissingRequiredFields(
      { ...h.requiredSlice, ...terms, fixedCommissionQSPct: terms.commissionPct, fixedCommissionSurplusPct: terms.commissionSurplusPct },
      { tMode: c.mode, commMode: isFixed ? 'fixed' : 'sliding' },
    )
    : []), [h.ed, h.requiredSlice, terms, c.mode, isFixed]);
  const missing = new Set(attempted ? missingList : []);
  const miss = (label) => missing.has(label);

  // Universe handlers: retention ⇄ cession, the EPI total mirrored.
  const onRetention = (v) => set({ retentionPct: v, cessionPct: v === '' ? '' : String(cessionFromRetention(v)) });
  const onCession = (v) => set({ cessionPct: v, retentionPct: v === '' ? '' : String(retentionFromCession(v)) });
  const setEpi = (patch) => setTerms((t) => {
    const next = { ...t, ...patch };
    const total = totalEpiOf(next);
    return { ...next, epi: total ? String(total) : '' };
  });
  const openEpiSplit = () => {
    if (!h.cobNames.length) { toast('Select Lines of Business first'); return; }
    setModal('epi');
  };

  /** Write the contract: the header, the terms, the layers. Resolves to the
      contract's id, or null when held on a required field or failed. */
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
      const header = { cedant_id: cedantId, ...h.headerPayload() };
      const structure = {
        basis: 'PROP',
        prop: { ...terms, treatyType: h.treatyTypeName, epi: totalEpiOf(terms) ? String(totalEpiOf(terms)) : '' },
      };
      let pid = id;
      if (isNew) {
        const created = await api('POST', '/placements', header);
        pid = created.id;
        await api('PATCH', `/placements/${pid}`, { quote_structures: [structure] });
      } else {
        await api('PATCH', `/placements/${id}`, { ...header, quote_structures: withPropStructure(pd, structure) });
      }
      await syncPropLayers(pid, isNew ? [] : (pd.layers || []), terms, c, h.currencyCode);
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
      navigate(detailPath('PROP', pid), { replace: true });
      setTimeout(() => toast('Treaty detail saved.'), 0);
    } else {
      toast('Treaty detail saved.');
      placement.reload();
    }
  }

  /** Save & next: the Documents step, once the contract is written. */
  async function saveAndNext() {
    if (!canEdit) { if (!isNew) navigate(documentsPath('PROP', id)); return; }
    const pid = await persist();
    if (!pid) return;
    navigate(documentsPath('PROP', pid));
    setTimeout(() => toast('Treaty detail saved.'), 0);
  }
  saveRef.current = save;

  // Ctrl+S saves.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') { e.preventDefault(); saveRef.current?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (placement.error) return <ErrorBanner error={placement.error} />;
  if (!pd || !h.ed) return null;
  const na = (on) => (on ? undefined : NA);

  return (
    <div className="screen contract-screen">
      <ContractSummary h={h} right={(
        <>
          <span className="td-contract-label">Triangulations available</span>
          <MiniPills ariaLabel="Triangulations available" readOnly={ro}
            options={[[true, 'YES'], [false, 'NO']]}
            value={terms.triangulationsAvailable !== false}
            onChange={(v) => set({ triangulationsAvailable: v })} />
        </>
      )} />
      {h.contractDescription && (
        <div className="td-contract"><span className="td-contract-label">Contract:</span>{h.contractDescription}</div>
      )}
      {attempted && missingList.length > 0 && (
        <div className="err banner" data-testid="required-summary">Required: {missingList.join(', ')}</div>
      )}
      <ErrorBanner error={error} />

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div className="td-grid" ref={gridRef} onKeyDown={enterMovesToNextField(gridRef)} data-testid="prop-treaty-detail">
        {/* ═══ CONTRACT DETAILS ═══ */}
        <ContractDetailsPane h={h} missing={missing} disabled={ro} contract={isNew ? null : pd} />

        {/* ═══ LIMIT DETAILS ═══ */}
        <div className="td-card td-card--pane" data-testid="limit-details">
          <div className="td-card-head">
            <span className="td-card-label">LIMIT DETAILS</span>
            <span className="td-card-tag">CAPACITY</span>
          </div>
          <div className="td-card-body">
            <Fr label={`QS 100% Limit (${ccy})`} missing={miss('QS 100% Limit')} hint={na(isQS)}>
              <NumField value={terms.qsLimit} onChange={(v) => set({ qsLimit: v })} disabled={!isQS || ro} readOnly={ro}
                placeholder={isQS ? 'e.g. 1,000,000' : NA} title={na(isQS)} aria-label="QS 100% Limit" />
            </Fr>
            <Fr label="Retention %" missing={miss('Retention %')} hint={na(isQS)}>
              <NumField suffix="%" value={terms.retentionPct} onChange={onRetention} disabled={!isQS || ro} readOnly={ro}
                placeholder={isQS ? 'e.g. 50%' : NA} title={na(isQS)} aria-label="Retention %" />
            </Fr>
            <Fr label="Retention Amount" hint="QS 100% Limit × Retention %">
              <Derived value={fmtAmount(c.retAmt)} aria-label="Retention Amount" />
            </Fr>
            <Fr label="Cession %" hint={na(isQS)}>
              <NumField suffix="%" value={terms.cessionPct} onChange={onCession} disabled={!isQS || ro} readOnly={ro}
                placeholder={isQS ? 'e.g. 50%' : NA} title={na(isQS)} aria-label="Cession %" />
            </Fr>
            <Fr label="Cession Amount" hint="QS 100% Limit × Cession %">
              <Derived value={fmtAmount(c.cesAmt)} aria-label="Cession Amount" />
            </Fr>
            <Fr label={`Surplus Max Retention (${ccy})`} missing={miss('Surplus Max Retention')} hint={na(isSurplus)}>
              <NumField value={terms.surplusMaxRetention} onChange={(v) => set({ surplusMaxRetention: v })}
                disabled={!isSurplus || ro} readOnly={ro} placeholder={isSurplus ? 'e.g. 1,000,000' : NA}
                title={na(isSurplus)} aria-label="Surplus Max Retention" />
            </Fr>
            <Fr label="Number of Lines" missing={miss('Number of Lines')} hint={na(isSurplus)}>
              <NumField value={terms.numLines} onChange={(v) => set({ numLines: v })}
                disabled={!isSurplus || ro} readOnly={ro} placeholder={isSurplus ? 'e.g. 5' : NA}
                title={na(isSurplus)} aria-label="Number of Lines" />
            </Fr>
            <Fr label="Total Treaty Capacity" hint="Quota share: the QS limit · surplus: max retention × lines · both together">
              <Derived value={fmtAmount(c.capacity)} aria-label="Total Treaty Capacity" />
            </Fr>
            <Fr label={`Event Limit (${ccy})`}>
              <NumField value={terms.eventLimit} onChange={(v) => set({ eventLimit: v })} readOnly={ro}
                placeholder="e.g. 3,000,000" aria-label="Event Limit" />
            </Fr>
            <Fr label={`AAL (${ccy})`}>
              <NumField value={terms.aal} onChange={(v) => set({ aal: v })} readOnly={ro}
                placeholder="e.g. 10,000,000" aria-label="AAL" />
            </Fr>
          </div>
        </div>

        {/* ═══ COMMISSIONS ═══ */}
        <div className="td-card td-card--pane" data-testid="commissions">
          <div className="td-card-head">
            <span className="td-card-label">COMMISSIONS</span>
            <MiniPills ariaLabel="Commission mode" readOnly={ro}
              options={[['fixed', 'FIXED COMMISSION'], ['sliding', 'SLIDING SCALE']]}
              value={isFixed ? 'fixed' : 'sliding'}
              onChange={(v) => set({ commissionMode: v })} />
          </div>
          <div className="td-card-body">
            <div className="td-hint">Choose between a single fixed commission or a sliding scale commission structure.</div>
            <div className={`np-terms-fade td-block${isFixed ? '' : ' is-off'}`} data-testid="fixed-block" aria-disabled={!isFixed}>
              <div className="td-mini">Fixed commission</div>
              <Fr label="QS Commission %" missing={miss('Fixed QS Commission %')} hint={na(isQS)}>
                <NumField suffix="%" value={terms.commissionPct} onChange={(v) => set({ commissionPct: v })}
                  disabled={!isFixed || !isQS || ro} readOnly={ro} placeholder={isQS ? 'e.g. 30%' : NA}
                  title={na(isQS)} aria-label="QS Commission %" />
              </Fr>
              <Fr label="Surplus Commission %" missing={miss('Fixed Surplus Commission %')} hint={na(isSurplus)}>
                <NumField suffix="%" value={terms.commissionSurplusPct} onChange={(v) => set({ commissionSurplusPct: v })}
                  disabled={!isFixed || !isSurplus || ro} readOnly={ro} placeholder={isSurplus ? 'e.g. 30%' : NA}
                  title={na(isSurplus)} aria-label="Surplus Commission %" />
              </Fr>
            </div>
            <div className={`np-terms-fade td-block${isFixed ? ' is-off' : ''}`} data-testid="sliding-block" aria-disabled={isFixed}>
              <div className="td-mini">Sliding scale</div>
              <Fr label="Min Loss Ratio %" missing={miss('Sliding Min Loss Ratio %')}>
                <NumField suffix="%" value={terms.slidingMinLossRatio} onChange={(v) => set({ slidingMinLossRatio: v })}
                  disabled={isFixed || ro} readOnly={ro} placeholder="e.g. 40%" aria-label="Sliding Min Loss Ratio %" />
              </Fr>
              <Fr label="Max Loss Ratio %" missing={miss('Sliding Max Loss Ratio %')}>
                <NumField suffix="%" value={terms.slidingMaxLossRatio} onChange={(v) => set({ slidingMaxLossRatio: v })}
                  disabled={isFixed || ro} readOnly={ro} placeholder="e.g. 80%" aria-label="Sliding Max Loss Ratio %" />
              </Fr>
              <Fr label="Min Commission %" missing={miss('Sliding Min Commission %')}>
                <NumField suffix="%" value={terms.slidingMinCommission} onChange={(v) => set({ slidingMinCommission: v })}
                  disabled={isFixed || ro} readOnly={ro} placeholder="e.g. 20%" aria-label="Sliding Min Commission %" />
              </Fr>
              <Fr label="Max Commission %" missing={miss('Sliding Max Commission %')}>
                <NumField suffix="%" value={terms.slidingMaxCommission} onChange={(v) => set({ slidingMaxCommission: v })}
                  disabled={isFixed || ro} readOnly={ro} placeholder="e.g. 35%" aria-label="Sliding Max Commission %" />
              </Fr>
              <Fr label="" missing={miss('Provisional Commission %') || miss('Sliding Scale table (need ≥2 complete rows)')}>
                <div className="np-sub-actions">
                  <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={isFixed}
                    onClick={() => setModal('sliding')} data-testid="sliding-modal-button">
                    Enter slide manually
                  </button>
                  <span className="np-badge-count">
                    {slidingRows} row(s){terms.provisionalCommissionPct ? ` · provisional ${terms.provisionalCommissionPct}%` : ''}
                  </span>
                </div>
              </Fr>
            </div>
            <div className="td-block">
              <div className="td-mini">Additional</div>
              <Fr label="Management Expenses %">
                <NumField suffix="%" value={terms.mgmtExpensesPct} onChange={(v) => set({ mgmtExpensesPct: v })} readOnly={ro}
                  placeholder="e.g. 5%" aria-label="Management Expenses %" />
              </Fr>
              <Fr label="Profit Commission %">
                <NumField suffix="%" value={terms.profitCommissionPct} onChange={(v) => set({ profitCommissionPct: v })} readOnly={ro}
                  placeholder="e.g. 10%" aria-label="Profit Commission %" />
              </Fr>
              <Fr label="Loss Carry Forward (LCF)">
                <select className="fi" value={terms.lcfYears || ''} disabled={ro} aria-label="Loss Carry Forward (LCF)"
                  onChange={(e) => set({ lcfYears: e.target.value })}>
                  <option value="">None</option>
                  {LCF_YEARS.map((n) => <option key={n} value={n}>{n} year{n > 1 ? 's' : ''}</option>)}
                  <option value="extinction">Extinction</option>
                </select>
              </Fr>
            </div>
          </div>
        </div>

        {/* ═══ LOSS PARTICIPATION + EPI + BROKERAGE & TAXES ═══ */}
        <div className="td-card td-card--pane" data-testid="loss-participation">
          <div className="td-card-head">
            <span className="td-card-label">LOSS PARTICIPATION</span>
            <MiniPills ariaLabel="Loss participation enabled" readOnly={ro}
              options={[[true, 'YES'], [false, 'NO']]} value={lpOn}
              onChange={(v) => set({ lossPartEnabled: v })} />
          </div>
          <div className="td-card-body">
            <div className="td-hint">Capture loss participation corridors where the reinsurer share changes above a given loss ratio.</div>
            <div className={`np-terms-fade td-block${lpOn ? '' : ' is-off'}`} data-testid="lp-block" aria-disabled={!lpOn}>
              <Fr label="Min Loss Ratio %" missing={miss('LP Min Loss Ratio %')}>
                <NumField suffix="%" value={terms.minLossRatioPct} onChange={(v) => set({ minLossRatioPct: v })}
                  disabled={!lpOn || ro} readOnly={ro} placeholder="e.g. 70%" aria-label="LP Min Loss Ratio %" />
              </Fr>
              <Fr label="Max Loss Ratio %" missing={miss('LP Max Loss Ratio %')}>
                <NumField suffix="%" value={terms.maxLossRatioPct} onChange={(v) => set({ maxLossRatioPct: v })}
                  disabled={!lpOn || ro} readOnly={ro} placeholder="e.g. 100%" aria-label="LP Max Loss Ratio %" />
              </Fr>
              <Fr label="Reinsurer Share %" missing={miss('LP Reinsurer Share %')}>
                <NumField suffix="%" value={terms.reinsurerSharePct} onChange={(v) => set({ reinsurerSharePct: v, lpvPct: v })}
                  disabled={!lpOn || ro} readOnly={ro} placeholder="e.g. 50%" aria-label="LP Reinsurer Share %" />
              </Fr>
              <Fr label="">
                <div className="np-sub-actions">
                  <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={!lpOn}
                    onClick={() => setModal('lp')} data-testid="corridors-modal-button">
                    Enter slides manually
                  </button>
                  {corridorCount > 0 && <span className="np-badge-count np-badge-count--on">✓ {corridorCount} corridor(s)</span>}
                </div>
              </Fr>
            </div>
            <div className="td-block">
              <div className="td-mini">EPI</div>
              <Fr label={`Quota Share EPI (${ccy})`} missing={miss('Quota Share EPI')} hint={na(isQS)}>
                <NumField value={terms.quotaShareEpi} onChange={(v) => setEpi({ quotaShareEpi: v })}
                  disabled={!isQS || ro} readOnly={ro} placeholder={isQS ? 'e.g. 10,000,000' : NA}
                  title={na(isQS)} aria-label="Quota Share EPI" />
              </Fr>
              <Fr label={`Surplus EPI (${ccy})`} missing={miss('Surplus EPI')} hint={na(isSurplus)}>
                <NumField value={terms.surplusEpi} onChange={(v) => setEpi({ surplusEpi: v })}
                  disabled={!isSurplus || ro} readOnly={ro} placeholder={isSurplus ? 'e.g. 5,000,000' : NA}
                  title={na(isSurplus)} aria-label="Surplus EPI" />
              </Fr>
              <Fr label="">
                <div className="np-sub-actions">
                  <button type="button" className="np-struct-btn np-struct-btn--accent" onClick={openEpiSplit} data-testid="epi-split-button">
                    EPI split
                  </button>
                  <span className="np-badge-count">
                    {epiSplitCount > 0 ? `${epiSplitCount} class(es)` : (h.cobNames.length ? 'Equal split unless entered' : '')}
                  </span>
                </div>
              </Fr>
            </div>
            <div className="td-block">
              <div className="td-mini">Brokerage &amp; taxes</div>
              <Fr label="Brokerage %">
                <NumField suffix="%" value={terms.brokeragePct} onChange={(v) => set({ brokeragePct: v })} readOnly={ro}
                  placeholder="e.g. 5%" aria-label="Brokerage %" />
              </Fr>
              <Fr label="Taxes %">
                <NumField suffix="%" value={terms.taxesPct} onChange={(v) => set({ taxesPct: v })} readOnly={ro}
                  placeholder="e.g. 2%" aria-label="Taxes %" />
              </Fr>
              <Fr label="Loss Cap %">
                <NumField suffix="%" value={terms.lossCapPct} onChange={(v) => set({ lossCapPct: v })} readOnly={ro}
                  placeholder="e.g. 5%" aria-label="Loss Cap %" />
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
            data-testid="save-treaty-detail">
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
      </WizardNav>

      {modal === 'sliding' && (
        <SlidingScaleModal terms={terms} readOnly={ro} onClose={() => setModal(null)}
          onSave={(patch) => { set(patch); setModal(null); toast('Sliding scale saved.'); }} />
      )}
      {modal === 'lp' && (
        <LpSlidesModal terms={terms} readOnly={ro} onClose={() => setModal(null)}
          onSave={(patch) => { set(patch); setModal(null); toast('Loss participation corridors saved.'); }} />
      )}
      {modal === 'epi' && (
        <EpiSplitModal terms={terms} cobNames={h.cobNames} readOnly={ro} onClose={() => setModal(null)}
          onSave={(patch) => { set(patch); setModal(null); toast('EPI split saved.'); }} />
      )}
    </div>
  );
}

/** The contract behind /contracts/proportional: nothing stored yet. */
const NEW_CONTRACT = {
  id: null, reference: '', status: 'DRAFT', layers: [], quote_structures: [], class: '', currency: 'USD', notes: '',
};

/**
 * The placement's quota-share / surplus layers follow the terms — one per
 * half the treaty type activates, carrying its limit (the QS 100% limit, the
 * surplus capacity) and its EPI at 100% — so the renewal calendar and the
 * portfolio read the treaty's size. A layer already in the market keeps its
 * terms; only OPEN layers are rewritten or removed.
 */
async function syncPropLayers(pid, layers, terms, calc, currency) {
  const want = [];
  if (calc.hasQS) {
    want.push({
      type: 'QS', name: calc.hasSurplus ? 'Quota Share' : 'Structure 1',
      limit_amt: toNumber(terms.qsLimit) || null, premium100: toNumber(terms.quotaShareEpi) || 0,
    });
  }
  if (calc.hasSurplus) {
    want.push({
      type: 'Surplus', name: calc.hasQS ? 'Surplus' : 'Structure 1',
      limit_amt: calc.surplusCapacity || null, premium100: toNumber(terms.surplusEpi) || 0,
    });
  }
  const propLayers = (layers || []).filter((l) => l.type === 'QS' || l.type === 'Surplus');
  for (const [i, w] of want.entries()) {
    const existing = propLayers.find((l) => l.type === w.type);
    if (!existing) {
      await api('POST', `/placements/${pid}/layers`, { ...w, order_pct: 100, currency, position: i + 1 });
    } else if (existing.status === 'OPEN') {
      await api('PATCH', `/layers/${existing.id}`, { name: w.name, limit_amt: w.limit_amt, premium100: w.premium100, currency, position: i + 1 });
    }
  }
  for (const l of propLayers) {
    if (!want.some((w) => w.type === l.type) && l.status === 'OPEN') await api('DELETE', `/layers/${l.id}`);
  }
}
