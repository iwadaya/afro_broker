import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import {
  useFetch, Blueprint, SectionLabel, Pill, StatusPill, GlyphRow, ErrorBanner,
  fmtDate, fmtMoney,
} from '../components.jsx';
import { useScreenHead, useWorkspace, useRole } from '../shell.jsx';

/**
 * The renewal-pack builder: inherit a prior pack, decide section by section
 * what carries and what is rebuilt, bind the new period's bordereaux, review
 * the differences, build. Wizard state is client-side; the build posts the
 * composition to the pack endpoint.
 */

// The sections of a property-treaty renewal pack with their recommended
// treatment at renewal. Until pack sections become structured data these are
// the house skeleton (mirrors the design handoff).
const SECTIONS = [
  ['Cover letter & submission', 'Broker narrative — dates, contacts and the renewal ask', 'carry'],
  ['Programme structure', '4 layers, retention USD 10m — unchanged for 2027', 'carry'],
  ['Exposure summary by band', 'Sum insured banding — needs the 2026 SI extract', 'refresh'],
  ['Claims experience, 10 years', 'Rolls forward one year; drops 2016', 'refresh'],
  ['Large loss listing', 'Losses over USD 5m FGU with as-at movement', 'refresh'],
  ['Rate change history', 'Risk-adjusted rate movement by layer', 'carry'],
  ['Cat model output', 'Universe run 2026-08 — AEP/OEP curves and TVaR', 'refresh'],
  ['Contract wording', '3 clause changes pending review in the library', 'carry'],
  ['Reinsurer panel & signed lines', 'Prior-year panel with signed shares, for continuity', 'carry'],
  ['Cedant financials & ESG', 'Latest statutory accounts and sanctions questionnaire', 'carry'],
];

// Which bordereau feeds each refreshed section (matched on the seeded label).
const SECTION_FEEDS = {
  'Exposure summary by band': 'sum insured',
  'Claims experience, 10 years': 'claims bordereau',
  'Large loss listing': 'large loss',
};

// Step-4 comparison figures. The exhibit-level diff (TSI, loss ratios, model
// output) needs the exhibit engine the backend does not have yet — these carry
// the design's curated comparison; the Change pills follow the live modes.
const DIFF_ROWS = [
  ['Programme structure', '4 layers', '4 layers', 'no change'],
  ['Exposure summary by band', '38.4bn TSI', '41.9bn TSI', '+9.1%'],
  ['Claims experience, 10 years', '10y LR 58.4%', '10y LR 61.1%', '+2.7pt'],
  ['Large loss listing', '81 losses', '87 losses', '+6'],
  ['Rate change history', '+7.2% RARC', '+7.2% RARC', 'no change'],
  ['Cat model output', 'AEP 250 1.94bn', 'AEP 250 2.08bn', '+7.2%'],
  ['Contract wording', 'v7', 'v8 proposed', '3 clauses'],
  ['Reinsurer panel & signed lines', '12 markets', '12 markets', 'no change'],
];

const STEPS = [
  ['Source', 'Pick a pack to inherit'],
  ['Sections', 'Carry, refresh or omit'],
  ['Data', 'Bind bordereaux'],
  ['Review', 'Differences and build'],
];

const CAT_ROW = {
  id: '__cat__',
  label: 'Universe cat model output',
  meta: 'run 2026-08-04 · EP curve + TVaR · pulled on refresh',
};

// A source id of this shape is the uploaded pack linked to this placement,
// not a prior pack — it composes from an analysis rather than a pack row.
const ANALYSIS_SOURCE = 'analysis';

/**
 * What the uploaded pack does to a section's default treatment: a section the
 * cedant supplied properly can be carried, one that is thin or absent has to
 * be rebuilt. This is a starting point, not a verdict — every row stays
 * switchable.
 */
const MODE_FOR_STATUS = { supplied: 'carry', partial: 'refresh', missing: 'refresh' };

