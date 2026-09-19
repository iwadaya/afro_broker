import React, { useEffect, useMemo, useState } from 'react';
import { ModScreen, SaveBar, Toggle, Notice, Kpi, KpiRow, useSaveMsg } from './bits.jsx';
import { useModelling, useScreenSave, triangleCellsOf, incurredCellsOf } from './store.jsx';
import { buildCalcs, calculateBF, calculateBFPremium, cn, fmtC, fmt4, fPct } from './engine.js';

/* Development Factors — ported from the modelling tool's DevFactorsScreen,
   shared by the Premium / Paid / OS / Incurred tabs. Chain-ladder pattern
   from the saved triangle (weighted / simple / last-3 / last-5, with per-cell
   link-ratio exclusions), the exponential-fit parametrized set, the
   Bornhuetter-Ferguson overlay (loss IELR, or EPI × % achieved on premium),
   and the underwriter's chosen factors — the row every projection downstream
   actually uses. */

const TYPES = {
  premium: { title: 'Premium Dev Factors', pill: 'PROPORTIONAL TREATY: PREMIUM DEV FACTORS' },
  paid: { title: 'Paid Claims Dev Factors', pill: 'PROPORTIONAL TREATY: PAID CLAIMS DEV FACTORS' },
  os: { title: 'OS Claims Dev Factors', pill: 'PROPORTIONAL TREATY: OS CLAIMS DEV FACTORS' },
  incurred: { title: 'Incurred Dev Factors', pill: 'PROPORTIONAL TREATY: INCURRED DEV FACTORS' },
};

const AVG_METHODS = [['weighted', 'Weighted'], ['simple', 'Simple'], ['last3', 'Last 3'], ['last5', 'Last 5']];

