import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Card, useFetch, ErrorBanner } from '../components.jsx';
import { useHasRole } from '../auth.jsx';
import { useRefData } from '../RefData.jsx';

/**
 * The class-of-business choices for a clause or draft: the Universe
 * reference classes, plus the classes the library already files wordings
 * under (or the one being edited) that the lookup does not carry, so no
 * existing wording is left unreachable.
 */
function useClassNames(current, libraryCobs) {
  const { classes } = useRefData();
  const names = classes.map((c) => c.name);
  const extras = [...(libraryCobs || []).map((c) => c.cob), current]
    .filter((c) => c && !names.includes(c));
  return [...names, ...[...new Set(extras)].sort()];
}

export const CATEGORIES = [
  { key: 'coverage', label: 'Standard coverages' },
  { key: 'extension', label: 'Extensions' },
  { key: 'exclusion', label: 'Market exclusions' },
  { key: 'condition', label: 'Conditions' },
  { key: 'definition', label: 'Definitions' },
];

/** Short form used on chips, where the plural group heading would read oddly. */
export const CATEGORY_LABEL = {
  coverage: 'Coverage', extension: 'Extension', exclusion: 'Exclusion',
  condition: 'Condition', definition: 'Definition',
};

const CATEGORY_TONE = {
  coverage: 'green', extension: 'blue', exclusion: 'red', condition: 'amber', definition: 'grey',
};

const STATUS_TONE = {
  identical: 'green', changed: 'amber', only_left: 'red', only_right: 'blue',
};

const STATUS_LABEL = {
  identical: 'Same', changed: 'Reworded', only_left: 'Dropped', only_right: 'Added',
};

const TABS = [
  { key: 'library', label: 'Library' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'compare', label: 'Compare' },
];

/** Small labelled chip used across the three tabs. */
export function Chip({ tone = 'grey', children, title }) {
  return <span className={`status tone-${tone}`} title={title}>{children}</span>;
}

export function CategoryChip({ category }) {
  return <Chip tone={CATEGORY_TONE[category]}>{CATEGORY_LABEL[category] || category}</Chip>;
}

/**
 * Whether a clause is the authentic published market form or placeholder
 * drafting. A broker about to put a clause on a slip needs to know which.
 */
export function ProvenanceChip({ clause }) {
  if (clause.provenance === 'market_standard') {
    return (
      <Chip tone="green" title={clause.source_org ? `Published by ${clause.source_org}` : 'Authentic published market form'}>
        Market standard
      </Chip>
    );
  }
  return <Chip tone="amber" title="Placeholder drafting written for this system — replace with your own approved wording">Illustrative</Chip>;
}

/** Who a clause came from: the standard market wording, a reinsurer, or us. */
export function SourceChip({ clause }) {
  if (clause.source === 'market' || clause.market_name) {
    return <Chip tone="blue" title="Reinsurer house wording">{clause.market_name}</Chip>;
  }
  if (clause.source === 'house') return <Chip tone="amber" title="Our own drafting">House</Chip>;
  return <Chip tone="grey" title="Market standard wording">Standard</Chip>;
}

/* ------------------------------------------------------------------ Library */

const EMPTY_CLAUSE = {
  title: '', clause_ref: '', category: 'exclusion', cob: '', source: 'standard',
  market_id: '', summary: '', body: '',
};

