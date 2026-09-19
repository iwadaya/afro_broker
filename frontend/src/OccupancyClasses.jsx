import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { DEFAULT_OCCUPANCY_CLASSES, classesFromApi } from './occupancy.js';

/**
 * The occupancy class table — the grading the retentions table reads.
 *
 * Everyone reads it; an admin maintains it here, adding, removing and editing
 * classes in place. It falls back to the seeded grading if the table cannot be
 * read, so a placement can still be graded offline.
 */
export function useOccupancyClasses() {
  const [state, setState] = useState({ classes: DEFAULT_OCCUPANCY_CLASSES, error: null, loading: true, live: false });

  const reload = useCallback(() => {
    let alive = true;
    api('GET', '/occupancy-classes')
      .then((rows) => {
        if (!alive) return;
        const classes = classesFromApi(rows);
        // An empty table would grade nothing; keep the seeded grading instead.
        setState({
          classes: classes.length ? classes : DEFAULT_OCCUPANCY_CLASSES,
          error: null, loading: false, live: classes.length > 0,
        });
      })
      .catch((error) => alive && setState((s) => ({ ...s, error, loading: false })));
    return () => { alive = false; };
  }, []);

  useEffect(() => reload(), [reload]);
  return { ...state, reload };
}

const blankClass = () => ({ id: null, code: '', name: '', description: '', pct: '', terms: '' });

/** An editable row is the stored shape with the terms as one editable line. */
const toDraft = (k) => ({
  id: k.id ?? null,
  code: k.klass || '',
  name: k.name || '',
  description: k.description || '',
  pct: k.pct == null ? '' : String(k.pct),
  terms: (k.occupancies || []).join(', '),
});

const toPayload = (d) => ({
  ...(d.id ? { id: d.id } : {}),
  code: d.code.trim(),
  name: d.name.trim(),
  description: d.description.trim() || null,
  capacity_pct: Number(d.pct),
  occupancies: d.terms.split(',').map((t) => t.trim()).filter(Boolean),
});

/** What stops a draft being saved, in the order an admin would fix it. */
function draftProblem(drafts) {
  const rows = drafts.filter((d) => d.code.trim() || d.name.trim() || d.terms.trim());
  if (!rows.length) return 'Add at least one class.';
  for (const d of rows) {
    if (!d.code.trim()) return 'Every class needs a code.';
    if (!d.name.trim()) return `Class ${d.code.trim()} needs a name.`;
    const pct = Number(d.pct);
    if (d.pct === '' || Number.isNaN(pct) || pct < 0 || pct > 100) {
      return `Class ${d.code.trim()} needs a % of capacity between 0 and 100.`;
    }
  }
  const codes = rows.map((d) => d.code.trim().toUpperCase());
  const duplicate = codes.find((c, i) => codes.indexOf(c) !== i);
  if (duplicate) return `Two classes share the code "${duplicate}".`;
  return null;
}

export function OccupancyClassTable({ classes, canEdit, onSaved, live }) {
  const [drafts, setDrafts] = useState(null);   // null = not editing
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const editing = drafts !== null;
  const upd = (i, patch) => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  async function save() {
    const problem = draftProblem(drafts);
    if (problem) { setError({ message: problem }); return; }
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/occupancy-classes', {
        classes: drafts
          .filter((d) => d.code.trim() && d.name.trim())
          .map(toPayload),
      });
      setDrafts(null);
      onSaved?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ret-classes">
      {canEdit && (
        <div className="ret-tools" style={{ margin: '0 0 8px' }}>
          {editing ? (
            <>
              <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save class table'}
              </button>
              <button type="button" className="np-struct-btn" disabled={busy}
                onClick={() => { setDrafts(null); setError(null); }}>Cancel</button>
              <button type="button" className="np-struct-btn"
                onClick={() => setDrafts((ds) => [...ds, blankClass()])}>＋ Add class</button>
            </>
          ) : (
            <button type="button" className="np-struct-btn"
              onClick={() => { setDrafts(classes.map(toDraft)); setError(null); }}>
              ✎ Edit class table
            </button>
          )}
          {!live && !editing && (
            <span className="np-layer-count">Showing the seeded grading — the saved table could not be read.</span>
          )}
        </div>
      )}

      {error && <div className="err banner">{error.message}</div>}

      <div className="np-table-wrap">
        <table className="np-struct-table">
          <thead>
            <tr>
              <th className="np-table-sticky">Class</th>
              <th>Grading</th>
              <th title="Share of the treaty full limit risks in this class may use">% of capacity</th>
              <th>Typical occupancies</th>
              {editing && <th />}
            </tr>
          </thead>
          <tbody>
            {!editing && classes.map((k) => (
              <tr key={k.id || k.klass}>
                <th className="np-table-sticky"><span className="np-layer-badge">{k.klass}</span></th>
                <td>
                  <b>{k.name}</b>
                  {k.description && <div className="ret-class-note">{k.description}</div>}
                </td>
                <td><b>{k.pct}%</b></td>
                <td className="ret-class-terms">{(k.occupancies || []).slice(0, 10).join(', ')}
                  {(k.occupancies || []).length > 10 ? '…' : ''}</td>
              </tr>
            ))}
            {editing && drafts.map((d, i) => (
              <tr key={d.id || `new-${i}`}>
                <th className="np-table-sticky">
                  <input className="np-mini-input" style={{ width: 56 }} value={d.code} placeholder="A"
                    aria-label="Class code" onChange={(e) => upd(i, { code: e.target.value })} />
                </th>
                <td>
                  <input className="np-mini-input np-mini-input--left" value={d.name} placeholder="Light hazard"
                    aria-label="Grading" onChange={(e) => upd(i, { name: e.target.value })} />
                  <input className="np-mini-input np-mini-input--left ret-class-desc" value={d.description}
                    placeholder="What this class covers" aria-label="Description"
                    onChange={(e) => upd(i, { description: e.target.value })} />
                </td>
                <td>
                  <input className="np-mini-input" style={{ width: 72 }} value={d.pct} placeholder="75"
                    inputMode="decimal" aria-label="% of capacity"
                    onChange={(e) => upd(i, { pct: e.target.value.replace(/[^0-9.]/g, '') })} />
                </td>
                <td>
                  <textarea className="np-mini-input np-mini-input--left ret-class-textarea" rows={3}
                    value={d.terms} placeholder="warehouse, light industry, workshop"
                    aria-label="Typical occupancies"
                    onChange={(e) => upd(i, { terms: e.target.value })} />
                </td>
                <td>
                  <button type="button" className="renew-x" aria-label={`Remove class ${d.code || i + 1}`}
                    onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}>✕</button>
                </td>
              </tr>
            ))}
            {editing && drafts.length === 0 && (
              <tr><td colSpan="5" className="muted" style={{ padding: 12 }}>No classes — add one.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="np-struct-card-hint" style={{ marginTop: 8 }}>
        {editing
          ? 'Codes are what a retention row carries; the occupancies are the terms auto-detect matches against, comma separated. Saving replaces the table for everyone.'
          : 'The standard grading. Auto-detect reads each occupancy category against these terms and writes back the class and its % of capacity; an unrecognised occupancy is left alone rather than guessed at. Percentages stay editable per row.'}
      </div>
    </div>
  );
}
