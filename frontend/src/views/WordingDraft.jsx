import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Card, useFetch, ErrorBanner } from '../components.jsx';
import { useHasRole } from '../auth.jsx';
import { CATEGORIES, CATEGORY_LABEL, Chip, CategoryChip, SourceChip, ProvenanceChip, DiffText } from './Wordings.jsx';

const DRAFT_STATUSES = ['draft', 'review', 'issued', 'archived'];

/** One clause in the draft: read it, amend it, move it, or put it back. */
function DraftClause({ clause, canEdit, index, count, onMove, onSave, onRevert, onRemove }) {
  const [body, setBody] = useState(clause.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The clause can change underneath us (revert, reorder), so follow it.
  useEffect(() => setBody(clause.body), [clause.body]);
  const dirty = body !== clause.body;

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await onSave(body);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`wl-clause${clause.amended ? ' wl-clause--amended' : ''}`}>
      <div className="wl-clause-head">
        <span className="wl-clause-num">{clause.position}</span>
        <span className="wl-clause-title">{clause.title}</span>
        <CategoryChip category={clause.category} />
        {clause.source_market_name && <Chip tone="blue">{clause.source_market_name}</Chip>}
        {!clause.clause_id && <Chip tone="amber">Bespoke</Chip>}
        {clause.clause_ref && <span className="small muted">{clause.clause_ref}</span>}
        {clause.amended && <Chip tone="amber" title="Changed from the library text">Amended</Chip>}
        {clause.library_updated && (
          <Chip tone="red" title="The library clause has been revised since this draft was built">
            Library revised
          </Chip>
        )}
        {canEdit && (
          <span className="wl-clause-actions">
            <button className="ghost small" disabled={index === 0} onClick={() => onMove(-1)} title="Move up">↑</button>
            <button className="ghost small" disabled={index === count - 1} onClick={() => onMove(1)} title="Move down">↓</button>
            {clause.amended && <button className="ghost small" onClick={onRevert}>Revert</button>}
            <button className="ghost small wl-danger" onClick={onRemove}>Remove</button>
          </span>
        )}
      </div>
      {canEdit ? (
        <>
          <textarea className="wl-body-input" rows={Math.min(18, Math.max(4, body.split('\n').length + 3))}
            value={body} onChange={(e) => setBody(e.target.value)} />
          {dirty && (
            <div className="toolbar">
              <button className="small" onClick={save} disabled={busy}>{busy ? '…' : 'Save clause'}</button>
              <button className="secondary small" onClick={() => setBody(clause.body)}>Discard</button>
            </div>
          )}
          <ErrorBanner error={error} />
        </>
      ) : (
        <div className="wl-body">{clause.body}</div>
      )}
      {clause.amended && (
        <details className="wl-amend-detail">
          <summary className="small">What changed from the library</summary>
          <DiffText diff={wordDiff(clause.source_body, clause.body)} />
        </details>
      )}
    </div>
  );
}

/**
 * A word diff for the "what changed" disclosure. The server does the real
 * comparison work; this is the same idea inline, so amending a clause shows its
 * departure from the library without a round trip.
 */
function wordDiff(left, right) {
  const a = String(left || '').match(/\S+/g) || [];
  const b = String(right || '').match(/\S+/g) || [];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (op, text) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += ` ${text}`;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push('same', a[i]); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i += 1; }
    else { push('add', b[j]); j += 1; }
  }
  while (i < a.length) { push('del', a[i]); i += 1; }
  while (j < b.length) { push('add', b[j]); j += 1; }
  return out;
}