/** Create / edit form for one library clause. */
function ClauseForm({ initial, markets, onCancel, onSaved }) {
  const classNames = useClassNames(initial?.cob);
  const [v, setV] = useState(() => ({ ...EMPTY_CLAUSE, ...initial, market_id: initial?.market_id || '' }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const editing = Boolean(initial?.id);

  async function save(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload = {
        title: v.title,
        clause_ref: v.clause_ref || null,
        category: v.category,
        cob: v.cob || null,
        treaty_type: v.treaty_type || null,
        source: v.source,
        market_id: v.source === 'market' ? v.market_id || null : null,
        summary: v.summary || null,
        body: v.body,
        provenance: v.provenance || 'illustrative',
        source_org: v.source_org || null,
        source_url: v.source_url || null,
      };
      const saved = editing
        ? await api('PATCH', `/wordings/clauses/${initial.id}`, payload)
        : await api('POST', '/wordings/clauses', payload);
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="wl-form" onSubmit={save}>
      <div className="wl-form-grid">
        <label className="field"><span>Title *</span>
          <input value={v.title} onChange={(e) => set('title', e.target.value)} required
            placeholder="Cyber Loss Absolute Exclusion" />
        </label>
        <label className="field"><span>Market reference</span>
          <input value={v.clause_ref || ''} onChange={(e) => set('clause_ref', e.target.value)}
            placeholder="LMA 5403" />
        </label>
        <label className="field"><span>Category *</span>
          <select value={v.category} onChange={(e) => set('category', e.target.value)}>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label className="field"><span>Class of business</span>
          <select value={v.cob || ''} onChange={(e) => set('cob', e.target.value)}>
            <option value="">All classes (treaty-wide)</option>
            {classNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field"><span>Source *</span>
          <select value={v.source} onChange={(e) => set('source', e.target.value)}>
            <option value="standard">Market standard</option>
            <option value="market">Reinsurer house wording</option>
            <option value="house">Our own drafting</option>
          </select>
        </label>
        <label className="field"><span>Reinsurer {v.source === 'market' && '*'}</span>
          <select value={v.market_id || ''} disabled={v.source !== 'market'}
            required={v.source === 'market'}
            onChange={(e) => set('market_id', e.target.value)}>
            <option value="">—</option>
            {markets.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      </div>
      <div className="wl-form-grid">
        <label className="field"><span>Provenance</span>
          <select value={v.provenance || 'illustrative'} onChange={(e) => set('provenance', e.target.value)}>
            <option value="illustrative">Illustrative / own drafting</option>
            <option value="market_standard">Authentic market form</option>
          </select>
        </label>
        <label className="field"><span>Published by</span>
          <input value={v.source_org || ''} onChange={(e) => set('source_org', e.target.value)}
            placeholder="Lloyd's Market Association (LMA)" />
        </label>
        <label className="field"><span>Source URL</span>
          <input type="url" value={v.source_url || ''} onChange={(e) => set('source_url', e.target.value)}
            placeholder="https://lmalloyds.com/…" />
        </label>
      </div>
      <label className="field"><span>One-line summary</span>
        <input value={v.summary || ''} onChange={(e) => set('summary', e.target.value)}
          placeholder="What this clause does, in a line." />
      </label>
      <label className="field"><span>Wording *</span>
        <textarea className="wl-body-input" rows={12} value={v.body} required
          onChange={(e) => set('body', e.target.value)} placeholder="The clause text…" />
      </label>
      <ErrorBanner error={error} />
      <div className="toolbar">
        <button type="submit" disabled={busy}>{busy ? '…' : editing ? 'Save clause' : 'Add to library'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ClauseDetail({ clauseId, markets, canEdit, onChanged }) {
  const clause = useFetch('GET', `/wordings/clauses/${clauseId}`, [clauseId]);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  if (clause.loading) return <div className="muted">Loading…</div>;
  if (clause.error) return <ErrorBanner error={clause.error} />;
  const c = clause.data;

  if (editing) {
    return (
      <ClauseForm initial={c} markets={markets} onCancel={() => setEditing(false)}
        onSaved={() => { setEditing(false); clause.reload(); onChanged(); }} />
    );
  }

  return (
    <div className="wl-detail">
      <div className="wl-detail-head">
        <div>
          <h3>{c.title}</h3>
          <div className="wl-chips">
            <CategoryChip category={c.category} />
            <Chip tone="grey">{c.cob || 'All classes'}</Chip>
            <SourceChip clause={c} />
            <ProvenanceChip clause={c} />
            {c.clause_ref && <Chip tone="grey">{c.clause_ref}</Chip>}
            <span className="small muted">v{c.version}</span>
          </div>
        </div>
        {canEdit && <button className="secondary small" onClick={() => setEditing(true)}>Edit</button>}
      </div>
      {c.summary && <p className="wl-summary">{c.summary}</p>}
      <div className="wl-body">{c.body}</div>
      {(c.source_org || c.source_note) && (
        <div className={`wl-source wl-source--${c.provenance === 'market_standard' ? 'std' : 'illus'}`}>
          <div className="wl-source-head">
            {c.provenance === 'market_standard' ? 'Source' : 'Illustrative drafting'}
            {c.source_org && <> · {c.source_org}</>}
          </div>
          {c.source_note && <p className="wl-source-note">{c.source_note}</p>}
          {c.source_url && (
            <a className="small" href={c.source_url} target="_blank" rel="noopener noreferrer">
              {c.source_url}
            </a>
          )}
        </div>
      )}
      {c.revisions.length > 0 && (
        <div className="wl-history">
          <button className="ghost small" onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'Hide' : 'Show'} previous versions ({c.revisions.length})
          </button>
          {showHistory && c.revisions.map((r) => (
            <div key={r.id} className="wl-rev">
              <div className="small muted">v{r.version} · {new Date(r.created_at).toLocaleDateString()}</div>
              <div className="wl-body wl-body--old">{r.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LibraryTab({ meta, canEdit, onChanged }) {
  const [filters, setFilters] = useState({ cob: '', category: '', source: '', market_id: '', provenance: '', q: '' });
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const set = (k, v) => setFilters((s) => ({ ...s, [k]: v }));

  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: '200' });
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return p.toString();
  }, [filters]);
  const clauses = useFetch('GET', `/wordings/clauses?${qs}`, [qs]);

  const grouped = useMemo(() => {
    const out = new Map(CATEGORIES.map((c) => [c.key, []]));
    for (const c of clauses.data || []) (out.get(c.category) || []).push(c);
    return [...out.entries()].filter(([, list]) => list.length);
  }, [clauses.data]);

  return (
    <>
      <div className="wl-filters">
        <label className="field"><span>Search</span>
          <input value={filters.q} placeholder="Clause text, title or reference"
            onChange={(e) => set('q', e.target.value)} />
        </label>
        <label className="field"><span>Class of business</span>
          <select value={filters.cob} onChange={(e) => set('cob', e.target.value)}>
            <option value="">All classes</option>
            {meta.cobs.filter((c) => c.cob).map((c) => (
              <option key={c.cob} value={c.cob}>{c.cob} ({c.count})</option>
            ))}
          </select>
        </label>
        <label className="field"><span>Category</span>
          <select value={filters.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label} ({meta.categories.find((x) => x.category === c.key)?.count || 0})
              </option>
            ))}
          </select>
        </label>
        <label className="field"><span>Source</span>
          <select value={filters.source} onChange={(e) => set('source', e.target.value)}>
            <option value="">All sources</option>
            <option value="standard">Market standard</option>
            <option value="market">Reinsurer house</option>
            <option value="house">Our own</option>
          </select>
        </label>
        <label className="field"><span>Reinsurer</span>
          <select value={filters.market_id} onChange={(e) => set('market_id', e.target.value)}>
            <option value="">Any</option>
            {meta.markets.filter((m) => m.clause_count > 0).map((m) => (
              <option key={m.id} value={m.id}>{m.name} ({m.clause_count})</option>
            ))}
          </select>
        </label>
        <label className="field"><span>Provenance</span>
          <select value={filters.provenance} onChange={(e) => set('provenance', e.target.value)}>
            <option value="">Any</option>
            <option value="market_standard">Market standard only</option>
            <option value="illustrative">Illustrative only</option>
          </select>
        </label>
        {canEdit && (
          <button className="wl-new" onClick={() => { setCreating(true); setSelected(null); }}>+ New clause</button>
        )}
      </div>

      <div className="wl-split">
        <Card title={`Clauses (${clauses.data?.length ?? 0})`}>
          <ErrorBanner error={clauses.error} />
          <div className="wl-list">
            {grouped.map(([category, list]) => (
              <div key={category} className="wl-group">
                <div className="wl-group-head">
                  {CATEGORIES.find((c) => c.key === category).label}
                  <span className="muted small"> · {list.length}</span>
                </div>
                {list.map((c) => (
                  <button key={c.id} type="button"
                    className={`wl-item${selected === c.id ? ' wl-item--on' : ''}`}
                    onClick={() => { setSelected(c.id); setCreating(false); }}>
                    <span className="wl-item-title">{c.title}</span>
                    <span className="wl-item-meta">
                      <SourceChip clause={c} />
                      <Chip tone="grey">{c.cob || 'All classes'}</Chip>
                      {c.provenance === 'market_standard' && c.clause_ref && (
                        <Chip tone="green" title={c.source_org}>{c.clause_ref}</Chip>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {clauses.data?.length === 0 && <div className="muted">No clauses match these filters.</div>}
          </div>
        </Card>

        <Card title={creating ? 'New clause' : 'Clause'}>
          {creating ? (
            <ClauseForm markets={meta.markets} onCancel={() => setCreating(false)}
              onSaved={(c) => { setCreating(false); setSelected(c.id); onChanged(); clauses.reload(); }} />
          ) : selected ? (
            <ClauseDetail clauseId={selected} markets={meta.markets} canEdit={canEdit}
              onChanged={() => { onChanged(); clauses.reload(); }} />
          ) : (
            <p className="muted">
              Pick a clause to read it. The library holds the standard coverages, extensions
              and market exclusions by class, plus the house wordings of the leading reinsurers.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- Drafts */

function NewDraftForm({ meta, onCreated }) {
  const classNames = useClassNames(null, meta.cobs);
  const { treatyTypes } = useRefData();
  const [v, setV] = useState({ title: '', cob: '', treaty_type: '', base_market_id: '' });
  const [categories, setCategories] = useState(() => new Set(CATEGORIES.map((c) => c.key)));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));

  const toggle = (key) => setCategories((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const draft = await api('POST', '/wordings/drafts', {
        title: v.title,
        cob: v.cob || null,
        treaty_type: v.treaty_type || null,
        base_market_id: v.base_market_id || null,
        categories: [...categories],
      });
      onCreated(draft);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="wl-form" onSubmit={submit}>
      <div className="wl-form-grid">
        <label className="field"><span>Draft title *</span>
          <input value={v.title} required onChange={(e) => set('title', e.target.value)}
            placeholder="Acme Insurance — Property XoL 2027" />
        </label>
        <label className="field"><span>Class of business</span>
          <select value={v.cob} onChange={(e) => set('cob', e.target.value)}>
            <option value="">All classes</option>
            {classNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="field"><span>Treaty type</span>
          <select value={v.treaty_type} onChange={(e) => set('treaty_type', e.target.value)}>
            <option value="">—</option>
            {treatyTypes.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Build on</span>
          <select value={v.base_market_id} onChange={(e) => set('base_market_id', e.target.value)}>
            <option value="">Standard library wording</option>
            {meta.markets.filter((m) => m.clause_count > 0).map((m) => (
              <option key={m.id} value={m.id}>{m.name} house wording</option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span>Include</span>
        <div className="wl-cats">
          {CATEGORIES.map((c) => (
            <label key={c.key} className={`wl-cat${categories.has(c.key) ? ' wl-cat--on' : ''}`}>
              <input type="checkbox" checked={categories.has(c.key)} onChange={() => toggle(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
      </div>
      <p className="small muted">
        The draft is assembled from the library for that class — the standard wording, with the
        chosen reinsurer’s house clauses written over it. Editing the draft never changes the library.
      </p>
      <ErrorBanner error={error} />
      <button type="submit" disabled={busy || !categories.size}>{busy ? 'Building…' : 'Create draft'}</button>
    </form>
  );
}

function DraftsTab({ meta, canEdit }) {
  const drafts = useFetch('GET', '/wordings/drafts?limit=100');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  return (
    <>
      {canEdit && (
        <Card title="New draft wording"
          actions={<button className="secondary small" onClick={() => setCreating((s) => !s)}>
            {creating ? 'Close' : 'Start a draft'}
          </button>}>
          {creating
            ? <NewDraftForm meta={meta} onCreated={(d) => navigate(`/wordings/drafts/${d.id}`)} />
            : <p className="muted">Assemble a wording from the library, then amend it clause by clause.</p>}
        </Card>
      )}

      <Card title={`Draft wordings (${drafts.data?.length ?? 0})`}
        actions={<button className="ghost small" onClick={drafts.reload}>Refresh</button>}>
        <ErrorBanner error={drafts.error} />
        <table>
          <thead>
            <tr>
              <th>Title</th><th>Class</th><th>Built on</th><th className="right">Clauses</th>
              <th className="right">Amended</th><th>Status</th><th>Updated</th><th />
            </tr>
          </thead>
          <tbody>
            {drafts.data?.map((d) => (
              <tr key={d.id}>
                <td><a href={`/wordings/drafts/${d.id}`}
                  onClick={(e) => { e.preventDefault(); navigate(`/wordings/drafts/${d.id}`); }}>{d.title}</a></td>
                <td>{d.cob || 'All classes'}{d.treaty_type ? ` · ${d.treaty_type}` : ''}</td>
                <td>{d.base_market_name || 'Standard'}</td>
                <td className="right">{d.clause_count}</td>
                <td className="right">{d.amended_count || '—'}</td>
                <td><Chip tone={d.status === 'issued' ? 'green' : d.status === 'review' ? 'amber' : 'grey'}>{d.status}</Chip></td>
                <td className="small muted">{new Date(d.updated_at).toLocaleDateString()}</td>
                <td className="right"><button className="ghost small"
                  onClick={() => navigate(`/wordings/drafts/${d.id}`)}>Open →</button></td>
              </tr>
            ))}
            {drafts.data?.length === 0 && (
              <tr><td colSpan="8" className="muted">No drafts yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ Compare */

/** One side of the comparison: what to compare, and for which class. */
function SidePicker({ label, side, onChange, meta, drafts }) {
  const set = (k, v) => onChange({ ...side, [k]: v });
  return (
    <div className="wl-side">
      <div className="wl-side-label">{label}</div>
      <label className="field"><span>Compare</span>
        <select value={side.type} onChange={(e) => set('type', e.target.value)}>
          <option value="standard">Standard library wording</option>
          <option value="market">A reinsurer’s wording</option>
          <option value="draft">A draft wording</option>
        </select>
      </label>
      {side.type === 'market' && (
        <label className="field"><span>Reinsurer</span>
          <select value={side.id || ''} onChange={(e) => set('id', e.target.value)}>
            <option value="">Select…</option>
            {meta.markets.filter((m) => m.clause_count > 0).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
      )}
      {side.type === 'draft' && (
        <label className="field"><span>Draft</span>
          <select value={side.id || ''} onChange={(e) => set('id', e.target.value)}>
            <option value="">Select…</option>
            {(drafts || []).map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select>
        </label>
      )}
      {side.type !== 'draft' && (
        <label className="field"><span>Class of business</span>
          <select value={side.cob || ''} onChange={(e) => set('cob', e.target.value)}>
            <option value="">All classes</option>
            {/* The classes the library holds wordings for, as the library filter offers them. */}
            {meta.cobs.filter((c) => c.cob).map((c) => <option key={c.cob} value={c.cob}>{c.cob}</option>)}
          </select>
        </label>
      )}
      {side.type === 'market' && (
        <label className="wl-check">
          <input type="checkbox" checked={side.layered !== false}
            onChange={(e) => set('layered', e.target.checked)} />
          <span>Fill gaps from the standard wording</span>
        </label>
      )}
    </div>
  );
}

/** True when a space belongs between two runs of diff text. */
const spaceBetween = (next) => Boolean(next) && !/^[,.;:!?%)\]}»’”]/.test(next);

/**
 * Word-level diff of one clause, rendered inline. The separating space sits
 * outside the highlight so a changed word is marked, not the gap before it.
 */
export function DiffText({ diff }) {
  return (
    <p className="wl-diff">
      {diff.map((d, i) => (
        <React.Fragment key={i}>
          <span className={d.op === 'add' ? 'wl-ins' : d.op === 'del' ? 'wl-del' : undefined}>
            {d.text}
          </span>
          {spaceBetween(diff[i + 1]?.text) ? ' ' : ''}
        </React.Fragment>
      ))}
    </p>
  );
}

function CompareRow({ row }) {
  const [open, setOpen] = useState(false);
  const pct = Math.round(row.similarity * 100);
  return (
    <div className={`wl-row wl-row--${row.status}`}>
      <button type="button" className="wl-row-head" onClick={() => setOpen((s) => !s)}>
        <Chip tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Chip>
        <span className="wl-row-title">{row.title}</span>
        <CategoryChip category={row.category} />
        {row.clause_ref && <span className="small muted">{row.clause_ref}</span>}
        {row.status === 'changed' && <span className="small muted">{pct}% unchanged</span>}
        <span className="wl-row-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="wl-row-body">
          {row.status === 'changed' && <DiffText diff={row.diff} />}
          {row.status === 'identical' && <div className="wl-body">{row.left.body}</div>}
          {row.status === 'only_left' && <div className="wl-body">{row.left.body}</div>}
          {row.status === 'only_right' && <div className="wl-body">{row.right.body}</div>}
        </div>
      )}
    </div>
  );
}

function CompareTab({ meta, initial }) {
  const drafts = useFetch('GET', '/wordings/drafts?limit=100');
  // "Compare this draft" from the draft editor arrives as query params.
  const [left, setLeft] = useState(() => initial.left || { type: 'standard', cob: 'Property' });
  const [right, setRight] = useState(() => initial.right || { type: 'market', cob: 'Property' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [only, setOnly] = useState('differences');

  async function run() {
    setError(null);
    setBusy(true);
    try {
      const p = new URLSearchParams();
      for (const [prefix, side] of [['left', left], ['right', right]]) {
        p.set(`${prefix}_type`, side.type);
        if (side.id) p.set(`${prefix}_id`, side.id);
        if (side.cob) p.set(`${prefix}_cob`, side.cob);
        if (side.type === 'market' && side.layered === false) p.set(`${prefix}_layered`, 'false');
      }
      setResult(await api('GET', `/wordings/compare?${p}`));
    } catch (err) {
      setError(err);
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  const rows = result
    ? result.rows.filter((r) => only === 'all' || r.status !== 'identical')
    : [];

  return (
    <>
      <Card title="Compare wordings">
        <div className="wl-compare-picker">
          <SidePicker label="Left" side={left} onChange={setLeft} meta={meta} drafts={drafts.data} />
          <div className="wl-versus">vs</div>
          <SidePicker label="Right" side={right} onChange={setRight} meta={meta} drafts={drafts.data} />
        </div>
        <ErrorBanner error={error} />
        <div className="toolbar">
          <button onClick={run} disabled={busy}>{busy ? 'Comparing…' : 'Compare'}</button>
          <span className="small muted">
            Clauses are matched on market reference, then title, then wording similarity.
          </span>
        </div>
      </Card>

      {result && (
        <Card
          title={`${result.left.label} vs ${result.right.label}`}
          actions={(
            <div className="toolbar">
              <button className={only === 'differences' ? 'secondary small' : 'ghost small'}
                onClick={() => setOnly('differences')}>Differences only</button>
              <button className={only === 'all' ? 'secondary small' : 'ghost small'}
                onClick={() => setOnly('all')}>All clauses</button>
            </div>
          )}>
          <div className="wl-summary-row">
            <div className="wl-stat"><div className="stat-label">MATCH</div>
              <div className="stat-value">{result.summary.match_pct.toFixed(1)}%</div>
              <div className="stat-sub">{result.left.clause_count} vs {result.right.clause_count} clauses</div>
            </div>
            <div className="wl-stat"><div className="stat-label">SAME</div>
              <div className="stat-value">{result.summary.identical}</div>
              <div className="stat-sub">word for word</div></div>
            <div className="wl-stat"><div className="stat-label">REWORDED</div>
              <div className="stat-value">{result.summary.changed}</div>
              <div className="stat-sub">same clause, changed terms</div></div>
            <div className="wl-stat"><div className="stat-label">DROPPED</div>
              <div className="stat-value">{result.summary.only_left}</div>
              <div className="stat-sub">only on the left</div></div>
            <div className="wl-stat"><div className="stat-label">ADDED</div>
              <div className="stat-value">{result.summary.only_right}</div>
              <div className="stat-sub">only on the right</div></div>
          </div>
          <div className="wl-legend small muted">
            In a reworded clause, <span className="wl-del">text in red</span> is on the left only
            and <span className="wl-ins">text in green</span> is on the right only.
          </div>
          <div className="wl-rows">
            {rows.map((r, i) => <CompareRow key={`${r.title}-${i}`} row={r} />)}
            {rows.length === 0 && (
              <div className="muted">
                {only === 'differences' ? 'These two wordings are identical clause for clause.' : 'Nothing to compare.'}
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}

/* --------------------------------------------------------------------- Hub */

/** Read a pre-filled comparison side out of the URL (deep link from a draft). */
function sidesFromParams(params) {
  const side = (prefix) => {
    const type = params.get(`${prefix}_type`);
    if (!type) return null;
    return {
      type,
      id: params.get(`${prefix}_id`) || undefined,
      cob: params.get(`${prefix}_cob`) || '',
      layered: params.get(`${prefix}_layered`) !== 'false',
    };
  };
  return { left: side('left'), right: side('right') };
}

export default function Wordings() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'library';
  const canEdit = useHasRole('broker', 'admin');
  const meta = useFetch('GET', '/wordings/meta');

  if (meta.loading) return <><h1>Wording library</h1><p className="muted">Loading library…</p></>;
  if (meta.error) return <><h1>Wording library</h1><ErrorBanner error={meta.error} /></>;

  return (
    <>
      <div className="wl-head">
        <div>
          <h1>Wording library</h1>
          <p className="wl-kicker">
            {meta.data.totals.clauses} clauses · {meta.data.totals.market_standard} authentic market
            forms · {meta.data.totals.market_clauses} reinsurer house wordings
            · {meta.data.totals.drafts} draft{meta.data.totals.drafts === 1 ? '' : 's'}
          </p>
        </div>
        <div className="wl-tabs">
          {TABS.map((t) => (
            <button key={t.key} type="button"
              className={`wl-tab${tab === t.key ? ' wl-tab--on' : ''}`}
              onClick={() => setParams({ tab: t.key })}>{t.label}</button>
          ))}
        </div>
      </div>

      {tab === 'library' && <LibraryTab meta={meta.data} canEdit={canEdit} onChanged={meta.reload} />}
      {tab === 'drafts' && <DraftsTab meta={meta.data} canEdit={canEdit} />}
      {tab === 'compare' && <CompareTab meta={meta.data} initial={sidesFromParams(params)} />}
    </>
  );
}