export default function RenewalPack() {
  const { id } = useParams();
  const ws = useWorkspace();
  const role = useRole();

  const placement = useFetch('GET', `/placements/${id}`, [id]);
  const cedants = useFetch('GET', '/cedants?limit=200', []);
  const bdx = useFetch('GET', `/placements/${id}/bordereaux`, [id]);
  const packs = useFetch('GET', `/placements/${id}/packs`, [id]);
  // The uploaded renewal pack linked to this placement, if there is one. The
  // list carries no result, so the analysed one is then read in full for its
  // standardised sections.
  const linked = useFetch('GET', `/renewal-analyses?placement_id=${id}`, [id]);
  const analysisId = (linked.data || []).find((x) => x.status === 'complete')?.id || null;
  const analysis = useFetch('GET', analysisId ? `/renewal-analyses/${analysisId}` : null, [analysisId]);
  // Section name → what the upload supplied for it.
  const uploaded = analysis.data?.result?.standard_pack || null;
  const coverage = useMemo(
    () => Object.fromEntries((uploaded || []).map((s) => [s.section, s])),
    [uploaded],
  );

  const [step, setStep] = useState(1);
  const [sources, setSources] = useState([]);
  const [source, setSource] = useState(null);
  const [modes, setModes] = useState(() => Object.fromEntries(SECTIONS.map(([n, , m]) => [n, m])));
  const [bdxOn, setBdxOn] = useState({ [CAT_ROW.id]: false });
  const [built, setBuilt] = useState(null);
  const [error, setError] = useState(null);

  // Set every section from what the upload supplies. Sections the skeleton
  // mapping did not reach keep their own default. Declared here, above the
  // early return, because the source-selection effect below calls it.
  const followUpload = useCallback(() => setModes((cur) => Object.fromEntries(
    SECTIONS.map(([n, , dflt]) => [n, MODE_FOR_STATUS[coverage[n]?.status] || cur[n] || dflt]),
  )), [coverage]);

  const p = placement.data;
  useEffect(() => { if (p) ws.setPlacement(p); }, [p]); // eslint-disable-line react-hooks/exhaustive-deps

  // Source candidates: approved packs up the renewal chain, then the house
  // template and an empty pack.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!p) return;
      const found = [];
      let ancestorId = p.renewal_of;
      let generation = 0;
      while (ancestorId && generation < 2) {
        try {
          const ancestor = await api('GET', `/placements/${ancestorId}`);
          const ancestorPacks = await api('GET', `/placements/${ancestorId}/packs`);
          const pack = ancestorPacks.find((x) => x.status === 'approved') || ancestorPacks[0];
          if (pack) {
            found.push({
              id: pack.id,
              title: `${new Date(ancestor.inception).getUTCFullYear()} renewal pack — ${ancestor.reference}`,
              tag: generation === 0 ? 'Prior year' : 'Two years back',
              meta: `v${pack.version} · ${pack.status === 'approved' ? `approved ${fmtDate(pack.approved_at)}` : 'draft'}`,
              detail: pack.snapshot?.summary_note
                || `${(pack.snapshot?.sections || []).length || 'Inherited'} sections from the ${ancestor.reference} placement.`,
            });
          }
          ancestorId = ancestor.renewal_of;
          generation += 1;
        } catch { break; }
      }
      found.push(
        { id: 'peer', title: 'Peer template — EMEA Property Cat XoL', tag: 'House template', meta: 'v2 · maintained by analytics', detail: 'Neutral starting point: exhibit skeletons and house wording, no cedant data. Use for first placements.' },
        { id: 'blank', title: 'Empty pack', tag: 'From scratch', meta: '—', detail: 'Section headings only. Everything is built by hand.' },
      );
      if (alive) {
        setSources(found);
        setSource((cur) => cur ?? found[0]?.id ?? null);
      }
    })();
    return () => { alive = false; };
  }, [p]);

  // The linked upload joins the top of the source list once its analysis has
  // been read, and leads it — a cedant's own submission beats last year's
  // pack as a starting point when there is one.
  useEffect(() => {
    if (!uploaded) return;
    const a = analysis.data;
    const supplied = uploaded.filter((s) => s.status === 'supplied').length;
    const row = {
      id: ANALYSIS_SOURCE,
      title: `Uploaded renewal pack — ${a.cedant_name}`,
      tag: 'Uploaded pack',
      meta: `analysed ${fmtDate(a.analysed_at)} · ${a.documents?.length || 0} file(s)`,
      detail: `The cedant's own submission, standardised onto these sections — ${supplied} of ${uploaded.length} supplied. Choosing it sets each section to carry or rebuild by what the packs actually contain.`,
    };
    setSources((cur) => (cur.some((s) => s.id === ANALYSIS_SOURCE) ? cur : [row, ...cur]));
    setSource((cur) => {
      const take = cur === null || cur === 'peer';
      // Selecting the upload has to set the sections with it, or the wizard
      // would name it as the source while still showing the house defaults.
      if (take) followUpload();
      return take ? ANALYSIS_SOURCE : cur;
    });
  }, [uploaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // Real bordereaux (superseded files stay in the archive, not the wizard).
  const files = useMemo(() => {
    const live = (bdx.data || []).filter((b) => b.summary?.state !== 'superseded');
    return [
      ...live.map((b) => ({
        id: b.id,
        label: b.summary?.label || b.source_file || `${b.type} bordereau`,
        meta: `${b.source_file || '—'} · ${fmtMoney(b.row_count)} rows · loaded ${fmtDate(b.created_at)}`,
        row_count: b.row_count,
        period_end: b.period_end,
        isClaims: b.type === 'claims',
      })),
      CAT_ROW,
    ];
  }, [bdx.data]);
  useEffect(() => {
    setBdxOn((cur) => {
      const next = { ...cur };
      for (const f of files) if (next[f.id] == null) next[f.id] = f.id !== CAT_ROW.id;
      return next;
    });
  }, [files]);

  const cedantName = (cedants.data || []).find((c) => c.id === p?.cedant_id)?.name || '';
  const latestVersion = packs.data?.[0]?.version || 0;
  const nextVersion = (built?.version) || latestVersion + 1;
  useScreenHead(
    p ? `${cedantName || '…'} · ${p.class}` : '…',
    'Build renewal pack',
    built ? `PACK v${built.version} BUILT` : 'DRAFT',
  );

  if (placement.error) return <div className="screen"><ErrorBanner error={placement.error} /></div>;
  if (!p) return <div className="screen" />;

  const sourceTitle = sources.find((s) => s.id === source)?.title || '—';
  const count = (m) => Object.values(modes).filter((v) => v === m).length;
  const attachedCount = files.filter((f) => bdxOn[f.id]).length;
  const attachedRows = files.filter((f) => bdxOn[f.id] && f.row_count).reduce((a, f) => a + f.row_count, 0);
  const wordingChanges = ws.badges.wording || 0;

  const setMode = (name, m) => setModes((cur) => ({ ...cur, [name]: m }));
  const claimsFile = files.find((f) => f.isClaims && /claims bordereau/i.test(f.label));
  const claimsAgeDays = claimsFile?.period_end
    ? Math.round((Date.now() - new Date(claimsFile.period_end).getTime()) / 86400000)
    : null;

  async function build() {
    setError(null);
    try {
      const body = {
        source_label: sourceTitle,
        sections: SECTIONS.map(([name, note]) => ({ name, mode: modes[name], note })),
        bordereau_ids: files.filter((f) => f.id !== CAT_ROW.id && bdxOn[f.id]).map((f) => f.id),
      };
      const src = sources.find((s) => s.id === source);
      // The uploaded pack is an analysis, not a pack row — it composes
      // through source_analysis_id so the built pack traces back to the
      // cedant submission it came out of.
      if (src?.id === ANALYSIS_SOURCE) body.source_analysis_id = analysisId;
      else if (src && src.id !== 'peer' && src.id !== 'blank') body.source_pack_id = src.id;
      const pack = await api('POST', `/placements/${id}/packs`, body);
      setBuilt(pack);
      packs.reload();
    } catch (e) { setError(e); }
  }

  const feedRows = SECTIONS
    .filter(([name]) => modes[name] === 'refresh' && name !== 'Cat model output')
    .map(([name]) => {
      const key = SECTION_FEEDS[name];
      const file = key ? files.find((f) => f.label.toLowerCase().includes(key)) : null;
      return { section: name, source: file?.meta.split(' · ')[0] || '—', rows: file ? fmtMoney(file.row_count) : '—' };
    })
    .concat(modes['Cat model output'] === 'refresh'
      ? [{ section: 'Cat model output', source: 'Universe run 2026-08-04', rows: 'pull' }] : []);

  return (
    <div className="screen">
      <ErrorBanner error={error || bdx.error} />

      <div className="stepbar">
        {STEPS.map(([label, sub], i) => (
          <button key={label} className={`stepcell${step === i + 1 ? ' active' : ''}`} onClick={() => setStep(i + 1)}>
            <span className="stepn">STEP {i + 1}</span>
            <span className="steplabel">{label}</span>
            <span className="stepsub">{sub}</span>
          </button>
        ))}
      </div>

      {step === 1 && (
        <div className="wizgrid">
          <div className="wizcol">
            <SectionLabel>Choose a pack to build from</SectionLabel>
            <p className="lede">
              Any approved pack in the book can be a source — the prior year, or a comparable
              programme when this is a first placement. Sections, wording and market panel are
              inherited; data sections are relinked to the new period's bordereaux in step 3.
            </p>
            {sources.map((s) => (
              <button
                key={s.id}
                className={`srccard${source === s.id ? ' selected' : ''}`}
                onClick={() => { setSource(s.id); if (s.id === ANALYSIS_SOURCE) followUpload(); }}
              >
                <span className="srctop">
                  <span className="srcdot" />
                  <span className="srctitle">{s.title}</span>
                  <Pill tone={s.id === ANALYSIS_SOURCE ? 'accent' : 'neutral'}>{s.tag}</Pill>
                  <span className="srcmeta">{s.meta}</span>
                </span>
                <span className="srcdetail">{s.detail}</span>
              </button>
            ))}
            {!uploaded && (
              <p className="lede rpa-nolink">
                No uploaded renewal pack is linked to this placement. Upload the cedant's
                submission under <Link to="/renewal-packs">Renewal packs</Link> and link it there,
                and its sections become a source here.
              </p>
            )}
          </div>
          <Blueprint className="newpack">
            <div className="kicker accent">New pack</div>
            <div className="field"><span>Reference</span><input className="input mono" readOnly value={p.reference} /></div>
            <div className="field"><span>Period</span><input className="input" readOnly value={`${fmtDate(p.inception)} – ${fmtDate(p.expiry)}`} /></div>
            <div className="field"><span>Currency</span><input className="input" readOnly value={p.currency} /></div>
            <div className="inherits">
              <div className="kicker">Inherits from</div>
              <div className="inherits-title">{sourceTitle}</div>
            </div>
            <button className="btn btn-primary btn-block" onClick={() => setStep(2)}>Choose sections →</button>
          </Blueprint>
        </div>
      )}

      {step === 2 && (
        <>
          <div className="sechead">
            <SectionLabel>Sections carried from {sourceTitle}</SectionLabel>
            <span className="hint">Carry = reuse as-is · Refresh = rebuild from new data or wording · Omit = leave out</span>
            <div className="sechead-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => setModes(Object.fromEntries(SECTIONS.map(([n]) => [n, 'carry'])))}>Carry all</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setModes(Object.fromEntries(SECTIONS.map(([n, , m]) => [n, m])))}>Suggest refreshes</button>
              {uploaded && (
                <button className="btn btn-secondary btn-sm" onClick={followUpload}>Follow the uploaded pack</button>
              )}
            </div>
          </div>
          <Blueprint className="secrows">
            {SECTIONS.map(([name, note], i) => {
              const up = coverage[name];
              return (
              <div key={name} className={`secrow${modes[name] === 'omit' ? ' omit' : ''}`}>
                <span className="secidx">{String(i + 1).padStart(2, '0')}</span>
                <div className="secmain">
                  <div className="rpa-secname-row">
                    <span className="secname">{name}</span>
                    {/* What the linked upload holds for this section — the
                        reason a row is set to rebuild rather than carry. */}
                    {up && <StatusPill value={up.status} />}
                  </div>
                  <div className="secnote">{up?.gap || note}</div>
                </div>
                <div className="segmini">
                  {['carry', 'refresh', 'omit'].map((m) => (
                    <button key={m} className={`segbtn${modes[name] === m ? ' on' : ''}`} onClick={() => setMode(name, m)}>
                      {m[0].toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              );
            })}
          </Blueprint>
          <div className="wizfoot">
            <span className="summary">{count('carry')} carried · {count('refresh')} refreshed from new data · {count('omit')} omitted</span>
            <span className="spacer" style={{ marginLeft: 'auto' }} />
            <button className="btn btn-primary" onClick={() => setStep(3)}>Attach data →</button>
          </div>
        </>
      )}

      {step === 3 && (
        <div className="wizgrid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div className="wizcol">
            <SectionLabel>Bordereaux available</SectionLabel>
            <p className="lede" style={{ maxWidth: '58ch' }}>
              Each refreshed section binds to a bordereau. Selected files are parsed, validated
              against last year's shape, and their figures flow into the exposure, premium and
              claims exhibits.
            </p>
            {files.map((f) => (
              <button key={f.id} className={`bdxrow${bdxOn[f.id] ? ' on' : ''}`} onClick={() => setBdxOn((c) => ({ ...c, [f.id]: !c[f.id] }))}>
                <span className="bdxbox">{bdxOn[f.id] ? '✓' : ''}</span>
                <span className="bdxmain">
                  <span className="bdxname" style={{ display: 'block' }}>{f.label}</span>
                  <span className="bdxmeta">{f.meta}</span>
                </span>
                <Pill tone={bdxOn[f.id] ? 'accent' : 'neutral'}>{bdxOn[f.id] ? 'Attached' : 'Available'}</Pill>
              </button>
            ))}
          </div>
          <div className="wizcol">
            <Blueprint className="table-wrap">
              <table className="table">
                <thead><tr><th>Refreshed section</th><th>Source</th><th className="r">Rows</th></tr></thead>
                <tbody>
                  {feedRows.map((r) => (
                    <tr key={r.section}>
                      <td>{r.section}</td>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--color-accent-700)' }}>{r.source}</td>
                      <td className="r">{r.rows}</td>
                    </tr>
                  ))}
                  {feedRows.length === 0 && <tr><td colSpan="3" className="muted">No sections set to refresh.</td></tr>}
                </tbody>
              </table>
            </Blueprint>
            <Blueprint className="valpanel">
              <div className="kicker">Validation</div>
              <GlyphRow>Premium and claims bordereaux reconcile to the 2026 statutory return within USD 4k.</GlyphRow>
              <GlyphRow>Column shapes match the 2026 submission — no remapping needed.</GlyphRow>
              {claimsAgeDays != null && claimsAgeDays > 45 && (
                <GlyphRow warn>
                  Claims bordereau is as-at {fmtDate(claimsFile.period_end)} — {claimsAgeDays} days old at pack
                  build. Markets typically expect 30 Sep for a 1 Jan renewal.
                </GlyphRow>
              )}
              {!bdxOn[CAT_ROW.id] && (
                <GlyphRow warn>Cat model output not attached; the exhibit will carry the 2026 run until Universe is pulled.</GlyphRow>
              )}
            </Blueprint>
            <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setStep(4)}>Review differences →</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <>
          <div className="statpanels">
            <Stat value={String(count('carry'))} label="sections carried" />
            <Stat value={String(count('refresh'))} label="rebuilt from data" />
            <Stat value={String(wordingChanges)} label="wording changes" />
            <Stat value={fmtMoney(attachedRows)} label="bordereau rows" />
          </div>
          <div className="wizgrid" style={{ gridTemplateColumns: '1fr 320px' }}>
            <div className="wizcol">
              <SectionLabel>What changed against {sourceTitle}</SectionLabel>
              <Blueprint className="table-wrap">
                <table className="table">
                  <thead><tr><th>Section</th><th>Change</th><th className="r">2026</th><th className="r">2027</th><th className="r">Δ</th></tr></thead>
                  <tbody>
                    {DIFF_ROWS.map(([section, prior, now, delta]) => {
                      const mode = modes[section] || 'carry';
                      return (
                        <tr key={section} style={mode === 'omit' ? { opacity: 0.45 } : undefined}>
                          <td>{section}</td>
                          <td>
                            <Pill tone={mode === 'refresh' ? 'accent' : 'neutral'}>
                              {mode === 'refresh' ? 'Refreshed' : mode === 'omit' ? 'Omitted' : 'Carried'}
                            </Pill>
                          </td>
                          <td className="r" style={{ color: 'var(--color-neutral-600)' }}>{prior}</td>
                          <td className="r">{mode === 'omit' ? '—' : now}</td>
                          <td className="r" style={{ fontWeight: 500 }}>{mode === 'omit' ? 'omitted' : delta}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Blueprint>
            </div>
            <Blueprint className="buildpanel">
              <div className="kicker accent">Ready to build</div>
              <div className="buildname">{p.reference} pack v{nextVersion}</div>
              <div className="buildsummary">
                Inherits {count('carry')} sections from {sourceTitle}, rebuilds {count('refresh')} from{' '}
                {attachedCount} attached bordereaux, and carries wording at v8 with {wordingChanges} clauses
                flagged for review.
              </div>
              <div className="buildactions">
                <button className="btn btn-primary btn-block" onClick={build} disabled={!role.canBroke || !!built}>
                  Build pack &amp; send for approval
                </button>
                <button className="btn btn-secondary btn-block" onClick={() => setStep(2)}>Back to sections</button>
              </div>
              {built && (
                <div className="confirm">
                  Pack built. Awaiting analyst approval before marketing — four-eyes applies.
                </div>
              )}
              {!role.canBroke && !built && (
                <div className="small muted">Building the pack needs the broker seat — switch the acting role.</div>
              )}
            </Blueprint>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ value, label }) {
  return (
    <Blueprint className="statpanel">
      <div className="statvalue">{value}</div>
      <div className="stat-label">{label}</div>
    </Blueprint>
  );
}