/** Pull another clause in from the library, or type a bespoke one. */
function AddClausePanel({ draft, onAdded, onClose }) {
  const [mode, setMode] = useState('library');
  const [q, setQ] = useState('');
  const [error, setError] = useState(null);
  const [free, setFree] = useState({ title: '', category: 'condition', body: '' });

  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: '100' });
    if (draft.cob) p.set('cob', draft.cob);
    if (q) p.set('q', q);
    return p.toString();
  }, [draft.cob, q]);
  const clauses = useFetch('GET', `/wordings/clauses?${qs}`, [qs]);

  const inDraft = useMemo(
    () => new Set(draft.clauses.map((c) => `${c.category}|${c.title.toLowerCase()}`)),
    [draft.clauses],
  );

  async function add(payload) {
    setError(null);
    try {
      await api('POST', `/wordings/drafts/${draft.id}/clauses`, payload);
      onAdded();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Card title="Add a clause" actions={<button className="ghost small" onClick={onClose}>Close</button>}>
      <div className="toolbar">
        <button className={mode === 'library' ? 'secondary small' : 'ghost small'}
          onClick={() => setMode('library')}>From the library</button>
        <button className={mode === 'free' ? 'secondary small' : 'ghost small'}
          onClick={() => setMode('free')}>Bespoke clause</button>
      </div>
      <ErrorBanner error={error} />

      {mode === 'library' ? (
        <>
          <label className="field"><span>Search {draft.cob ? `${draft.cob} and treaty-wide clauses` : 'the library'}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, reference or clause text" />
          </label>
          <div className="wl-add-list">
            {clauses.data?.map((c) => {
              const already = inDraft.has(`${c.category}|${c.title.toLowerCase()}`);
              return (
                <div key={c.id} className="wl-add-item">
                  <div>
                    <div className="wl-item-title">{c.title}</div>
                    <div className="wl-chips">
                      <CategoryChip category={c.category} />
                      <SourceChip clause={c} />
                      <ProvenanceChip clause={c} />
                      <Chip tone="grey">{c.cob || 'All classes'}</Chip>
                    </div>
                    {c.summary && <div className="small muted">{c.summary}</div>}
                  </div>
                  <button className="small" disabled={already} onClick={() => add({ clause_id: c.id })}>
                    {already ? 'In draft' : 'Add'}
                  </button>
                </div>
              );
            })}
            {clauses.data?.length === 0 && <div className="muted">Nothing matches.</div>}
          </div>
        </>
      ) : (
        <form className="wl-form" onSubmit={(e) => { e.preventDefault(); add(free); }}>
          <div className="wl-form-grid">
            <label className="field"><span>Title *</span>
              <input value={free.title} required
                onChange={(e) => setFree((s) => ({ ...s, title: e.target.value }))} />
            </label>
            <label className="field"><span>Category *</span>
              <select value={free.category}
                onChange={(e) => setFree((s) => ({ ...s, category: e.target.value }))}>
                {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
          </div>
          <label className="field"><span>Wording *</span>
            <textarea className="wl-body-input" rows={8} value={free.body} required
              onChange={(e) => setFree((s) => ({ ...s, body: e.target.value }))} />
          </label>
          <button type="submit">Add to draft</button>
        </form>
      )}
    </Card>
  );
}

/** The assembled wording, laid out as a document to read or print. */
function DocumentView({ draft }) {
  const grouped = CATEGORIES
    .map((c) => [c, draft.clauses.filter((x) => x.category === c.key)])
    .filter(([, list]) => list.length);
  return (
    <Card title="Assembled wording">
      <div className="wl-doc">
        <h2 className="wl-doc-title">{draft.title}</h2>
        <div className="wl-doc-sub">
          {[draft.cob || 'All classes', draft.treaty_type, draft.base_market_name && `based on ${draft.base_market_name}`]
            .filter(Boolean).join(' · ')}
        </div>
        {grouped.map(([cat, list]) => (
          <section key={cat.key} className="wl-doc-section">
            <h3 className="wl-doc-h">{cat.label}</h3>
            {list.map((c) => (
              <article key={c.id} className="wl-doc-clause">
                <h4>{c.position}. {c.title}{c.clause_ref ? ` (${c.clause_ref})` : ''}</h4>
                <div className="wl-body">{c.body}</div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </Card>
  );
}

export default function WordingDraft() {
  const { id } = useParams();
  const navigate = useNavigate();
  const canEdit = useHasRole('broker', 'admin');
  const draft = useFetch('GET', `/wordings/drafts/${id}`, [id]);
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState('edit');
  const [error, setError] = useState(null);

  if (draft.loading) return <p className="muted">Loading draft…</p>;
  if (draft.error) return <ErrorBanner error={draft.error} />;
  const d = draft.data;

  /** Run a mutation, surface any error, and refresh the draft. */
  async function run(fn) {
    setError(null);
    try {
      await fn();
      draft.reload();
    } catch (err) {
      setError(err);
    }
  }

  const move = (index, delta) => {
    const ids = d.clauses.map((c) => c.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return Promise.resolve();
    [ids[index], ids[target]] = [ids[target], ids[index]];
    return api('POST', `/wordings/drafts/${id}/reorder`, { clause_ids: ids });
  };

  const amended = d.clauses.filter((c) => c.amended).length;
  const stale = d.clauses.filter((c) => c.library_updated).length;

  return (
    <>
      <div className="breadcrumb">
        <a href="/wordings?tab=drafts" onClick={(e) => { e.preventDefault(); navigate('/wordings?tab=drafts'); }}>
          Wording library
        </a> / Draft
      </div>

      <div className="wl-head">
        <div>
          <h1>{d.title}</h1>
          <p className="wl-kicker">
            {[d.cob || 'All classes', d.treaty_type, d.base_market_name ? `built on ${d.base_market_name}` : 'built on the standard wording']
              .filter(Boolean).join(' · ')}
            {' · '}{d.clauses.length} clauses
            {amended > 0 && ` · ${amended} amended`}
            {stale > 0 && ` · ${stale} behind the library`}
          </p>
        </div>
        <div className="wl-tabs">
          <button type="button" className={`wl-tab${view === 'edit' ? ' wl-tab--on' : ''}`}
            onClick={() => setView('edit')}>Clauses</button>
          <button type="button" className={`wl-tab${view === 'doc' ? ' wl-tab--on' : ''}`}
            onClick={() => setView('doc')}>Document</button>
        </div>
      </div>

      <ErrorBanner error={error} />

      <Card title="Draft">
        <div className="toolbar">
          {canEdit && (
            <>
              <label className="field"><span>Status</span>
                <select value={d.status}
                  onChange={(e) => run(() => api('PATCH', `/wordings/drafts/${id}`, { status: e.target.value }))}>
                  {DRAFT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <button className="secondary" onClick={() => setAdding((s) => !s)}>
                {adding ? 'Close' : '+ Add clause'}
              </button>
            </>
          )}
          <button className="ghost" onClick={() => navigate(
            `/wordings?tab=compare&left_type=draft&left_id=${id}`,
          )}>Compare this draft</button>
          <button className="ghost" onClick={() => window.print()}>Print</button>
          {canEdit && (
            <button className="ghost wl-danger" onClick={async () => {
              if (!window.confirm('Delete this draft? The library is not affected.')) return;
              setError(null);
              try {
                await api('DELETE', `/wordings/drafts/${id}`);
                navigate('/wordings?tab=drafts');
              } catch (err) {
                setError(err);
              }
            }}>Delete draft</button>
          )}
        </div>
        {d.notes && <p className="small muted">{d.notes}</p>}
      </Card>

      {adding && canEdit && (
        <AddClausePanel draft={d} onClose={() => setAdding(false)}
          onAdded={() => { draft.reload(); }} />
      )}

      {view === 'doc' ? <DocumentView draft={d} /> : (
        <Card title={`Clauses (${d.clauses.length})`}>
          {d.clauses.length === 0 && (
            <p className="muted">This draft has no clauses yet — add them from the library.</p>
          )}
          {d.clauses.map((c, i) => (
            <DraftClause
              key={c.id}
              clause={c}
              index={i}
              count={d.clauses.length}
              canEdit={canEdit}
              onMove={(delta) => run(() => move(i, delta))}
              onSave={(body) => api('PATCH', `/wordings/drafts/${id}/clauses/${c.id}`, { body })
                .then(() => draft.reload())}
              onRevert={() => run(() => api('POST', `/wordings/drafts/${id}/clauses/${c.id}/revert`))}
              onRemove={() => {
                if (!window.confirm(`Remove "${c.title}" from this draft?`)) return;
                run(() => api('DELETE', `/wordings/drafts/${id}/clauses/${c.id}`));
              }}
            />
          ))}
        </Card>
      )}
    </>
  );
}
