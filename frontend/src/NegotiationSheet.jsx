import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { StructCard, PROP_TYPES } from './StructureSections.jsx';
import { useRefData } from './RefData.jsx';
import {
  REINSTATEMENT_OPTIONS, reinstatementLabel, LAYER_TYPES, str, numOrNull, clean, fmt,
  columnsFor, wasLabel, moved, movedColumns, rolOf, valuesFrom, originalOf, termPayload,
} from './negotiationTerms.js';
import { QuoteKindToggle } from './QuoteKind.jsx';

/*
 * Capture a quote, market by market.
 *
 * Pick a market and the structures it was sent come through ready to price —
 * a row per layer, or the terms as a whole for a proportional structure, with
 * every column of the structure carried across and open to be changed. An
 * underwriter rarely takes a layer exactly as sent: the rate moves, the
 * reinstatements change, an AAD appears, the cover narrows to risk only. So
 * each cell starts at what was sent and is marked the moment it moves, with
 * what it moved from kept beside it.
 *
 * Tick "Not quoted" against a structure the underwriter passed on, and the
 * whole structure is answered with a decline. Switch a structure to
 * "Indicative" when what came back is an indication rather than a lead
 * quote: the kind is the structure's, and every line it prices carries it.
 *
 * A market — usually the lead — may come back with a structure of its own
 * instead. "Add an alternative structure" is where that is entered: it starts
 * as a copy of the structure it replaces, since a counter-structure is nearly
 * always a variation on what was sent rather than a blank sheet.
 */

/** What the cedant asked for on this line, to price against. */
function asked(line) {
  const a = line.asked || {};
  const bits = line.basis === 'PROP'
    ? [a.commission_pct != null ? `${a.commission_pct}% comm` : '', a.epi != null ? `EPI ${fmt(a.epi)}` : '']
    : [a.premium != null ? fmt(a.premium) : '', a.rate_pct != null ? `${a.rate_pct}%` : ''];
  return bits.filter(Boolean).join(' · ') || '—';
}

function lineDetail(line) {
  if (line.basis === 'PROP') return line.capacity ? `capacity ${fmt(line.capacity)}` : '';
  if (line.limit == null) return '';
  return line.attachment ? `${fmt(line.limit)} xs ${fmt(line.attachment)}` : fmt(line.limit);
}

/**
 * One line of the sheet. Starts at the terms as sent — accepting a layer as it
 * stands is the common answer, and should take no typing.
 */
function lineFromApi(l) {
  const sent = l.terms || {};
  const q = l.quote;
  return {
    layer_index: l.layer_index,
    label: l.label,
    detail: lineDetail(l),
    asked: asked(l),
    basis: l.basis,
    // The terms this line is read against: the snapshot the quote was captured
    // on where there is one, else the structure as it stands now.
    original: originalOf(sent, q),
    ...valuesFrom(sent, q),
    line_pct: str(q?.line_pct ?? ''),
    validity: q?.validity ? String(q.validity).slice(0, 10) : '',
    notes: q?.notes || '',
  };
}

/** A sheet entry, as the form holds it. */
const entryFromApi = (s) => ({
  key: s.source === 'market' ? `m-${s.id}` : `s-${s.index}`,
  source: s.source,
  index: s.index,
  id: s.id,
  label: s.label,
  basis: s.basis,
  notes: s.notes || '',
  declined: s.declined,
  indicative: !!s.indicative,
  contact_id: s.lines.map((l) => l.quote?.contact_id).find(Boolean) || '',
  lines: s.lines.map(lineFromApi),
});

const blankLine = (i, basis) => ({
  layer_index: basis === 'PROP' ? null : i,
  label: basis === 'PROP' ? 'Terms' : `Layer ${i + 1}`,
  detail: '', asked: '—', basis, original: {},
  layer_name: basis === 'PROP' ? 'Terms' : `Layer ${i + 1}`,
  layer_type: basis === 'PROP' ? '' : 'XoL',
  limit_amt: '', attachment: '', reinstatements: '', reinstatement_pct: '',
  egnpi: '', rate_pct: '', commission_pct: '', aad: '', order_pct: '', premium: '',
  risk_cover: true, cat_cover: true,
  line_pct: '', validity: '', notes: '',
});

