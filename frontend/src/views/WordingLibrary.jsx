import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import {
  useFetch, Blueprint, Pill, StatusPill, GlyphRow, ErrorBanner, fmtDate, providerLabel,
} from '../components.jsx';
import { useScreenHead, useWorkspace, useRole } from '../shell.jsx';

/**
 * Contract wording, in three tabs:
 *
 *   Wording     every wording in the market, filtered by reinsurer, class and
 *               treaty type. Open one to read it in full beside the versions
 *               the reinsurers hold of it.
 *   Comparison  read a market's slip and measure it against our own form —
 *               or read two and compare them with each other as well.
 *   Draft slip  the wording being assembled for the working layer.
 */
const TABS = [
  ['wording', 'Wording'],
  ['comparison', 'Comparison'],
  ['draft', 'Draft slip'],
];

export default function WordingLibrary() {
  useScreenHead('Contract wording', 'Wording library');
  const [tab, setTab] = useState('wording');
  const [error, setError] = useState(null);

  return (
    <div className="screen">
      <ErrorBanner error={error} />
      <div className="wtabs" style={{ alignSelf: 'flex-start' }}>
        {TABS.map(([key, label]) => (
          <button key={key} className={`wtab${tab === key ? ' on' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'wording' && <WordingTab onError={setError} />}
      {tab === 'comparison' && <ComparisonTab onError={setError} />}
      {tab === 'draft' && <DraftSlipTab onError={setError} />}
    </div>
  );
}

/* ────────────────────────────────────────────────────────── Wording tab ── */

function WordingTab({ onError }) {
  const role = useRole();
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ market_id: '', cob: '', treaty_type: '' });
  // The library is read one set at a time: the standard clause body
  // (coverages, conditions, definitions, exclusions) or the extensions laid
  // over it. Either set can still be filtered down to one reinsurer.
  const [scope, setScope] = useState('standard');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  const meta = useFetch('GET', '/wordings/meta', []);

  // The reinsurer filter asks a different question of the library: "what does
  // this market's wording look like", which is its own clauses laid over the
  // standard set — not merely the rows it happens to own.
  const query = useMemo(() => {
    const q = new URLSearchParams({ limit: '400' });
    if (filters.cob) q.set('cob', filters.cob);
    if (filters.treaty_type) q.set('treaty_type', filters.treaty_type);
    if (filters.market_id) q.set('market_id', filters.market_id);
    if (filters.market_id) q.set('source', 'market');
    return q.toString();
  }, [filters]);
  const clauses = useFetch('GET', `/wordings/clauses?${query}`, [query]);

  const isExtension = (c) => c.category === 'extension';
  const counts = useMemo(() => {
    const list = clauses.data || [];
    const ext = list.filter(isExtension).length;
    return { standard: list.length - ext, extensions: ext };
  }, [clauses.data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = (clauses.data || []).filter((c) => (scope === 'extensions' ? isExtension(c) : !isExtension(c)));
    if (!q) return list;
    return list.filter((c) => `${c.clause_ref || ''} ${c.title} ${c.category} ${c.cob || ''} ${c.summary || ''}`
      .toLowerCase().includes(q));
  }, [clauses.data, scope, search]);

  useEffect(() => {
    if (rows.length && !rows.some((c) => c.id === selected)) setSelected(rows[0].id);
    if (!rows.length) setSelected(null);
  }, [rows, selected]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const m = meta.data;

  return (
    <div className="wording-tab">
      {/* Filters run the full width, above both the list and the wording. */}
      <Blueprint className="wl-filters">
        <label className="field">
          <span>Show</span>
          <div className="wtabs">
            <button
              type="button"
              className={`wtab${scope === 'standard' ? ' on' : ''}`}
              onClick={() => setScope('standard')}
            >
              Standard clauses ({counts.standard})
            </button>
            <button
              type="button"
              className={`wtab${scope === 'extensions' ? ' on' : ''}`}
              onClick={() => setScope('extensions')}
            >
              Extensions ({counts.extensions})
            </button>
          </div>
        </label>
        <label className="field">
          <span>Reinsurer</span>
          <select className="input" value={filters.market_id} onChange={set('market_id')}>
            <option value="">All reinsurers</option>
            {(m?.markets || []).filter((x) => x.clause_count > 0).map((x) => (
              <option key={x.id} value={x.id}>{x.name} ({x.clause_count})</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Class of business</span>
          <select className="input" value={filters.cob} onChange={set('cob')}>
            <option value="">All classes</option>
            {(m?.cobs || []).filter((c) => c.cob).map((c) => (
              <option key={c.cob} value={c.cob}>{c.cob} ({c.count})</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Treaty type</span>
          <select className="input" value={filters.treaty_type} onChange={set('treaty_type')}>
            <option value="">All treaty types</option>
            {(m?.treaty_types || []).map((t) => (
              <option key={t.treaty_type} value={t.treaty_type}>{t.treaty_type} ({t.count})</option>
            ))}
          </select>
        </label>
        <label className="field wl-search">
          <span>Search</span>
          <input
            className="input"
            placeholder="Search clauses, LMA refs, text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="wl-count">
          {clauses.loading ? 'Loading…' : `${rows.length} wording${rows.length === 1 ? '' : 's'}`}
        </div>
      </Blueprint>

      <div className="wordgrid">
        <div className="wordleft">
          <Blueprint className="clauselist">
            {rows.map((c) => (
              <button
                key={c.id}
                className={`wl-item clauserow${selected === c.id ? ' selected' : ''}`}
                onClick={() => setSelected(c.id)}
              >
                <span className="clausetop">
                  <span className="clausecode">{c.clause_ref || c.category}</span>
                  {c.market_name
                    ? <Pill tone="accent" className="status">{c.market_name}</Pill>
                    : <StatusPill value={c.status} />}
                </span>
                <span className="clausename">{c.title}</span>
                <span className="clausemeta">
                  {c.cob || 'All classes'}{c.treaty_type ? ` · ${c.treaty_type}` : ''} · v{c.version}
                </span>
              </button>
            ))}
            {!clauses.loading && rows.length === 0 && (
              <div className="small muted" style={{ padding: 14 }}>Nothing matches these filters.</div>
            )}
          </Blueprint>
          <button className="btn btn-secondary btn-block" onClick={() => navigate('/wordings')}>
            Open the drafts editor
          </button>
        </div>

        {selected
          ? <WordingDetail clauseId={selected} canBroke={role.canBroke} canAuthorise={role.canAuthorise} onError={onError} />
          : <div className="muted">Select a wording.</div>}
      </div>
    </div>
  );
}

/** The full clause text, and the reinsurer versions of it side by side. */
function WordingDetail({ clauseId, canBroke, canAuthorise, onError }) {
  const clause = useFetch('GET', `/wordings/clauses/${clauseId}`, [clauseId]);
  const variants = useFetch('GET', `/wordings/clauses/${clauseId}/variants`, [clauseId]);
  const history = useFetch('GET', `/wordings/clauses/${clauseId}/history`, [clauseId]);
  const [against, setAgainst] = useState(null);

  useEffect(() => { setAgainst(null); }, [clauseId]);

  const c = clause.data;
  if (clause.error) return <ErrorBanner error={clause.error} />;
  if (!c) return <div className="small muted">Loading…</div>;

  const list = variants.data || [];
  const compared = list.find((v) => v.id === against) || null;
  const h = history.data;

  async function act(fn) {
    onError(null);
    try { await fn(); } catch (e) { onError(e); }
  }

  return (
    <div className="worddetail">
      <div className="wordhead">
        <div>
          <div className="ver mono">
            {c.clause_ref ? `${c.clause_ref} · ` : ''}{c.category} · v{c.version}
            {c.cob ? ` · ${c.cob}` : ''}{c.treaty_type ? ` · ${c.treaty_type}` : ''}
          </div>
          <h3>{c.title}</h3>
        </div>
        <div className="sechead-actions">
          {c.market_name && <Pill tone="accent">{c.market_name} house wording</Pill>}
          <button
            className="btn btn-secondary"
            disabled={!canAuthorise || c.status === 'active'}
            onClick={() => act(async () => {
              await api('PATCH', `/wordings/clauses/${c.id}`, { status: 'active' });
              clause.reload();
            })}
          >Approve change</button>
        </div>
      </div>

      {c.provenance === 'market_standard' && c.source_note && (
        <p className="diffnote">
          {c.source_org ? `${c.source_org} — ` : ''}{c.source_note}
          {c.source_url && <> <a href={c.source_url} target="_blank" rel="noreferrer">source</a></>}
        </p>
      )}

      {/* The wording itself always sits beside the version it is compared
          against, so the reader's eye never has to move between two layouts. */}
      <div className="diffgrid">
        <Blueprint className="diffpane">
          <div className="kicker">{c.market_name ? `${c.market_name} — v${c.version}` : `House wording — v${c.version}`}</div>
          {compared
            ? <DiffProse ops={compared.ops || []} side="left" />
            : <p className="diffline">{c.body}</p>}
        </Blueprint>
        <Blueprint className="diffpane">
          {compared ? (
            <>
              <div className="kicker accent">{compared.market_name} — variation</div>
              <DiffProse ops={compared.ops || []} side="right" />
            </>
          ) : (
            <>
              <div className="kicker">Compared against</div>
              {list.length === 0 ? (
                <p className="diffline muted">
                  No reinsurer holds its own version of this wording, so there is nothing
                  to compare it against.
                </p>
              ) : (
                <>
                  <p className="diffline muted">Pick a reinsurer to read its version against ours.</p>
                  <div className="varpick">
                    {list.map((v) => (
                      <button key={v.id} className="chip" onClick={() => setAgainst(v.id)}>
                        {v.market_name}
                        <span className="chip-note">
                          {v.identical ? 'identical' : `${(v.ops || []).filter((o) => o.op !== 'same').length} edits`}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </Blueprint>
      </div>

      {h?.changed && (
        <p className="diffnote">
          Changed from v{h.prior_version}: {(h.ops || []).filter((o) => o.op !== 'same').length} edits
          against the version it supersedes.
        </p>
      )}

      <div className="sechead">
        <span className="seclabel">Variations held by the market</span>
        <span className="hint">click a reinsurer to read its version beside ours</span>
      </div>
      <Blueprint className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Reinsurer</th><th>Reference</th><th>Deviation</th><th>Updated</th><th /></tr>
          </thead>
          <tbody>
            {list.map((v) => (
              <tr key={v.id} className={against === v.id ? 'row-open' : undefined}>
                <td style={{ fontWeight: 500 }}>{v.market_name}</td>
                <td className="mono" style={{ fontSize: 12 }}>{v.clause_ref || '—'}</td>
                <td style={{ fontSize: 13 }}>
                  {v.identical
                    ? 'None — takes the house wording'
                    : `${(v.ops || []).filter((o) => o.op !== 'same').length} edits`}
                </td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{fmtDate(v.updated_at)}</td>
                <td className="r">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setAgainst(against === v.id ? null : v.id)}
                  >{against === v.id ? 'Close' : 'Compare'}</button>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan="5" className="muted">No reinsurer holds its own version of this wording.</td></tr>
            )}
          </tbody>
        </table>
      </Blueprint>
    </div>
  );
}

/**
 * A word-level diff rendered as prose. `side` picks which half to show: the
 * left drops the additions and marks the removals in red, the right does the
 * reverse in green, so the two panes read as the two versions of the clause.
 */
function DiffProse({ ops, side }) {
  const drop = side === 'left' ? 'add' : 'del';
  const mark = side === 'left' ? 'del' : 'add';
  const shown = ops.filter((o) => o.op !== drop);
  return (
    <p className="diffline">
      {shown.map((o, i) => {
        // The ops are spaced internally but not against each other; join them
        // the way the diff itself joins tokens — no space before closing
        // punctuation, none after an opening bracket.
        const prev = shown[i - 1]?.text || '';
        const space = i > 0
          && !/^[,.;:!?%)\]}»’”]/.test(o.text)
          && !/[([{«‘“]$/.test(prev);
        const body = o.op === mark
          ? <span className={`diffspan ${mark === 'add' ? 'add' : 'cut'}`}>{o.text}</span>
          : o.text;
        return <React.Fragment key={i}>{space ? ' ' : ''}{body}</React.Fragment>;
      })}
    </p>
  );
}

/* ─────────────────────────────────────────────────────── Comparison tab ── */

const FLAG_TONE = {
  standard: ['neutral', 'Standard'],
  non_standard: ['accent', 'Non-standard'],
  additional: ['outline', 'Additional'],
  missing: ['solid', 'Missing'],
};

/** One upload slot: a file, or text pasted straight in. */
function SlipSlot({ index, slip, onChange, onClear }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  async function take(file) {
    if (!file) return;
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      // btoa needs a binary string; chunk it so a big slip doesn't blow the
      // argument limit on String.fromCharCode.
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      onChange({ name: file.name, filename: file.name, content_base64: btoa(binary), text: undefined });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Blueprint className="slip-slot">
      <div className="sechead">
        <span className="kicker">{index === 0 ? 'Slip A' : 'Slip B'}</span>
        {slip && <button className="btn btn-ghost btn-sm" onClick={onClear}>Clear</button>}
      </div>

      <input
        className="input"
        placeholder={index === 0 ? 'Name this slip — e.g. Swiss Re' : 'Name this slip — e.g. Munich Re'}
        value={slip?.name || ''}
        onChange={(e) => onChange({ ...(slip || {}), name: e.target.value })}
      />

      <div className="slip-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); take(e.dataTransfer.files?.[0]); }}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.txt,.md"
          style={{ display: 'none' }}
          onChange={(e) => take(e.target.files?.[0])}
        />
        <button className="btn btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Reading…' : 'Choose a file'}
        </button>
        <span className="small muted">or drop a PDF or text file here</span>
        {slip?.filename && <div className="mono small">{slip.filename}</div>}
      </div>

      <textarea
        className="input slip-paste"
        placeholder="…or paste the slip wording"
        value={slip?.text || ''}
        onChange={(e) => onChange({ ...(slip || {}), text: e.target.value, content_base64: undefined, filename: undefined })}
      />
    </Blueprint>
  );
}

function ComparisonTab({ onError }) {
  const meta = useFetch('GET', '/wordings/meta', []);
  const [slips, setSlips] = useState([null, null]);
  const [cob, setCob] = useState('');
  const [treatyType, setTreatyType] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [flag, setFlag] = useState(null);
  const [ai, setAi] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState(null);

  const filled = slips.filter((s) => s && (s.text?.trim() || s.content_base64));
  const setSlip = (i) => (next) => setSlips((cur) => cur.map((s, j) => (j === i ? next : s)));

  const payload = () => filled.map((s) => ({
    name: s.name || s.filename || undefined,
    filename: s.filename,
    content_base64: s.content_base64,
    text: s.text?.trim() || undefined,
  }));

  async function run() {
    onError(null);
    setBusy(true);
    setResult(null);
    setAi(null);
    setAiErr(null);
    try {
      setFlag(null);
      setOpen(null);
      setResult(await api('POST', '/wordings/slips/compare', {
        slips: payload(),
        cob: cob || null,
        treaty_type: treatyType || null,
      }));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  // The AI pass re-reads the same slips server-side, so an edit between the
  // compare and the commentary still analyses what the table shows.
  async function runCommentary() {
    setAiErr(null);
    setAiBusy(true);
    try {
      setAi(await api('POST', '/wordings/slips/commentary', {
        slips: payload(),
        cob: cob || null,
        treaty_type: treatyType || null,
      }));
    } catch (e) {
      setAiErr(e.data?.error || e.message || 'The AI commentary failed');
    } finally {
      setAiBusy(false);
    }
  }

  const two = result?.mode === 'slip_vs_slip';
  const shown = (result?.rows || []).filter((r) => !flag || r.flag === flag);

  return (
    <div className="compare-tab">
      <p className="lede">
        Upload one slip to read it against the market standard wording, or two to compare them
        with each other as well. Every clause is flagged against our form — non-standard where the
        text has moved, additional where the slip adds a clause, missing where it drops one.
      </p>

      <div className="slip-slots">
        <SlipSlot index={0} slip={slips[0]} onChange={setSlip(0)} onClear={() => setSlip(0)(null)} />
        <SlipSlot index={1} slip={slips[1]} onChange={setSlip(1)} onClear={() => setSlip(1)(null)} />
      </div>

      <div className="sechead compare-run">
        <label className="field">
          <span>Class of business</span>
          <select className="input" value={cob} onChange={(e) => setCob(e.target.value)}>
            <option value="">All classes</option>
            {(meta.data?.cobs || []).filter((c) => c.cob).map((c) => (
              <option key={c.cob} value={c.cob}>{c.cob}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Treaty type</span>
          <select className="input" value={treatyType} onChange={(e) => setTreatyType(e.target.value)}>
            <option value="">All treaty types</option>
            {(meta.data?.treaty_types || []).map((t) => (
              <option key={t.treaty_type} value={t.treaty_type}>{t.treaty_type}</option>
            ))}
          </select>
        </label>
        <div className="sechead-actions">
          <button className="btn btn-primary" disabled={busy || filled.length === 0} onClick={run}>
            {busy ? 'Reading the slips…' : filled.length === 2 ? 'Compare the two slips' : 'Check against the standard'}
          </button>
        </div>
      </div>

      {!result && !busy && (
        <Blueprint className="valpanel">
          <GlyphRow warn={filled.length === 0}>
            {filled.length === 0
              ? 'Nothing to compare yet — add a slip above.'
              : `${filled.length} slip${filled.length === 1 ? '' : 's'} ready.`}
          </GlyphRow>
          <GlyphRow>PDF and text files are read directly; a Word slip should be saved as PDF or pasted.</GlyphRow>
        </Blueprint>
      )}

      {result && (
        <>
          {/* The tiles double as a filter — a full standard set runs to dozens
              of clauses, and the divergences are what get read. */}
          <div className="statpanels compare-stats">
            <Stat value={String(result.summary.total)} label="clauses compared"
              on={flag === null} onClick={() => setFlag(null)} />
            <Stat value={String(result.summary.non_standard)} label="non-standard"
              on={flag === 'non_standard'} onClick={() => setFlag(flag === 'non_standard' ? null : 'non_standard')} />
            <Stat value={String(result.summary.additional)} label="additional"
              on={flag === 'additional'} onClick={() => setFlag(flag === 'additional' ? null : 'additional')} />
            <Stat value={String(result.summary.missing)} label="missing"
              on={flag === 'missing'} onClick={() => setFlag(flag === 'missing' ? null : 'missing')} />
          </div>

          <div className="sechead">
            <span className="seclabel">
              {two
                ? `${result.slips[0].name} vs ${result.slips[1].name}`
                : `${result.slips[0].name} against ${result.standard.label}`}
            </span>
            <span className="hint">
              {result.standard.clause_count} clauses in the standard set ·
              {' '}{result.slips.map((s) => `${s.name} ${s.clause_count}`).join(' · ')}
              {' '}· click a row to read the text
            </span>
          </div>

          <Blueprint className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Clause</th><th>Ref</th>
                  {two
                    ? <>
                      <th className="c" title={result.slips[0].name}><span className="slipname">{result.slips[0].name}</span></th>
                      <th className="c" title={result.slips[1].name}><span className="slipname">{result.slips[1].name}</span></th>
                      <th>Slips agree</th>
                    </>
                    : <th className="c">In the slip</th>}
                  <th>Against standard</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const [tone, label] = FLAG_TONE[r.flag] || ['neutral', r.flag];
                  const isOpen = open === i;
                  return (
                    <React.Fragment key={`${r.title}-${i}`}>
                      <tr onClick={() => setOpen(isOpen ? null : i)} style={{ cursor: 'pointer' }}>
                        <td style={{ fontWeight: 500 }}>{r.title}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{r.clause_ref || '—'}</td>
                        {r.slips.map((s, j) => (
                          <td className="c" key={j}>{s.present ? '✓' : '—'}</td>
                        ))}
                        {two && (
                          <td>
                            {r.slip_match === 'same' && <span className="muted small">identical</span>}
                            {r.slip_match === 'differs' && <Pill tone="accent">differs</Pill>}
                            {r.slip_match === 'one_only' && <span className="muted small">one slip only</span>}
                            {r.slip_match === 'neither' && <span className="muted small">neither</span>}
                          </td>
                        )}
                        <td><Pill tone={tone}>{label}</Pill></td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={two ? 6 : 4} className="slip-detail">
                            <SlipRowDetail row={r} names={result.slips.map((s) => s.name)} two={two} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {shown.length === 0 && (
                  <tr><td colSpan="6" className="muted">
                    {flag ? 'No clauses carry that flag.' : 'Nothing to compare.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </Blueprint>

          {/* The AI reading: which movements matter, plus the commercial terms
              (limits, reinstatements…) the clause table cannot see. */}
          <div className="sechead">
            <span className="seclabel">AI commentary</span>
            <div className="sechead-actions">
              <button className="btn btn-secondary" disabled={aiBusy} onClick={runCommentary}>
                {aiBusy ? 'Reading the slips…' : ai ? 'Re-run AI commentary' : 'AI commentary'}
              </button>
            </div>
          </div>
          {aiErr && <div className="err banner">{aiErr}</div>}
          {!ai && !aiBusy && !aiErr && (
            <Blueprint className="valpanel">
              <GlyphRow>
                The AI reads the full slip text — schedule included — and checks the commercial terms
                (limits, attachments, reinstatements, aggregates, premium, brokerage) alongside the
                wording movements above.
              </GlyphRow>
            </Blueprint>
          )}
          {aiBusy && (
            <Blueprint className="valpanel">
              <GlyphRow>Reading the slips with AI — this can take a minute…</GlyphRow>
            </Blueprint>
          )}
          {ai && <SlipCommentary data={ai} two={two} names={result.slips.map((s) => s.name)} />}
        </>
      )}
    </div>
  );
}

const TERM_TONE = {
  stated: ['neutral', 'Stated'],
  differs: ['accent', 'Differs'],
  missing: ['solid', 'Missing'],
  unclear: ['outline', 'Unclear'],
};

/** The AI reading of the comparison: prose, the terms check, concerns, asks. */
function SlipCommentary({ data, two, names }) {
  return (
    <div className="slip-ai">
      <Blueprint className="valpanel">
        <p className="slip-ai-summary">{data.summary}</p>
        {data.wording_commentary && <p className="slip-ai-prose">{data.wording_commentary}</p>}
      </Blueprint>

      {data.key_terms?.length > 0 && (
        <Blueprint className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Term</th>
                <th>{two ? names[0] : 'In the slip'}</th>
                {two && <th>{names[1]}</th>}
                <th>Status</th>
                <th>Commentary</th>
              </tr>
            </thead>
            <tbody>
              {data.key_terms.map((t, i) => {
                const [tone, label] = TERM_TONE[t.status] || ['neutral', t.status];
                return (
                  <tr key={i}>
                    <td style={{ fontWeight: 500 }}>{t.term}</td>
                    <td>{t.slip_a ?? <span className="muted small">not stated</span>}</td>
                    {two && <td>{t.slip_b ?? <span className="muted small">not stated</span>}</td>}
                    <td><Pill tone={tone}>{label}</Pill></td>
                    <td className="small">{t.commentary || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Blueprint>
      )}

      {data.concerns?.length > 0 && (
        <Blueprint className="valpanel">
          <div className="kicker">Concerns</div>
          {data.concerns.map((c, i) => (
            <div key={i} className="slip-ai-concern">
              <StatusPill value={c.severity} />
              <div>
                <div className="slip-ai-concern-title">{c.title}</div>
                <div className="small muted">{c.detail}</div>
              </div>
            </div>
          ))}
        </Blueprint>
      )}

      {data.questions_for_market?.length > 0 && (
        <Blueprint className="valpanel">
          <div className="kicker">Questions for the market</div>
          <ol className="slip-ai-questions">
            {data.questions_for_market.map((q, i) => <li key={i}>{q}</li>)}
          </ol>
        </Blueprint>
      )}

      <div className="hint">
        Drafted by {providerLabel(data.provider)} ({data.model}) from the full slip text, schedule
        terms included — a reading aid, not a substitute for reading the slip. Nothing is stored;
        re-run after changing the slips.
      </div>
    </div>
  );
}

/** The clause text behind a comparison row, diffed where there is a diff. */
function SlipRowDetail({ row, names, two }) {
  // Prefer the slip-vs-slip diff; fall back to how the slip departs from our
  // form, which is the interesting comparison when both slips read alike.
  const pair = row.diff?.length
    ? { ops: row.diff, left: two ? names[0] : 'Standard wording', right: two ? names[1] : names[0] }
    : (row.standard_diff?.length
      ? { ops: row.standard_diff, left: 'Standard wording', right: names[row.slips.findIndex((x) => x.present)] || 'Slip' }
      : null);

  if (pair) {
    const { ops, left: leftName, right: rightName } = pair;
    return (
      <div className="diffgrid">
        <Blueprint className="diffpane">
          <div className="kicker">{leftName}</div>
          <DiffProse ops={ops} side="left" />
        </Blueprint>
        <Blueprint className="diffpane">
          <div className="kicker accent">{rightName}</div>
          <DiffProse ops={ops} side="right" />
        </Blueprint>
      </div>
    );
  }
  const body = row.slips.find((s) => s.present)?.body || row.standard_body;
  return (
    <Blueprint className="diffpane">
      <div className="kicker">
        {row.flag === 'missing' ? 'Standard wording — not in the slip' : 'Clause text'}
      </div>
      <p className="diffline">{body || 'No text.'}</p>
    </Blueprint>
  );
}

function Stat({ value, label, on, onClick }) {
  if (!onClick) {
    return (
      <Blueprint className="statpanel">
        <div className="statvalue">{value}</div>
        <div className="stat-label">{label}</div>
      </Blueprint>
    );
  }
  return (
    <Blueprint as="button" className={`statpanel statpanel-pick${on ? ' on' : ''}`} onClick={onClick}>
      <div className="statvalue">{value}</div>
      <div className="stat-label">{label}</div>
    </Blueprint>
  );
}

/* ─────────────────────────────────────────────────────── Draft slip tab ── */

/**
 * The wording being assembled for the working layer: the draft that carries
 * it, its clause rows, and whether it is ready to go to market.
 */
function DraftSlipTab({ onError }) {
  const ws = useWorkspace();
  const role = useRole();
  const navigate = useNavigate();
  const layer = ws.layer;
  const placement = ws.placement;

  const drafts = useFetch(
    'GET',
    layer?.id ? `/wordings/drafts?layer_id=${layer.id}` : '/wordings/drafts?limit=1',
    [layer?.id],
  );
  const draftId = layer?.id ? drafts.data?.[0]?.id : null;
  const draft = useFetch('GET', draftId ? `/wordings/drafts/${draftId}` : '/wordings/meta', [draftId]);

  async function act(fn) {
    onError(null);
    try { await fn(); } catch (e) { onError(e); }
  }

  if (!layer?.id) {
    return (
      <Blueprint className="valpanel">
        <div className="small muted">Open a layer workspace to assemble its slip wording.</div>
      </Blueprint>
    );
  }

  if (!draftId) {
    return (
      <Blueprint className="valpanel">
        <div className="kicker">Slip wording</div>
        <div className="small muted">
          No wording drafted for {placement?.reference || 'this layer'} yet.
        </div>
        <button
          className="btn btn-primary"
          style={{ alignSelf: 'flex-start' }}
          disabled={!role.canBroke}
          onClick={() => act(async () => {
            const created = await api('POST', '/wordings/drafts', {
              title: `${placement?.reference || 'Slip'} — ${layer.name}`,
              placement_id: placement?.id ?? null,
              layer_id: layer.id,
              cob: placement?.class ?? null,
              seed: true,
            });
            navigate(`/wordings/drafts/${created.id}`);
          })}
        >Start the slip wording</button>
      </Blueprint>
    );
  }

  const rows = draft.data?.clauses || [];
  const amended = rows.filter((r) => r.amended).length;
  const stale = rows.filter((r) => r.library_updated).length;

  return (
    <div className="assemblygrid">
      <Blueprint className="assembly">
        <div className="assembly-head">
          <span className="assembly-title">
            Slip wording — {draft.data?.title || placement?.reference}
          </span>
          <span className="assembly-count">{rows.length} clauses · {amended} amended</span>
        </div>
        {rows.map((r, i) => (
          <div className="assemblyrow" key={r.id}>
            <span className="asmidx">{String(i + 1).padStart(2, '0')}</span>
            <div className="asmmain">
              <div className="asmname">{r.title}</div>
              <div className="asmmeta">
                {r.clause_ref || r.category}
                {r.source_market_name ? ` · ${r.source_market_name}` : ''}
                {r.library_updated ? ' · library has moved on' : ''}
              </div>
            </div>
            <Pill tone={r.amended ? 'accent' : 'neutral'}>{r.amended ? 'Amended' : 'As library'}</Pill>
            <button
              className="btn btn-ghost btn-sm"
              disabled={!role.canBroke}
              onClick={() => act(async () => {
                await api('DELETE', `/wordings/drafts/${draftId}/clauses/${r.id}`);
                draft.reload();
              })}
            >Remove</button>
          </div>
        ))}
        {rows.length === 0 && <div className="small muted" style={{ padding: 16 }}>No clauses in the slip yet.</div>}
      </Blueprint>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Blueprint className="valpanel">
          <div className="kicker">Slip readiness</div>
          {amended === 0
            ? <GlyphRow>Every clause matches the library text.</GlyphRow>
            : <GlyphRow warn>{amended} {amended === 1 ? 'clause has' : 'clauses have'} been amended off the library — an underwriter must sign the wording off.</GlyphRow>}
          {stale === 0
            ? <GlyphRow>No clause has been superseded in the library since it was pulled in.</GlyphRow>
            : <GlyphRow warn>{stale} {stale === 1 ? 'clause is' : 'clauses are'} behind the library — worth refreshing at renewal.</GlyphRow>}
          <GlyphRow>{rows.length} clauses assembled for {layer.name}.</GlyphRow>
        </Blueprint>
        <button className="btn btn-secondary btn-block" onClick={() => navigate(`/wordings/drafts/${draftId}`)}>
          Open the full wording
        </button>
      </div>
    </div>
  );
}
