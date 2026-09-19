import React, { useEffect, useState } from 'react';
import { StatusPill, fmtCompact, fmtDate, fmtPct } from '../../components.jsx';
import { SCOPES, CAL_GROUPS, expectedSplit, assumedProfile, num } from './model.js';
import { fmtKind, Section, Note, NumberField } from './bits.jsx';

/*
 * 01 Scope — what the desk models, and the loss model the engine will
 * simulate. Three choices: a standalone book typed from scratch, one
 * contract read from a placement, or the whole portfolio (narrowed to a
 * selection if wanted). The loss model is then read back in sentences —
 * seeded from the book for a contract or the portfolio, from market
 * defaults for a standalone book — and every figure can be adjusted; the
 * split of the expected loss updates as it is typed, so a mis-keyed
 * severity shows before anything is run.
 */

const usableOf = (portfolio) => portfolio.placements.filter((p) => p.calibration.subject_premium > 0);
const labelOf = (p) => `${p.reference} · ${p.cedant_name} · ${p.class} · ${p.currency} ${fmtCompact(p.calibration.subject_premium)}`;

/** The three ways in, as cards; the one in force is marked. */
function ScopeCards({ mode, onPick, working }) {
  const go = {
    standalone: mode === 'standalone' ? 'Modelling a standalone book' : 'Start from scratch →',
    contract: mode === 'contract' ? 'Modelling one contract' : working ? `Model ${working.reference} →` : 'Pick a placement →',
    portfolio: mode === 'portfolio' ? 'Modelling the portfolio' : 'Model every placement →',
  };
  return (
    <div className="dfa-scopes" role="group" aria-label="What to model" data-testid="dfa-scopes">
      {SCOPES.map((s) => (
        <button
          key={s.key}
          type="button"
          className={`dfa-scope${mode === s.key ? ' is-on' : ''}`}
          aria-pressed={mode === s.key}
          onClick={() => onPick(s.key)}
          data-testid={`dfa-scope-${s.key}`}
        >
          <span className="kicker accent">{s.kicker}</span>
          <span className="dfa-scope-t">{s.label}</span>
          <span className="dfa-scope-x">{s.text}</span>
          <span className="dfa-scope-go">{go[s.key]}</span>
        </button>
      ))}
    </div>
  );
}

function sourceNote(portfolio) {
  const picked = portfolio.placements.filter((p) => (portfolio.selected || []).includes(p.id));
  const sources = [...new Set(picked.map((p) => p.calibration.premium_source).filter(Boolean))];
  const withExp = picked.filter((p) => p.calibration.experience).length;
  const withReserves = picked.filter((p) => p.calibration.reserves_source).length;
  const withProfile = picked.filter((p) => p.calibration.risk_profile_source).length;
  return {
    premium: sources.length ? sources.join(', ') : 'no recorded premium',
    lossRatio: withExp
      ? `${withExp} placement${withExp === 1 ? '' : 's'} with bordereau experience`
      : 'market defaults — no bordereaux on the selection',
    reserves: withReserves ? 'outstanding on the claims bordereaux' : 'none on the bordereaux — type it if the book carries one',
    profile: withProfile
      ? `the modelling pack’s risk profile · ${withProfile} of ${picked.length} placement${picked.length === 1 ? '' : 's'}`
      : 'assumed from the large-loss calibration — type the book’s profile for a true surplus reading',
  };
}

/**
 * The risk profile a surplus treaty responds to: the sums insured the book
 * is written on and their share of the premium. Seeded from the modelling
 * pack when the placement carries one; otherwise the engine's assumption is
 * shown and can be typed over. Blank rows are ignored; no usable row means
 * the assumption stands.
 */