/**
 * An alternative structure starts as a copy of the one it replaces: a
 * counter-structure is a variation on what was sent far more often than it is
 * something new, so the broker edits rather than retypes.
 */
function alternativeFrom(source, n) {
  const base = source
    ? {
      basis: source.basis,
      lines: source.lines.map((l, i) => ({
        ...blankLine(i, source.basis),
        ...l,
        // It is the market's structure now — nothing to read it against.
        original: {},
        line_pct: '', validity: '', notes: '',
      })),
    }
    : { basis: 'NP', lines: [blankLine(0, 'NP')] };
  return {
    key: `new-${n}`,
    source: 'market',
    id: null,
    label: source ? `Alternative to ${source.label}` : `Market structure ${n}`,
    treatyType: 'Quota Share',
    qsLimit: '',
    notes: '',
    declined: false,
    indicative: false,
    contact_id: source?.contact_id || '',
    ...base,
  };
}

/** Turn the form back into what the sheet endpoint takes. */
function toPayload(entries) {
  return entries.map((e) => {
    const lines = e.lines.map((l) => ({
      layer_index: l.layer_index,
      contact_id: e.contact_id || null,
      ...termPayload(l),
      line_pct: numOrNull(l.line_pct),
      validity: l.validity || null,
      notes: l.notes.trim() || null,
    }));
    if (e.source === 'sent') return { structure_index: e.index, declined: e.declined, indicative: e.indicative, lines };
    return {
      market_structure: {
        ...(e.id ? { id: e.id } : {}),
        label: e.label.trim() || 'Market structure',
        basis: e.basis,
        structure: e.basis === 'PROP'
          ? {
            prop: {
              treatyType: e.treatyType || 'Quota Share',
              qsLimit: numOrNull(e.qsLimit) ?? '',
              commissionPct: numOrNull(e.lines[0]?.commission_pct) ?? '',
              // A proportional treaty's EPI is its premium — there is no
              // separate base to rate against, so `premium` carries it.
              epi: numOrNull(e.lines[0]?.premium) ?? '',
            },
          }
          : {
            layers: e.lines.map((l, i) => {
              const t = termPayload(l);
              return {
                name: t.layer_name || `Layer ${i + 1}`,
                type: t.layer_type || 'XoL',
                limit: t.limit_amt,
                attachment: t.attachment,
                reinstatements: t.reinstatements,
                reinstatement_pct: t.reinstatement_pct,
                egnpi: t.egnpi,
                rate_pct: t.rate_pct,
                aad: t.aad,
                order_pct: t.order_pct,
                premium: t.premium,
                risk_cover: t.risk_cover,
                cat_cover: t.cat_cover,
              };
            }),
          },
        notes: e.notes.trim() || null,
      },
      declined: e.declined,
      indicative: e.indicative,
      lines,
    };
  });
}

function Num({ value, onChange, placeholder, disabled, width, label }) {
  return (
    <input className="np-mini-input" inputMode="decimal" aria-label={label}
      value={value ?? ''} placeholder={placeholder} disabled={disabled}
      style={width ? { width } : undefined}
      onChange={(e) => onChange(clean(e.target.value))} />
  );
}