/** LDF + CDF rows across dev periods; editable when the chosen set. */
export function FactorTable({ pattern, cdfs, editable, onChange, accent }) {
  const n = pattern?.length || 0;
  if (!n) return <Notice tone="info">No factors yet — the triangle needs at least two development columns.</Notice>;
  return (
    <div className="np-table-wrap">
      <table className={`mod-table mod-table--compact df-factors${accent ? ` df-factors--${accent}` : ''}`}>
        <thead>
          <tr>
            <th>FACTOR</th>
            {Array.from({ length: n }, (_, i) => <th className={editable ? 'mod-cell--center' : 'mod-num'} key={i}>{i + 1}–{i + 2}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>LDF</td>
            {pattern.map((v, i) => (
              <td key={i} className="mod-num">
                {editable
                  ? <input className="mod-cell mod-cell--center" value={v == null ? '' : String(v)} onChange={(e) => onChange('ldf', i, e.target.value)} />
                  : fmt4(v)}
              </td>
            ))}
          </tr>
          <tr>
            <td>CDF</td>
            {Array.from({ length: n }, (_, i) => (
              <td key={i} className="mod-num">
                {editable
                  ? <input className="mod-cell mod-cell--center" value={cdfs?.[i] == null ? '' : String(cdfs[i])} onChange={(e) => onChange('cdf', i, e.target.value)} />
                  : fmt4(cdfs?.[i])}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function DevFactorsScreen({ type }) {
  const mod = useModelling();
  const { meta, get, save } = mod;
  const cfg = TYPES[type];
  const section = `dev_factors_${type}`;
  const isPremium = type === 'premium';
  const { startYear, numDevYears, years } = meta;

  const [view, setView] = useState('FACTORS');
  const [avgMethod, setAvgMethod] = useState('weighted');
  const [projMethod, setProjMethod] = useState('CHAIN');
  const [chosenBase, setChosenBase] = useState('ACTUAL');
  const [chosenLdfs, setChosenLdfs] = useState([]);
  const [chosenCdfs, setChosenCdfs] = useState([]);
  const [excluded, setExcluded] = useState(new Set());
  const [ielr, setIelr] = useState('0.65');
  const [epiPerYear, setEpiPerYear] = useState([]);
  const [percentAchieved, setPercentAchieved] = useState('1.00');
  const [dirty, setDirty] = useState(false);
  const [msg, flash] = useSaveMsg();

  const cells = useMemo(
    () => (type === 'incurred' ? incurredCellsOf(mod, 'MODIFIED') : triangleCellsOf(mod, type, 'MODIFIED')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections, type],
  );
  const premiumCells = useMemo(() => triangleCellsOf(mod, 'premium', 'MODIFIED'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod.sections]);

  // Latest premium diagonal per year — the BF volume for the loss screens.
  const premiums = useMemo(() => years.map((yr) => {
    const latest = premiumCells.filter((c) => Number(c.origin_year) === yr)
      .sort((a, b) => b.dev_months - a.dev_months)[0];
    return latest ? Number(latest.cum_value) || 0 : 0;
  }), [premiumCells, years]);

  const calcs = useMemo(
    () => buildCalcs(cells, { startYear, numDevYears, avgMethod, years, excluded }),
    [cells, startYear, numDevYears, avgMethod, years, excluded],
  );

  // Hydrate saved factors and settings.
  useEffect(() => {
    const data = get(section);
    if (data) {
      const factors = data.factors || [];
      if (factors.length) {
        setChosenLdfs(factors.map((f) => f.chosen_ldf ?? null));
        setChosenCdfs(factors.map((f) => f.chosen_cdf ?? null));
      } else {
        setChosenLdfs([]);
        setChosenCdfs([]);
      }
      const s = data.settings || {};
      if (s.avg_method) setAvgMethod(s.avg_method);
      if (s.proj_method) setProjMethod(s.proj_method);
      if (s.chosen_base) setChosenBase(s.chosen_base);
      if (s.bf_ielr != null && Number(s.bf_ielr) > 0) setIelr(String(s.bf_ielr));
      if (s.bf_percent_achieved != null) setPercentAchieved(String(s.bf_percent_achieved));
      if (Array.isArray(s.bf_epi_per_year) && s.bf_epi_per_year.length) {
        setEpiPerYear(s.bf_epi_per_year.map((v) => (v == null ? '' : String(v))));
      }
      if (Array.isArray(s.excluded_ratios) && (!s.excluded_for_year_window || s.excluded_for_year_window === `${startYear}:${numDevYears}`)) {
        setExcluded(new Set(s.excluded_ratios));
      }
    } else {
      setChosenLdfs([]);
      setChosenCdfs([]);
      setExcluded(new Set());
    }
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.sections, type]);

  // Seed chosen factors when empty and calcs exist (never over saved ones).
  useEffect(() => {
    if (!calcs || chosenLdfs.length > 0 || !calcs.pattern?.length) return;
    setChosenLdfs(calcs.pattern.map((v) => v));
    setChosenCdfs(calcs.cdfs.slice(0, calcs.pattern.length).map((v) => v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calcs]);

  // EPI rows track the year window.
  useEffect(() => {
    if (!isPremium) return;
    setEpiPerYear((prev) => (prev.length === years.length ? prev : years.map((_, i) => prev[i] ?? '')));
  }, [isPremium, years]);

  const switchBase = (base) => {
    if (base === 'LINK_RATIO') return;
    setChosenBase(base);
    if (!calcs) return;
    const src = base === 'PARAM' ? { ldfs: calcs.paramLdfs, cdfs: calcs.paramCdfs } : { ldfs: calcs.pattern, cdfs: calcs.cdfs };
    setChosenLdfs((src.ldfs || []).map((v) => v));
    setChosenCdfs((src.cdfs || []).slice(0, src.ldfs?.length || 0).map((v) => v));
    setDirty(true);
  };

  const handleChosenChange = (kind, idx, val) => {
    const n = val === '' ? null : Number(val);
    const set = kind === 'ldf' ? setChosenLdfs : setChosenCdfs;
    set((prev) => {
      const a = [...prev];
      a[idx] = n != null && Number.isFinite(n) ? n : val;
      return a;
    });
    setDirty(true);
  };

  const toggleExcluded = (r, c) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      const key = `${r}:${c}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setDirty(true);
  };

  const applyLinkRatioPattern = () => {
    if (!calcs) return;
    setChosenLdfs(calcs.pattern.map((v) => v));
    setChosenCdfs(calcs.cdfs.slice(0, calcs.pattern.length).map((v) => v));
    setChosenBase('LINK_RATIO');
    setDirty(true);
  };

  const bfResults = useMemo(() => {
    if (!calcs?.clProjections || projMethod !== 'BF' || isPremium) return null;
    return calculateBF(calcs.clProjections, premiums, Number(ielr) || 0);
  }, [calcs, projMethod, isPremium, premiums, ielr]);

  const bfPremiumResults = useMemo(() => {
    if (!calcs?.clProjections || projMethod !== 'BF' || !isPremium) return null;
    const epis = years.map((_, i) => cn(epiPerYear[i]));
    const pa = Number(percentAchieved);
    return calculateBFPremium(calcs.clProjections, epis, Number.isFinite(pa) ? pa : 1);
  }, [calcs, projMethod, isPremium, years, epiPerYear, percentAchieved]);

  const suggestedPercentAchieved = useMemo(() => {
    if (!isPremium) return null;
    const ratios = [];
    for (let i = 0; i < years.length; i++) {
      const e = cn(epiPerYear[i]);
      const cur = premiums[i] || 0;
      if (e > 0 && cur > 0) ratios.push(cur / e);
    }
    if (!ratios.length) return null;
    return ratios.reduce((a, b) => a + b, 0) / ratios.length;
  }, [isPremium, years, epiPerYear, premiums]);

  const doSave = async () => {
    if (!dirty && get(section)) return true;
    if (!chosenLdfs.length && !dirty) return true;
    try {
      const N = chosenLdfs.length;
      const factors = Array.from({ length: N }, (_, i) => ({
        dev_month: (i + 1) * 12,
        actual_ldf: calcs?.pattern?.[i] ?? null,
        actual_cdf: calcs?.cdfs?.[i] ?? null,
        parametrized_ldf: calcs?.paramLdfs?.[i] ?? null,
        parametrized_cdf: calcs?.paramCdfs?.[i] ?? null,
        chosen_source: chosenBase === 'LINK_RATIO' ? 'SELECTED' : chosenBase,
        chosen_ldf: chosenLdfs[i] == null ? null : Number(chosenLdfs[i]) || null,
        chosen_cdf: chosenCdfs[i] == null ? null : Number(chosenCdfs[i]) || null,
      }));
      await save(section, {
        factors,
        settings: {
          avg_method: avgMethod,
          proj_method: projMethod,
          chosen_base: chosenBase,
          tail_factor: 1.0,
          bf_ielr: Number(ielr) || 0,
          excluded_ratios: [...excluded],
          excluded_for_year_window: `${startYear}:${numDevYears}`,
          ...(isPremium ? {
            bf_percent_achieved: Number(percentAchieved) || 1,
            bf_epi_per_year: years.map((_, i) => cn(epiPerYear[i])),
          } : {}),
        },
      });
      setDirty(false);
      flash('ok', 'Dev factors saved');
      return true;
    } catch (e) {
      flash('err', `Save failed: ${e.message || 'server error'}`);
      return false;
    }
  };
  useScreenSave(mod, doSave);

  const hasData = !!(calcs && calcs.pattern?.length);

  return (
    <ModScreen pill={cfg.pill} title={cfg.title}
      sub="Chain-ladder factors from the saved triangle; pick actual, parametrized or link-ratio-filtered factors — the chosen set drives the projections."
      actions={<SaveBar dirty={dirty} msg={msg} onSave={doSave} canEdit={meta.canEdit} />}>

      <div className="tri-info-bar">
        <div className="tri-info-item">Start Year <b>{startYear}</b></div>
        <div className="tri-info-item">Dev Years <b>{numDevYears}</b></div>
        <div className="tri-info-item">Average
          <Toggle value={avgMethod} options={AVG_METHODS} disabled={!meta.canEdit}
            onChange={(m) => { setAvgMethod(m); setDirty(true); }} />
        </div>
        <div className="tri-info-item">Projection
          <Toggle value={projMethod} options={[['CHAIN', 'Chain Ladder'], ['BF', 'Bornhuetter-Ferguson']]} disabled={!meta.canEdit}
            onChange={(m) => { setProjMethod(m); setDirty(true); }} />
        </div>
        <Toggle value={view} onChange={setView}
          options={[['FACTORS', '📊 Dev Factors'], ['LINK_RATIOS', '🔗 Link Ratios']]} />
      </div>

      {!hasData && (
        <Notice tone="info">
          No triangle data for this basis yet — enter the {type === 'incurred' ? 'Claims Paid and OS Claims triangles' : `${cfg.title.replace(' Dev Factors', '')} triangle`} first.
        </Notice>
      )}

      {calcs?.patternWarnings?.length > 0 && (
        <Notice tone="warn">
          <b>⚠ Thin LDF columns ({calcs.patternWarnings.length}).</b>{' '}
          {calcs.patternWarnings.map((w) => `${w.devPeriod} months has ${w.contributingRows} origin year${w.contributingRows === 1 ? '' : 's'}`).join('; ')} — minimum recommended is 3.
        </Notice>
      )}

      {view === 'FACTORS' && hasData && (
        <>
          {projMethod === 'BF' && !isPremium && (
            <div className="mod-bf-bar">
              <label>Initial Expected Loss Ratio (IELR)</label>
              <input className="mod-cell mod-cell--center" style={{ width: 90 }} value={ielr} disabled={!meta.canEdit}
                onChange={(e) => { setIelr(e.target.value); setDirty(true); }} />
              <span className="muted">{((Number(ielr) || 0) * 100).toFixed(0)}% — a priori ultimate = premium × IELR</span>
            </div>
          )}
          {projMethod === 'BF' && isPremium && (
            <div className="mod-bf-bar">
              <label>% Achieved</label>
              <input className="mod-cell mod-cell--center" style={{ width: 90 }} value={percentAchieved} disabled={!meta.canEdit}
                onChange={(e) => { setPercentAchieved(e.target.value); setDirty(true); }} />
              {suggestedPercentAchieved != null && (
                <button type="button" className="np-struct-btn" disabled={!meta.canEdit}
                  onClick={() => { setPercentAchieved(suggestedPercentAchieved.toFixed(4)); setDirty(true); }}>
                  Use suggested {suggestedPercentAchieved.toFixed(4)}
                </button>
              )}
              <span className="muted">A priori ultimate = EPI × % achieved</span>
            </div>
          )}

          <section className="np-struct-card">
            <div className="np-struct-card-header">
              <div>
                <div className="np-struct-card-h2">Actual Development Factors</div>
                <div className="np-struct-card-hint">Derived from the triangle ({AVG_METHODS.find(([k]) => k === avgMethod)?.[1].toLowerCase()} average{excluded.size ? `, ${excluded.size} ratio${excluded.size === 1 ? '' : 's'} excluded` : ''}).</div>
              </div>
            </div>
            <FactorTable pattern={calcs.pattern} cdfs={calcs.cdfs} />
          </section>

          <section className="np-struct-card">
            <div className="np-struct-card-header">
              <div>
                <div className="np-struct-card-h2">Parametrized Development Factors</div>
                <div className="np-struct-card-hint">Exponential fit to the cumulative development — smooths a noisy pattern.</div>
              </div>
            </div>
            <FactorTable pattern={calcs.paramLdfs} cdfs={calcs.paramCdfs} accent="param" />
          </section>

          {projMethod === 'BF' && bfResults && (
            <section className="np-struct-card">
              <div className="np-struct-card-header">
                <div>
                  <div className="np-struct-card-h2">Bornhuetter-Ferguson Projections</div>
                  <div className="np-struct-card-hint">Latest + (premium × IELR × % unreported). Premium is the triangle's latest diagonal.</div>
                </div>
              </div>
              <div className="np-table-wrap">
                <table className="mod-table mod-table--compact">
                  <thead><tr><th>YEAR</th><th className="mod-num">LATEST</th><th className="mod-num">CDF</th><th className="mod-num">PREMIUM</th><th className="mod-num">A PRIORI ULT</th><th className="mod-num">% UNREPORTED</th><th className="mod-num">EXPECTED IBNR</th><th className="mod-num">BF ULTIMATE</th><th className="mod-num">BF LR</th></tr></thead>
                  <tbody>
                    {bfResults.map((r) => (
                      <tr key={r.year}>
                        <td>{r.year}</td>
                        <td className="mod-num">{fmtC(Math.round(r.latest))}</td>
                        <td className="mod-num">{fmt4(r.cdf)}</td>
                        <td className="mod-num">{fmtC(Math.round(r.premium))}</td>
                        <td className="mod-num">{fmtC(Math.round(r.aPrioriUltimate))}</td>
                        <td className="mod-num">{fPct(r.percentUnreported)}</td>
                        <td className="mod-num">{fmtC(Math.round(r.expectedIbnr))}</td>
                        <td className="mod-num"><b>{fmtC(Math.round(r.ultimate))}</b></td>
                        <td className="mod-num">{fPct(r.lossRatio)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {projMethod === 'BF' && bfPremiumResults && (
            <section className="np-struct-card">
              <div className="np-struct-card-header">
                <div>
                  <div className="np-struct-card-h2">Premium BF — EPI per Year</div>
                  <div className="np-struct-card-hint">Enter the EPI advised at the start of each year; unearned premium = EPI × % achieved × % unachieved.</div>
                </div>
              </div>
              <div className="np-table-wrap">
                <table className="mod-table mod-table--compact">
                  <thead><tr><th>YEAR</th><th className="mod-num">EPI</th><th className="mod-num">LATEST</th><th className="mod-num">CDF</th><th className="mod-num">BF UNEARNED</th><th className="mod-num">BF ULTIMATE</th><th className="mod-num">ACHIEVED RATIO</th></tr></thead>
                  <tbody>
                    {bfPremiumResults.map((r, i) => (
                      <tr key={r.year}>
                        <td>{r.year}</td>
                        <td>
                          <input className="mod-cell mod-cell--right" style={{ minWidth: 110 }} value={epiPerYear[i] ?? ''}
                            disabled={!meta.canEdit} placeholder="0"
                            onChange={(e) => {
                              const v = e.target.value;
                              setEpiPerYear((prev) => { const a = [...prev]; a[i] = v; return a; });
                              setDirty(true);
                            }} />
                        </td>
                        <td className="mod-num">{fmtC(Math.round(r.latest))}</td>
                        <td className="mod-num">{fmt4(r.cdf)}</td>
                        <td className="mod-num">{fmtC(Math.round(r.bfUnearned))}</td>
                        <td className="mod-num"><b>{fmtC(Math.round(r.ultimate))}</b></td>
                        <td className="mod-num">{fPct(r.achievedRatio)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="np-struct-card df-chosen">
            <div className="np-struct-card-header">
              <div>
                <div className="np-struct-card-h2">Underwriter Chosen Factors</div>
                <div className="np-struct-card-hint">The factors the projections downstream actually use. Load a base, then override any cell.</div>
              </div>
              <Toggle value={chosenBase} disabled={!meta.canEdit}
                options={[['ACTUAL', 'ACTUAL'], ['PARAM', 'PARAM'], ['LINK_RATIO', 'LINK RATIOS']]}
                onChange={switchBase} />
            </div>
            <FactorTable pattern={chosenLdfs} cdfs={chosenCdfs} editable={meta.canEdit} onChange={handleChosenChange} accent="chosen" />
          </section>

          <section className="np-struct-card">
            <div className="np-struct-card-header">
              <div>
                <div className="np-struct-card-h2">Chain Ladder Projections</div>
                <div className="np-struct-card-hint">Each year's latest diagonal × its CDF (actual pattern, tail 1.0).</div>
              </div>
            </div>
            <div className="np-table-wrap">
              <table className="mod-table mod-table--compact">
                <thead><tr><th>YEAR</th><th className="mod-num">LATEST</th><th className="mod-num">CDF</th><th className="mod-num">ULTIMATE</th><th className="mod-num">IBNR</th></tr></thead>
                <tbody>
                  {calcs.clProjections.map((p) => (
                    <tr key={p.year}>
                      <td>{p.year}</td>
                      <td className="mod-num">{fmtC(Math.round(p.latest))}</td>
                      <td className="mod-num">{fmt4(p.cdf)}</td>
                      <td className="mod-num"><b>{fmtC(Math.round(p.ultimate))}</b></td>
                      <td className="mod-num" style={p.ibnr > 0 ? { color: 'var(--accent-rose)' } : undefined}>{fmtC(Math.round(p.ibnr))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {view === 'LINK_RATIOS' && hasData && (
        <section className="np-struct-card">
          <div className="np-struct-card-header">
            <div>
              <div className="np-struct-card-h2">Link Ratios</div>
              <div className="np-struct-card-hint">Age-to-age factors per origin year. Click a ratio to exclude an outlier from the averages; the filtered pattern can be adopted as the chosen set.</div>
            </div>
            {meta.canEdit && (
              <button type="button" className="np-green-pill" onClick={applyLinkRatioPattern}>
                Use filtered pattern as chosen
              </button>
            )}
          </div>
          <div className="np-table-wrap">
            <table className="mod-table mod-table--compact">
              <thead>
                <tr>
                  <th>YEAR</th>
                  {Array.from({ length: Math.max(0, numDevYears - 1) }, (_, i) => <th key={i} className="mod-num">{i + 1}–{i + 2}</th>)}
                </tr>
              </thead>
              <tbody>
                {years.map((yr, r) => (
                  <tr key={yr}>
                    <td>{yr}</td>
                    {Array.from({ length: Math.max(0, numDevYears - 1) }, (_, c) => {
                      const f = calcs.factors[r]?.[c];
                      if (f == null) return <td key={c} className="mod-num muted">—</td>;
                      const off = excluded.has(`${r}:${c}`);
                      return (
                        <td key={c} className="mod-num">
                          <button type="button" disabled={!meta.canEdit}
                            className={`df-ratio${off ? ' df-ratio--off' : ''}`}
                            title={off ? 'Excluded — click to include' : 'Click to exclude from the averages'}
                            onClick={() => toggleExcluded(r, c)}>
                            {f.toFixed(4)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
                <tr className="mod-total-row">
                  <td><b>{AVG_METHODS.find(([k]) => k === avgMethod)?.[1]}</b></td>
                  {calcs.pattern.map((v, i) => <td key={i} className="mod-num"><b>{fmt4(v)}</b></td>)}
                </tr>
              </tbody>
            </table>
          </div>
          {excluded.size > 0 && (
            <div className="muted" style={{ marginTop: 6, fontSize: '.8rem' }}>{excluded.size} ratio{excluded.size === 1 ? '' : 's'} excluded.</div>
          )}
        </section>
      )}

      {hasData && (
        <KpiRow>
          <Kpi label="Latest Total" value={fmtC(Math.round(calcs.clProjections.reduce((a, p) => a + p.latest, 0)))} />
          <Kpi label="Ultimate Total" value={fmtC(Math.round(calcs.clProjections.reduce((a, p) => a + p.ultimate, 0)))} tone="green" />
          <Kpi label="IBNR Total" value={fmtC(Math.round(calcs.clProjections.reduce((a, p) => a + p.ibnr, 0)))} tone="red" />
          <Kpi label="Chosen Source" value={chosenBase === 'LINK_RATIO' ? 'LINK RATIOS' : chosenBase} />
        </KpiRow>
      )}
    </ModScreen>
  );
}