function RiskProfileEditor({ cal, setCal, ccy }) {
  const bands = cal.risk_profile || [];
  const setBands = (next) => setCal((c) => ({ ...c, risk_profile: next }));
  const update = (i, patch) => setBands(bands.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const total = bands.reduce((a, b) => a + num(b.premium_pct), 0);
  return (
    <fieldset className="dfa-fieldset" data-testid="dfa-profile">
      <legend>Risk profile — what a surplus treaty responds to</legend>
      <p className="dfa-note">
        The sums insured the book is written on, as bands: a typical sum insured and its share of the premium.
        A surplus keeps one line of every risk and cedes the part above it, so this is what decides how much it
        cedes. Shares are read pro rata, so they need not sum to 100.
      </p>
      {bands.length ? (
        <div className="table-wrap dfa-layers-wrap">
          <table className="table dfa-layers dfa-profile-table">
            <thead>
              <tr>
                <th className="r">Sum insured{ccy ? ` (${ccy})` : ''}</th>
                <th className="r">Share of premium %</th>
                <th><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b, i) => (
                <tr key={i}>
                  <td className="r"><input className="input r" type="number" min="0" value={b.sum_insured ?? ''} aria-label={`Band ${i + 1} sum insured`} onChange={(e) => update(i, { sum_insured: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                  <td className="r"><input className="input r" type="number" min="0" max="100" step="0.1" value={b.premium_pct ?? ''} aria-label={`Band ${i + 1} share of premium`} onChange={(e) => update(i, { premium_pct: e.target.value === '' ? '' : Number(e.target.value) })} /></td>
                  <td className="r"><button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove band ${i + 1}`} onClick={() => setBands(bands.filter((_, j) => j !== i))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="dfa-note">
          No profile typed: the engine assumes {assumedProfile(cal).map((b) => `${fmtCompact(b.sum_insured)} (${b.premium_pct}%)`).join(', ')} — five bands from the
          large-loss threshold to the largest single loss, the premium halving from one band to the next.
        </p>
      )}
      <div className="sechead-actions" style={{ marginLeft: 0 }}>
        <button
          type="button" className="btn btn-secondary btn-sm" data-testid="dfa-profile-add"
          onClick={() => setBands([...(bands.length ? bands : assumedProfile(cal)), { sum_insured: '', premium_pct: '' }])}
        >
          {bands.length ? '+ Add band' : 'Type the profile'}
        </button>
        {bands.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBands(null)}>Use the engine’s assumption</button>
        )}
        {bands.length > 0 && total > 0 && <span className="muted small">shares total {total.toFixed(1)}%</span>}
      </div>
    </fieldset>
  );
}

/** One contract: the picker, and the placement's facts once picked. */
function ContractPanel({ portfolio, mode, setScope, workingPlacementId }) {
  const usable = usableOf(portfolio);
  const chosen = mode === 'contract' ? (portfolio.selected?.[0] || '') : '';
  const working = usable.find((p) => p.id === workingPlacementId);
  const picked = usable.find((p) => p.id === chosen);
  const covers = picked ? [
    picked.structure.quota_share ? `QS ${fmtPct(picked.structure.quota_share.cession_pct, 0)}` : null,
    picked.structure.xol_layers.length ? `${picked.structure.xol_layers.length} XoL ${picked.structure.xol_layers.length === 1 ? 'layer' : 'layers'}` : null,
  ].filter(Boolean).join(' · ') : '';
  return (
    <Section
      title="The contract"
      hint={picked ? `${picked.cedant_name} · ${picked.class}` : 'a placement on the book'}
      testid="dfa-contract"
    >
      <div className="blueprint dfa-panel">
        <label className="field">
          <span>Placement</span>
          <select
            className="input"
            value={chosen}
            onChange={(e) => { if (e.target.value) setScope({ mode: 'contract', placements: [e.target.value] }); }}
            data-testid="dfa-contract-pick"
          >
            <option value="">Select a placement…</option>
            {working && (
              <optgroup label="Working placement">
                <option value={working.id}>{labelOf(working)}</option>
              </optgroup>
            )}
            <optgroup label="Every placement with a premium">
              {usable.map((p) => <option key={p.id} value={p.id}>{labelOf(p)}</option>)}
            </optgroup>
          </select>
        </label>
        {picked ? (
          <dl className="dfa-deflist">
            <div><dt>Cedant</dt><dd>{picked.cedant_name}</dd></div>
            <div><dt>Class</dt><dd>{picked.class}</dd></div>
            <div><dt>Period</dt><dd>{fmtDate(picked.inception)} – {fmtDate(picked.expiry)} · {picked.currency} · <StatusPill value={picked.status} /></dd></div>
            <div><dt>Subject premium</dt><dd>{picked.currency} {fmtCompact(picked.calibration.subject_premium)} <span className="muted">· {picked.calibration.premium_source}</span></dd></div>
            <div><dt>Loss ratio</dt><dd>{fmtPct(picked.calibration.expected_loss_ratio_pct, 1)} <span className="muted">· {picked.calibration.loss_ratio_source}</span></dd></div>
            <div><dt>Programme in force</dt><dd>{covers || <span className="muted">no reinsurance on the book</span>}</dd></div>
            <div><dt>Signed panel</dt><dd>{portfolio.panel.length ? `${portfolio.panel.length} ${portfolio.panel.length === 1 ? 'market' : 'markets'} · their ratings seed the default probability` : <span className="muted">no signed lines yet</span>}</dd></div>
          </dl>
        ) : (
          <p className="dfa-lede">
            The loss model and the programme in force are read from the placement — its premium,
            its bordereaux, its layers and the lines signed on them. Everything can be adjusted
            afterwards; nothing is written back.
          </p>
        )}
      </div>
    </Section>
  );
}

/** The portfolio: every placement with a premium, ticked to narrow. */
function PortfolioPanel({ portfolio, selection, setSelection, setScope }) {
  const all = portfolio.placements;
  const usable = usableOf(portfolio);
  const selected = new Set(selection || portfolio.selected);
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (next.size) setSelection([...next]);
  };
  return (
    <Section
      title="The portfolio"
      hint={`${selected.size} of ${usable.length} with a subject premium`}
      actions={(
        <button
          type="button" className="btn btn-secondary btn-sm" disabled={!selection}
          onClick={() => setScope({ mode: 'portfolio' })} data-testid="dfa-whole-portfolio"
        >
          Whole portfolio
        </button>
      )}
      testid="dfa-portfolio"
    >
      <div className="blueprint dfa-panel">
        <p className="dfa-lede">
          Every placement with a premium reads as one book, its programmes' layers all
          responding to the same events — an approximation, said so on 02 Programme.
          Untick placements to narrow the book.
        </p>
        {portfolio.mixed_currency && (
          <div className="dfa-warn">
            The selection spans {portfolio.currencies.join(' / ')} — figures are summed without FX.
            Narrow to one currency for a clean read.
          </div>
        )}
        <div className="table-wrap dfa-book-wrap">
          <table className="table dfa-book-table">
            <thead>
              <tr>
                <th className="dfa-book-check"><span className="sr-only">In the analysis</span></th>
                <th>Placement</th>
                <th>Cedant</th>
                <th>Class</th>
                <th>Status</th>
                <th className="r">Subject premium</th>
                <th>Loss ratio</th>
                <th className="r">Covers on the book</th>
              </tr>
            </thead>
            <tbody>
              {all.map((p) => {
                const c = p.calibration;
                const on = selected.has(p.id);
                const ok = c.subject_premium > 0;
                const covers = [
                  p.structure.quota_share ? `QS ${fmtPct(p.structure.quota_share.cession_pct, 0)}` : null,
                  p.structure.xol_layers.length ? `${p.structure.xol_layers.length} XoL` : null,
                ].filter(Boolean).join(' · ');
                return (
                  <tr key={p.id} className={on ? 'is-on' : ok ? '' : 'is-off'}>
                    <td className="dfa-book-check">
                      <input
                        type="checkbox"
                        id={`dfa-pick-${p.id}`}
                        checked={on}
                        disabled={!ok}
                        onChange={() => toggle(p.id)}
                        aria-label={`Include ${p.reference}`}
                        title={ok ? undefined : 'No subject premium recorded — nothing to simulate'}
                      />
                    </td>
                    <td><label htmlFor={`dfa-pick-${p.id}`} className="mono dfa-book-ref">{p.reference}</label></td>
                    <td>{p.cedant_name}</td>
                    <td className="dfa-book-class">{p.class}</td>
                    <td><StatusPill value={p.status} /></td>
                    <td className="r num">{ok ? `${p.currency} ${fmtCompact(c.subject_premium)}` : <span className="muted">none recorded</span>}</td>
                    <td>
                      {fmtPct(c.expected_loss_ratio_pct, 1)}
                      <div className="dfa-book-sub">{c.loss_ratio_source || 'market default'}</div>
                    </td>
                    <td className="r">{covers || <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Note>
          Changing the selection re-reads the loss model and both programmes from the book,
          so settle the selection first and edit the programme after.
        </Note>
      </div>
    </Section>
  );
}

/** A standalone book: nothing read from the register; the currency and how to use it. */
function StandalonePanel({ ccy, setCcy }) {
  return (
    <Section title="A standalone book" hint="nothing is read from a placement" testid="dfa-standalone">
      <div className="blueprint dfa-panel">
        <p className="dfa-lede">
          Type the book's figures in the loss model beside this. The programme on 02 starts
          with no reinsurance: build the programme in force as the <b>current</b> one (or leave
          it empty to measure against running gross) and the alternative as the <b>proposed</b>{' '}
          one. Nothing here touches the register.
        </p>
        <div className="dfa-fields dfa-fields-row">
          <label className="field">
            <span>Currency</span>
            <input
              className="input" value={ccy} placeholder="e.g. USD" maxLength={3}
              onChange={(e) => setCcy(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
              aria-label="Currency" data-testid="dfa-ccy"
            />
          </label>
        </div>
        <Note>
          Market defaults seed the loss ratio, the event rates and the uncertainty; a signed
          panel is not known here, so the reinsurer default probability is the A-rated default
          on 03 Assumptions.
        </Note>
      </div>
    </Section>
  );
}

/** The expected annual loss, split the way the engine simulates it. */
function Split({ cal, ccy }) {
  const s = expectedSplit(cal);
  // Nothing to split until there is a premium to split it against.
  if (!(s.premium > 0) || !(s.modelled > 0)) return null;
  const pct = (v) => `${((v / s.modelled) * 100).toFixed(0)}%`;
  const segs = [
    ['attritional', 'Attritional (many small losses)', s.attritional],
    ['large', 'Large single losses', s.large],
    ['cat', 'Catastrophe events', s.cat],
  ];
  return (
    <div className="dfa-split-block">
      <div className="kicker">Where the expected loss comes from</div>
      <div className="dfa-split" role="img" aria-label={`Expected annual loss ${fmtKind(s.modelled, 'money', ccy)}: ${segs.map(([, l, v]) => `${l} ${pct(v)}`).join(', ')}`}>
        {segs.map(([k, , v]) => (
          <span key={k} className={`dfa-split-seg is-${k}`} style={{ width: `${(v / s.modelled) * 100}%` }} />
        ))}
      </div>
      <div className="dfa-split-legend">
        {segs.map(([k, label, v]) => (
          <span key={k}><i className={`dfa-split-key is-${k}`} aria-hidden="true" /> {label} <b>{fmtKind(v, 'money', ccy)}</b> · {pct(v)}</span>
        ))}
      </div>
      {s.overrun ? (
        <div className="dfa-warn">
          Large and cat events alone come to {fmtPct(s.modelled_loss_ratio_pct, 1)} of premium — more than the
          expected loss ratio. The model runs at that hotter figure, with no attritional cost left over.
          Lower the event rates or severities, or raise the loss ratio.
        </div>
      ) : (
        <Note>{fmtKind(s.modelled, 'money', ccy)} expected a year, {fmtPct(s.modelled_loss_ratio_pct, 1)} of the subject premium.</Note>
      )}
    </div>
  );
}

function LossModel({ portfolio, mode, cal, setCal, ccy }) {
  const standalone = mode === 'standalone';
  const [adjusting, setAdjusting] = useState(standalone);
  useEffect(() => { setAdjusting(standalone); }, [standalone]);
  if (!cal) return null;
  const src = standalone
    ? { premium: 'typed here', lossRatio: 'market default', reserves: 'typed here', profile: cal.risk_profile?.length ? 'typed here' : 'assumed from the large-loss calibration — type the book’s profile for a true surplus reading' }
    : sourceNote(portfolio);
  const profileBands = (cal.risk_profile || []).filter((b) => num(b.sum_insured) > 0 && num(b.premium_pct) > 0);
  const profileShown = profileBands.length ? profileBands : assumedProfile(cal);
  const reserves = num(cal.opening_reserves);
  const reserveDev = num(cal.reserve_development_pct);
  const m = (v) => fmtKind(v, 'money', ccy);
  const threshold = num(cal.large_loss_threshold);
  const premium = num(cal.subject_premium);
  return (
    <Section
      title="Loss model"
      hint={standalone ? 'market defaults · the premium is yours to type' : 'seeded from the book · every figure is an assumption, not a record'}
      actions={(
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdjusting(!adjusting)} data-testid="dfa-adjust">
          {adjusting ? 'Done adjusting' : 'Adjust the model'}
        </button>
      )}
      testid="dfa-model"
    >
      <div className="blueprint dfa-panel">
        <dl className="dfa-deflist">
          <div>
            <dt>Subject premium</dt>
            <dd>
              {premium > 0 ? m(premium) : <span className="dfa-warn-inline">not typed yet</span>}
              {' '}<span className="muted">· {src.premium}</span>
            </dd>
          </div>
          <div>
            <dt>Expected loss ratio</dt>
            <dd>{fmtPct(num(cal.expected_loss_ratio_pct), 1)} <span className="muted">· {src.lossRatio}</span></dd>
          </div>
          <div>
            <dt>Large losses</dt>
            <dd>
              {num(cal.large_frequency).toLocaleString('en-US', { maximumFractionDigits: 1 })} a year above {m(threshold)},
              averaging {m(num(cal.large_severity_mean))}
              <span className="muted"> · largest {cal.large_severity_cap ? m(num(cal.large_severity_cap)) : '40 × average'}</span>
            </dd>
          </div>
          <div>
            <dt>Catastrophe events</dt>
            <dd>
              {num(cal.cat_frequency).toLocaleString('en-US', { maximumFractionDigits: 2 })} a year, averaging {m(num(cal.cat_severity_mean))}
              <span className="muted"> · PML {cal.cat_pml ? m(num(cal.cat_pml)) : '40 × average'}</span>
            </dd>
          </div>
          <div>
            <dt>Prior-year reserves</dt>
            <dd>
              {reserves > 0 ? (
                <>
                  {m(reserves)} opening, expected to run off {reserveDev === 0 ? 'flat' : `${fmtPct(Math.abs(reserveDev), 0)} ${reserveDev > 0 ? 'adverse' : 'as a release'}`}
                  {' '}· uncertainty {fmtPct(num(cal.reserve_cv_pct), 0)}
                </>
              ) : <span className="muted">none — the year carries no prior-year run-off</span>}
              {' '}<span className="muted">· {src.reserves}</span>
            </dd>
          </div>
          <div>
            <dt>Risk profile</dt>
            <dd>
              {profileShown.length} bands from {m(Math.min(...profileShown.map((b) => num(b.sum_insured))))} to {m(Math.max(...profileShown.map((b) => num(b.sum_insured))))}
              <span className="muted"> · for a surplus treaty · {src.profile}</span>
            </dd>
          </div>
          <div>
            <dt>How sure we are</dt>
            <dd>
              attritional swings {fmtPct(num(cal.attritional_cv_pct), 0)} · parameter uncertainty {fmtPct(num(cal.parameter_uncertainty_pct), 0)}
              {' '}· cat rate uncertainty {fmtPct(num(cal.cat_frequency_cv_pct), 0)}
              {!standalone && <span className="muted"> · wider when fewer bordereau years are observed</span>}
            </dd>
          </div>
        </dl>

        <Split cal={cal} ccy={ccy} />

        {adjusting && (
          <div className="dfa-fieldsets" data-testid="dfa-model-fields">
            <RiskProfileEditor cal={cal} setCal={setCal} ccy={ccy} />
            {CAL_GROUPS.map((g) => (
              <fieldset key={g.label} className="dfa-fieldset">
                <legend>{g.label}</legend>
                <p className="dfa-note">{g.note}</p>
                <div className="dfa-fields">
                  {g.fields.map((f) => (
                    <NumberField
                      key={f.key}
                      label={`${f.label}${f.kind === 'money' && ccy ? ` (${ccy})` : ''}`}
                      title={f.title}
                      placeholder={f.key === 'subject_premium' && standalone ? 'type the premium' : f.placeholder}
                      min="0"
                      value={cal[f.key] ?? ''}
                      onChange={(v) => setCal((c) => ({ ...c, [f.key]: v }))}
                      testid={`dfa-cal-${f.key}`}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

export default function ScopeTab({ shared }) {
  const {
    portfolio, mode, selection, setScope, setSelection, setStandaloneCcy, workingPlacementId,
    cal, setCal, ccy,
  } = shared;
  // "One contract" with no working placement to suggest shows the picker;
  // picking stays open until a scope is chosen.
  const [picking, setPicking] = useState(false);
  useEffect(() => { setPicking(false); }, [mode]);
  if (!portfolio) return <div className="muted small">Reading the book…</div>;
  const usable = usableOf(portfolio);
  const working = usable.find((p) => p.id === workingPlacementId);

  const pick = (key) => {
    if (key === 'standalone') setScope({ mode: 'standalone', ccy: ccy || '' });
    else if (key === 'portfolio') setScope({ mode: 'portfolio' });
    else if (working && mode !== 'contract') setScope({ mode: 'contract', placements: [working.id] });
    else setPicking(true);
  };

  const showContract = mode === 'contract' || picking || mode === 'unchosen';
  return (
    <>
      <ScopeCards mode={mode} onPick={pick} working={working} />
      <div className="dfa-grid dfa-grid-book">
        {mode === 'standalone' && <StandalonePanel ccy={ccy} setCcy={setStandaloneCcy} />}
        {mode === 'portfolio' && (
          <PortfolioPanel portfolio={portfolio} selection={selection} setSelection={setSelection} setScope={setScope} />
        )}
        {mode !== 'standalone' && mode !== 'portfolio' && showContract && (
          <ContractPanel portfolio={portfolio} mode={mode} setScope={setScope} workingPlacementId={workingPlacementId} />
        )}
        {cal ? (
          <LossModel portfolio={portfolio} mode={mode} cal={cal} setCal={setCal} ccy={ccy} />
        ) : (
          <Section title="Loss model" hint={mode === 'unchosen' ? 'follows the scope' : 'nothing to seed'}>
            <div className="blueprint dfa-panel">
              <p className="dfa-lede">
                {mode === 'unchosen'
                  ? 'Choose what to model and the loss model appears here — read from the placement, from the portfolio, or from market defaults for a standalone book.'
                  : 'None of the selected placements carries a subject premium, so there is no book to model. Pick a placement with a premium, record one on the placement, or model a standalone book.'}
              </p>
            </div>
          </Section>
        )}
      </div>
    </>
  );
}