/** One editable term cell, marked and annotated the moment it moves. */
function TermCell({ col, line, disabled, currency, onChange }) {
  const changed = !disabled && moved(col, line, line.original);
  const from = line.original?.[col.key] ?? null;
  const title = changed ? `Sent as ${wasLabel(col.kind, from)}` : undefined;
  const cls = changed ? 'neg-term is-changed' : 'neg-term';

  const control = () => {
    if (col.kind === 'flag') {
      return (
        <input type="checkbox" className="np-check" disabled={disabled}
          checked={line[col.key] !== false} aria-label={col.label}
          onChange={(e) => onChange({ [col.key]: e.target.checked })} />
      );
    }
    if (col.kind === 'type') {
      return (
        <select className="np-mini-input" value={line[col.key] || ''} disabled={disabled} aria-label="Type"
          onChange={(e) => onChange({ [col.key]: e.target.value })}>
          <option value="">—</option>
          {LAYER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      );
    }
    if (col.kind === 'reinstatements') {
      return (
        <select className="np-mini-input" value={line[col.key] || ''} disabled={disabled} aria-label="Reinstatements"
          onChange={(e) => onChange({ [col.key]: e.target.value })}>
          <option value="">—</option>
          {REINSTATEMENT_OPTIONS.map((n) => <option key={n} value={n}>{reinstatementLabel(n)}</option>)}
        </select>
      );
    }
    if (col.kind === 'text') {
      return (
        <input className="np-mini-input np-mini-input--left" value={line[col.key]} disabled={disabled}
          aria-label={col.label} onChange={(e) => onChange({ [col.key]: e.target.value })} />
      );
    }
    return (
      <Num value={line[col.key]} disabled={disabled} label={col.label}
        placeholder={col.currency ? currency : col.kind === 'pct' ? '%' : ''}
        onChange={(v) => onChange({ [col.key]: v })} />
    );
  };

  return (
    <td className={cls} title={title}>
      {control()}
      {changed && <span className="neg-term-was">was {wasLabel(col.kind, from)}</span>}
    </td>
  );
}

export default function NegotiationSheet({ markets, currency, onSaved, focusStructure, onFocused }) {
  // A market's own proportional structure is typed from the Treaty Detail's
  // proportional treaty types.
  const ref = useRefData();
  const propTypeNames = (ref.treatyTypes || []).filter((t) => t.category === 'PROPORTIONAL').map((t) => t.name);
  if (propTypeNames.length === 0) propTypeNames.push(...PROP_TYPES);
  const [marketId, setMarketId] = useState('');
  const [entries, setEntries] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback((id) => {
    // Clear first: anything waiting on this market's sheet must not land on
    // the last market's entries while the new ones are on their way.
    setEntries(null);
    if (!id) return;
    setError(null);
    setNote(null);
    api('GET', `/negotiations/${id}/sheet`)
      .then((sheet) => setEntries(sheet.structures.map(entryFromApi)))
      .catch(setError);
  }, []);

  useEffect(() => load(marketId), [marketId, load]);

  // The reinsurer's underwriters, to say who actually gave the terms.
  const market = markets.find((m) => m.id === marketId);
  useEffect(() => {
    if (!market?.market_id) { setContacts([]); return; }
    api('GET', `/markets/${market.market_id}/contacts`)
      .then((rows) => setContacts(rows.filter((c) => c.active)))
      .catch(() => setContacts([]));
  }, [market?.market_id]);

  // "Alternative structure" on a board card, or "Different structure quoted"
  // on a reinsurer's card, lands here: switch to that market, then — once its
  // sheet is in — seed the market's own structure and scroll to it. With no
  // structure named (or `mode: 'open'`) it just opens the market.
  const [pending, setPending] = useState(null);
  const cardRef = useRef(null);

  useEffect(() => {
    if (!focusStructure?.negotiationId) return;
    setPending(focusStructure);
    setMarketId(focusStructure.negotiationId);
  }, [focusStructure]);

  useEffect(() => {
    if (!pending || !entries) return;
    if (pending.mode === 'alt') {
      // From the structure it varies when one was named; from nothing otherwise.
      const source = pending.structureIndex == null
        ? null
        : entries.find((e) => e.source === 'sent' && e.index === pending.structureIndex) || null;
      setEntries((es) => [
        ...es,
        alternativeFrom(source, es.filter((e) => e.source === 'market').length + 1),
      ]);
    }
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setPending(null);
    // Consumed: the page forgets it, so remounting the sheet does not replay it.
    onFocused?.();
  }, [pending, entries, onFocused]);

  const updEntry = (key, patch) => setEntries((es) => es.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  const updLine = (key, i, patch) => setEntries((es) => es.map((e) => (e.key === key
    ? { ...e, lines: e.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }
    : e)));

  function setBasis(entry, basis) {
    updEntry(entry.key, { basis, lines: [blankLine(0, basis)] });
  }

  // Blank: this button has no structure in view. The board's per-structure
  // "Alternative structure" is the one that starts from what was sent.
  function addAlternative() {
    setEntries((es) => [...es, alternativeFrom(null, es.filter((e) => e.source === 'market').length + 1)]);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api('PUT', `/negotiations/${marketId}/sheet`, { structures: toPayload(entries) });
      setEntries(res.structures.map(entryFromApi));
      setNote(`Saved — ${res.written} line${res.written === 1 ? '' : 's'} recorded${res.cleared ? `, ${res.cleared} cleared` : ''}.`);
      onSaved?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function dropStructure(entry) {
    if (!entry.id) { setEntries((es) => es.filter((e) => e.key !== entry.key)); return; }
    setBusy(true);
    try {
      await api('DELETE', `/negotiations/${marketId}/structures/${entry.id}`);
      setEntries((es) => es.filter((e) => e.key !== entry.key));
      onSaved?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <StructCard
      title="Capture a quote"
      hint="Pick a market and the structures it was sent come through ready to price, every column open to be changed. Anything the underwriter moved is marked against what was sent."
      actions={market && <span className="np-layer-count">Holding<b>v{market.pack_version ?? '—'}</b></span>}
    >
      <div ref={cardRef} />
      <div className="np-count-row" style={{ marginBottom: 12 }}>
        <label htmlFor="neg-market">Market</label>
        <select id="neg-market" className="fi" style={{ maxWidth: 320 }}
          value={marketId} onChange={(e) => setMarketId(e.target.value)}>
          <option value="">— choose a market holding the pack —</option>
          {markets.map((m) => (
            <option key={m.id} value={m.id}>
              {m.market_name} · {m.status.toLowerCase()}
            </option>
          ))}
        </select>
        {markets.length === 0 && <span className="np-count-hint">Send the pack to a market first.</span>}
      </div>

      {error && <div className="err banner">{error.message}</div>}
      {note && <div className="np-struct-notice">{note}</div>}

      {entries?.map((entry) => {
        const cols = columnsFor(entry.basis);
        const changes = entry.declined ? 0
          : entry.lines.reduce((n, l) => n + movedColumns(cols, l, l.original).length, 0);
        return (
          <div key={entry.key}
            className={`neg-sheet-block${entry.declined ? ' is-declined' : ''}`}
            id={entry.source === 'sent' ? `neg-structure-${entry.index}` : undefined}>
            <div className="neg-sheet-head">
              <div className="neg-sheet-title">
                {entry.source === 'market' ? (
                  <input className="np-mini-input np-mini-input--left" value={entry.label}
                    aria-label="Structure name" style={{ minWidth: 220 }}
                    onChange={(e) => updEntry(entry.key, { label: e.target.value })} />
                ) : (
                  <b>{entry.label}</b>
                )}
                <span className="neg-sheet-basis">
                  {entry.source === 'market' ? (
                    <span className="np-type-pills">
                      {['NP', 'PROP'].map((b) => (
                        <button key={b} type="button" className={`np-type-pill${entry.basis === b ? ' is-on' : ''}`}
                          onClick={() => setBasis(entry, b)}>
                          {b === 'NP' ? 'Non-Proportional' : 'Proportional'}
                        </button>
                      ))}
                    </span>
                  ) : (entry.basis === 'PROP' ? 'proportional' : 'non-proportional')}
                </span>
                {entry.source === 'market' && <span className="td-card-tag">alternative</span>}
                {changes > 0 && (
                  <span className="neg-change-tag" title="Columns the underwriter moved off what was sent">
                    {changes} changed
                  </span>
                )}
              </div>
              <div className="toolbar">
                <QuoteKindToggle kind={entry.indicative ? 'indicative' : 'lead'} disabled={entry.declined}
                  label={`${entry.label}: lead quote or indication`}
                  onChange={(kind) => updEntry(entry.key, { indicative: kind === 'indicative' })} />
                <label className="neg-declined" title="The underwriter would not quote this structure">
                  <input type="checkbox" checked={entry.declined}
                    onChange={(e) => updEntry(entry.key, { declined: e.target.checked })} />
                  Not quoted
                </label>
                {entry.source === 'market' && (
                  <button type="button" className="renew-x" aria-label={`Remove ${entry.label}`}
                    onClick={() => dropStructure(entry)}>✕</button>
                )}
              </div>
            </div>

            <div className="neg-sheet-terms">
              <label className="fr"><div className="fr-label">Underwriter</div>
                <select className="fi" value={entry.contact_id}
                  onChange={(e) => updEntry(entry.key, { contact_id: e.target.value })}>
                  <option value="">— not recorded —</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.role ? ` · ${c.role}` : ''}</option>
                  ))}
                </select>
                {contacts.length === 0 && (
                  <div className="np-count-hint">
                    No contacts on this reinsurer yet — add them on the Markets register.
                  </div>
                )}
              </label>
              {entry.source === 'market' && entry.basis === 'PROP' && (
                <label className="fr"><div className="fr-label">Treaty type</div>
                  <select className="fi" value={entry.treatyType}
                    onChange={(e) => updEntry(entry.key, { treatyType: e.target.value })}>
                    {entry.treatyType && !propTypeNames.includes(entry.treatyType) && <option>{entry.treatyType}</option>}
                    {propTypeNames.map((t) => <option key={t}>{t}</option>)}
                  </select></label>
              )}
            </div>

            <div className="np-table-wrap">
              <table className="np-struct-table neg-sheet-table">
                <thead>
                  <tr>
                    <th className="np-table-sticky">LINE</th>
                    {entry.source === 'sent' && <th>ASKED</th>}
                    {cols.map((c) => (
                      <th key={c.key}>{c.label}{c.currency ? ` (${currency})` : ''}</th>
                    ))}
                    <th title="ROL = Premium 100% ÷ Limit. Auto-computed.">ROL</th>
                    <th>LINE %</th>
                    <th>VALID TO</th>
                    <th>NOTES</th>
                    {entry.source === 'market' && entry.basis === 'NP' && <th />}
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((line, i) => (
                    <tr key={`${entry.key}-${i}`}>
                      <th className="np-table-sticky neg-sheet-line">
                        <span className="np-layer-badge">{line.layer_index == null ? 'T' : line.layer_index + 1}</span>
                        <span className="neg-line-label">{line.label}
                          <span className="neg-line-detail">{line.detail}</span>
                        </span>
                      </th>
                      {entry.source === 'sent' && <td className="muted small">{line.asked}</td>}
                      {cols.map((c) => (
                        <TermCell key={c.key} col={c} line={line} currency={currency}
                          disabled={entry.declined}
                          onChange={(patch) => updLine(entry.key, i, patch)} />
                      ))}
                      <td>
                        <input className="np-mini-input np-mini-input--readonly" readOnly
                          aria-label="ROL" value={rolOf(line)} placeholder="—" />
                      </td>
                      <td><Num value={line.line_pct} disabled={entry.declined} placeholder="line" width={78} label="Line %"
                        onChange={(v) => updLine(entry.key, i, { line_pct: v })} /></td>
                      <td>
                        <input className="np-mini-input" type="date" value={line.validity} disabled={entry.declined}
                          aria-label="Valid to" onChange={(e) => updLine(entry.key, i, { validity: e.target.value })} />
                      </td>
                      <td>
                        <input className="np-mini-input np-mini-input--left" value={line.notes}
                          placeholder={entry.declined ? 'Why they passed' : 'Subjectivities'} aria-label="Notes"
                          onChange={(e) => updLine(entry.key, i, { notes: e.target.value })} />
                      </td>
                      {entry.source === 'market' && entry.basis === 'NP' && (
                        <td>
                          <button type="button" className="renew-x" aria-label={`Remove layer ${i + 1}`}
                            disabled={entry.lines.length === 1}
                            onClick={() => updEntry(entry.key, {
                              lines: entry.lines.filter((_, j) => j !== i).map((l, j) => ({ ...l, layer_index: j })),
                            })}>✕</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {entry.source === 'market' && entry.basis === 'NP' && (
              <div className="toolbar" style={{ marginTop: 8 }}>
                <button type="button" className="np-struct-btn"
                  onClick={() => updEntry(entry.key, { lines: [...entry.lines, blankLine(entry.lines.length, 'NP')] })}>
                  ＋ Add layer
                </button>
              </div>
            )}
          </div>
        );
      })}

      {entries && (
        <div className="neg-sheet-actions">
          <button type="button" className="np-struct-btn" disabled={busy} onClick={addAlternative}>
            ＋ Add an alternative structure
          </button>
          <div className="toolbar">
            <button type="button" className="np-struct-btn" disabled={busy} onClick={() => load(marketId)}>Reset</button>
            <button type="button" className="np-green-pill" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : `Save ${market?.market_name || 'quote'}`}
            </button>
          </div>
        </div>
      )}
    </StructCard>
  );
}
