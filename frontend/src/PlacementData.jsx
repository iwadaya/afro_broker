import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api.js';
import { StructCard } from './StructureSections.jsx';
import { providerLabel, fmtDate } from './components.jsx';

/*
 * The Data screen.
 *
 * Nothing is ingested here. The screen reads everything entered on the
 * screens before it — treaty detail, expiring structure, structures to
 * quote, retentions and the modelling screens — as one, and compares this
 * year with the year it renews: the prior placement in the book where there
 * is one, or the expiring renewal pack uploaded here for a placement that is
 * new to the house (in whatever format the other broker wrote it). The
 * movements are computed on the server and shown as soon as the tab opens;
 * "Analyse with AI" then asks the model to read the lot and comment.
 */

const readFileBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('Could not read file'));
  r.readAsDataURL(file);
});

const fmt = (n, dp = 0) => (n == null || n === '' || Number.isNaN(Number(n))
  ? '—'
  : Number(n).toLocaleString(undefined, { maximumFractionDigits: dp }));
const pct = (n, dp = 2) => (n == null ? '—' : `${Number(n).toLocaleString(undefined, { maximumFractionDigits: dp })}%`);
const kb = (n) => (n == null ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fieldLabel = (f) => String(f || '').replace(/_pct$/, ' %').replace(/_/g, ' ');
const value = (v, field) => {
  if (v == null) return '—';
  if (typeof v === 'number') return /pct$/.test(field) ? pct(v, 4) : fmt(v, 2);
  return String(v);
};

function Tile({ label, value: v, sub, tone }) {
  return (
    <div className={`an-tile${tone ? ` an-tile--${tone}` : ''}`}>
      <div className="an-tile-label">{label}</div>
      <div className="an-tile-value">{v}</div>
      {sub && <div className="an-tile-sub">{sub}</div>}
    </div>
  );
}

/** The screens the digest read, each with whether it holds anything. */
function Screens({ digest, onOpenScreen }) {
  const s = digest.screens || {};
  const rows = [
    ['detail', 'Treaty Detail', true, `${digest.placement.treaty_type || '—'} · ${(digest.placement.classes_of_business || []).join(', ') || '—'}`],
    ['expiring', 'Expiring Structure', s.expiring_structure, digest.expiring_structure
      ? (digest.expiring_structure.basis === 'PROP' ? 'proportional terms' : `${digest.expiring_structure.layers.length} layer${digest.expiring_structure.layers.length === 1 ? '' : 's'}${digest.expiring_structure.recorded ? '' : ' (prior year, read live)'}`)
      : 'nothing recorded'],
    ['structure', 'Quote Structure', s.quote_structure, `${digest.structures.length} structure${digest.structures.length === 1 ? '' : 's'} · ${digest.layers.length} layer${digest.layers.length === 1 ? '' : 's'}`],
    ['retentions', 'Retentions', s.retentions, `${digest.retentions?.rows?.length || 0} categories`],
  ];
  return (
    <div className="pd-screens" data-testid="data-screens">
      {rows.map(([key, label, filled, sub]) => (
        <div key={key} className={`pd-screen${filled ? '' : ' pd-screen--empty'}`}>
          <span><b>{label}</b><span className="pd-screen-sub">{sub}</span></span>
          <span className="pd-screen-side">
            <span className={`rp-status rp-status--${filled ? 'filled' : 'empty'}`}>{filled ? 'entered' : 'no data'}</span>
            {onOpenScreen && <button type="button" className="np-struct-btn" onClick={() => onOpenScreen(key)}>Open</button>}
          </span>
        </div>
      ))}
      {digest.modelling.map((c) => (
        <div key={c.class} className={`pd-screen${c.screens.length ? '' : ' pd-screen--empty'}`}>
          <span><b>Modelling — {c.class}</b><span className="pd-screen-sub">{c.screens.length ? c.screens.map((x) => x.title).join(', ') : 'no screen data'}</span></span>
          <span className={`rp-status rp-status--${c.screens.length ? 'filled' : 'empty'}`}>{c.screens.length} screen{c.screens.length === 1 ? '' : 's'}</span>
        </div>
      ))}
    </div>
  );
}

/** What this year is compared with, and the upload for a placement new to the house. */
function Basis({ digest, comparison, canEdit, busy, onUpload }) {
  const fileRef = useRef(null);
  const upload = (
    <label className="pd-upload">
      <input ref={fileRef} type="file" data-testid="upload-expiring-pack" disabled={busy}
        accept=".pdf,.xlsx,.xls,.xlsm,.csv,.txt,.json,.png,.jpg,.jpeg"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
      <span className="np-struct-btn np-struct-btn--accent">⤒ Upload expiring renewal pack</span>
      <span className="muted small">PDF, Excel, CSV or an image — any broker's format.</span>
    </label>
  );
  if (comparison.basis === 'prior_year') {
    const p = comparison.prior.placement;
    return (
      <div className="pd-basis" data-testid="data-basis">
        <span className="pill-mini">RENEWAL</span>
        <span>
          Compared with the prior year in the book: <Link to={`/placements/${p.id}`}><b>{p.reference}</b></Link>
          {' '}· {p.class} · {p.inception} → {p.expiry} · {p.currency}
          {' '}· {comparison.prior.structures.length} structure{comparison.prior.structures.length === 1 ? '' : 's'}
          {' '}· {comparison.prior.screens?.modelling_screens || 0} modelling screen{comparison.prior.screens?.modelling_screens === 1 ? '' : 's'}.
        </span>
      </div>
    );
  }
  if (comparison.basis === 'expiring_pack') {
    return (
      <div className="pd-basis pd-basis--pack" data-testid="data-basis">
        <span className="pill-mini">NEW TO THE HOUSE</span>
        <span>
          Compared with the expiring renewal pack uploaded here
          {comparison.analysis?.status === 'complete' ? ' (read by the AI)' : ''}:
        </span>
        <ul className="pd-list">
          {comparison.documents.map((d) => (
            <li key={d.id}><b>{d.filename}</b> · {d.mime_type} · {kb(d.size_bytes)} · uploaded {fmtDate(d.created_at)}</li>
          ))}
        </ul>
        {canEdit && upload}
      </div>
    );
  }
  return (
    <div className="pd-basis" data-testid="data-basis">
      <span className="pill-mini">NEW BUSINESS</span>
      <span>
        {digest.placement.renewal_of
          ? 'The placement names a prior year that could not be read.'
          : 'This placement renews nothing in the book. Upload the expiring renewal pack — the one the other broker wrote — and the comparison runs against it, whatever its layout.'}
      </span>
      {canEdit && upload}
    </div>
  );
}

/** The movements computed from the figures, before any reading. */
function Changes({ computed, comparison }) {
  const changes = computed?.changes || [];
  if (comparison.basis === 'expiring_pack') {
    const ex = comparison.extracted;
    if (!ex) return <div className="muted small">The uploaded pack is compared by the AI reading — run the analysis to read it against the screens.</div>;
    return (
      <>
        <div className="td-hint">As the uploaded pack states the expiring programme (extracted by the AI from the other broker's document):</div>
        <dl className="kv">
          {['treaty_name', 'structure', 'basis', 'inception', 'expiry', 'currency', 'epi', 'deposit_premium', 'retention'].filter((k) => ex.programme?.[k]).map((k) => (
            <React.Fragment key={k}><dt>{fieldLabel(k)}</dt><dd>{ex.programme[k]}</dd></React.Fragment>
          ))}
        </dl>
        {ex.layers?.length > 0 && (
          <div className="np-table-wrap">
            <table className="np-struct-table">
              <thead><tr><th>Layer</th><th>Cover</th><th>Deposit premium</th><th>ROL</th><th>Reinstatements</th><th>Expiring line</th></tr></thead>
              <tbody>{ex.layers.map((l, i) => <tr key={i}><td>{l.name}</td><td>{l.cover || '—'}</td><td>{l.deposit_premium || '—'}</td><td>{l.rol || '—'}</td><td>{l.reinstatements || '—'}</td><td>{l.expiring_line || '—'}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </>
    );
  }
  if (comparison.basis !== 'prior_year') return <div className="muted small">Nothing to compare with yet.</div>;
  if (!changes.length) return <div className="muted small" data-testid="data-changes">No movement between this year's screens and the prior year's.</div>;
  return (
    <div className="np-table-wrap">
      <table className="np-struct-table" data-testid="data-changes">
        <thead><tr><th>Area</th><th>Item</th><th>Field</th><th>Prior year</th><th>This year</th><th>Change</th></tr></thead>
        <tbody>
          {changes.map((c, i) => (
            <tr key={i}>
              <td>{c.area}</td><td>{c.item}</td><td>{fieldLabel(c.field)}</td>
              <td>{value(c.from, c.field)}</td><td><b>{value(c.to, c.field)}</b></td>
              <td className={c.change_pct == null ? '' : c.change_pct > 0 ? 'pd-change--up' : 'pd-change--down'}>
                {c.change_pct == null ? '—' : `${c.change_pct > 0 ? '+' : ''}${c.change_pct}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TONE = { improved: 'improved', deteriorated: 'deteriorated', unchanged: 'unchanged', unclear: 'unclear' };

function Narrative({ analysis }) {
  const n = analysis?.narrative;
  if (!n) return null;
  return (
    <div className="pd-narrative" data-testid="data-narrative">
      <p><b>{n.headline}</b></p>
      <h4>Programme</h4><p>{n.programme}</p>
      <h4>Exposure and experience</h4><p>{n.exposure_and_experience}</p>
      <h4>Retentions and terms</h4><p>{n.retentions_and_terms}</p>
      {n.comparison?.length > 0 && (
        <>
          <h4>Compared with the expiring year</h4>
          <div className="pd-cmp">
            {n.comparison.map((c, i) => (
              <div key={i} className={`pd-cmp-row pd-cmp-row--${TONE[c.direction] || 'unchanged'}`}>
                <span><b>{c.area}</b><span className="pd-screen-sub">{c.direction} · {c.significance}</span></span>
                <span><b>{c.change}</b> — {c.commentary}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {n.gaps?.length > 0 && <><h4>Gaps</h4><ul className="pd-list">{n.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul></>}
      {n.questions_for_cedant?.length > 0 && <><h4>Questions for the cedant</h4><ul className="pd-list">{n.questions_for_cedant.map((g, i) => <li key={i}>{g}</li>)}</ul></>}
      {n.recommendations?.length > 0 && <><h4>Recommendations</h4><ul className="pd-list">{n.recommendations.map((g, i) => <li key={i}>{g}</li>)}</ul></>}
      <div className="muted small">
        Read {fmtDate(analysis.created_at)}{analysis.created_by_name ? ` by ${analysis.created_by_name}` : ''} · {providerLabel(analysis.provider)} {analysis.model || ''} · basis {analysis.basis.replace('_', ' ')}
      </div>
    </div>
  );
}

export default function PlacementData({ placementId, canEdit, canRun, onOpenScreen }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = () => api('GET', `/placements/${placementId}/data-analysis`).then(setState).catch(setError);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [placementId]);

  const run = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const res = await api('POST', `/placements/${placementId}/data-analysis`, {});
      setState((s) => ({ ...s, ...res }));
      setNote('The AI has read the screens.');
    } catch (e) {
      // A provider outage still returns the computed comparison — keep it.
      if (e.data?.computed) setState((s) => ({ ...s, computed: e.data.computed, comparison: e.data.comparison || s?.comparison, digest: e.data.digest || s?.digest }));
      setError(e);
    } finally { setBusy(false); }
  };

  const upload = async (file) => {
    setBusy(true); setError(null); setNote(null);
    try {
      const content_base64 = await readFileBase64(file);
      const res = await api('POST', `/placements/${placementId}/expiring-pack`, {
        filename: file.name, mime_type: file.type || 'application/octet-stream', content_base64,
      });
      setState((s) => ({ ...s, digest: res.digest, comparison: res.comparison, computed: res.computed }));
      setNote(`Expiring pack "${file.name}" uploaded — the comparison runs against it.`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (!state) return <div className="muted" style={{ padding: 12 }}>{error ? error.message : 'Loading…'}</div>;
  const { digest, comparison, computed, analysis } = state;
  const providers = (state.providers || []).filter((p) => p.configured);
  const screens = digest.screens || {};
  const filled = ['treaty_detail', 'expiring_structure', 'quote_structure', 'retentions'].filter((k) => screens[k]).length;

  return (
    <section className="np-struct-card rp" data-testid="placement-data">
      <div className="np-struct-card-header">
        <div>
          <div className="np-struct-card-h2">Data</div>
          <div className="np-struct-card-hint">
            The placement's screens read as one — treaty detail, expiring structure, structures to quote, retentions and the modelling screens — and compared with the year it renews. Nothing is imported here: the renewal pack is built from the screens.
          </div>
        </div>
        <div className="np-struct-card-actions">
          {canRun && (
            <button type="button" className="np-green-pill" disabled={busy || !providers.length} data-testid="run-data-analysis"
              title={providers.length ? `Read the screens and the comparison with ${providers.map(providerLabel).join(' / ')}` : 'No AI provider is configured — the computed comparison still stands'}
              onClick={run}>
              {busy ? 'Working…' : analysis ? 'Analyse again with AI' : 'Analyse with AI'}
            </button>
          )}
        </div>
      </div>
      {error && <div className="ing-error">{error.message || 'Failed'}</div>}
      {note && <div className="np-struct-notice">{note}</div>}

      <div className="an-tiles">
        <Tile label="Placement screens" value={`${filled}/4`} sub="with data" tone={filled === 4 ? 'good' : 'warn'} />
        <Tile label="Structures to quote" value={digest.structures.length} sub={digest.structures.map((s) => (s.basis === 'PROP' ? 'proportional' : `${s.layers.length} layers`)).join(' · ') || '—'} />
        <Tile label="Retention categories" value={digest.retentions?.rows?.length || 0} sub={digest.retentions?.treaty_limit ? `limit ${fmt(digest.retentions.treaty_limit)}` : ''} />
        <Tile label="Modelling screens" value={screens.modelling_screens || 0} sub={digest.modelling.map((c) => `${c.class}: ${c.screens.length}`).join(' · ') || '—'} tone={screens.modelling_screens ? 'good' : 'warn'} />
        <Tile label="Compared with" value={comparison.basis === 'prior_year' ? 'Prior year' : comparison.basis === 'expiring_pack' ? 'Expiring pack' : 'Nothing yet'} sub={comparison.basis === 'none' ? 'upload the expiring pack' : ''} tone={comparison.basis === 'none' ? 'warn' : 'good'} />
      </div>

      <StructCard title="The screens" hint="Every screen the analysis reads, and whether it holds anything yet. Enter data on a screen and it is read the next time this tab opens.">
        <Screens digest={digest} onOpenScreen={onOpenScreen} />
      </StructCard>

      <StructCard title="Basis of comparison" hint="A renewal compares with the prior year's placement in the book. A placement new to the house compares with the expiring renewal pack uploaded here — the other broker's, in its own format.">
        <Basis digest={digest} comparison={comparison} canEdit={canEdit} busy={busy} onUpload={upload} />
      </StructCard>

      <StructCard title="What moved" hint="Computed from the figures on the screens — structure 1 against the expiring structure layer by layer, the retentions category by category, the treaty detail field by field. No model involved.">
        <Changes computed={computed} comparison={comparison} />
      </StructCard>

      <StructCard title="AI reading" hint="The model reads the screens and the basis of comparison and writes for a broking audience — it never recalculates a figure it was given.">
        {analysis ? <Narrative analysis={analysis} /> : (
          <div className="muted small" data-testid="data-narrative-empty">
            {providers.length ? 'Not read yet — Analyse with AI reads the screens and the comparison.' : 'No AI provider is configured; the computed comparison above stands on its own.'}
          </div>
        )}
      </StructCard>
    </section>
  );
}
