import React, { useEffect, useState } from 'react';
import { StructCard } from './StructureSections.jsx';
import {
  REINSTATEMENT_OPTIONS, reinstatementLabel, LAYER_TYPES, str, numOrNull, clean,
  columnsFor, wasLabel, moved, movedColumns, rolOf, valuesFrom, originalOf, termPayload,
} from './negotiationTerms.js';
import { QuoteKindToggle, IndicativeTag } from './QuoteKind.jsx';

/*
 * The board, by structure.
 *
 * One card per structure that went out (and per structure a market put up in
 * its place): its lines down the side — a layer each for a non-proportional
 * structure, the terms as a whole for a proportional one — and one column per
 * market holding the pack. Each cell is what that market said about that
 * line, and the quote form captures it.
 */

export const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n))
  ? '—'
  : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
export const pct = (n) => (n == null || n === '' ? '—' : `${fmt(n)}%`);
export const day = (d) => (d ? String(d).slice(0, 10) : '');

/** "5,000,000 xs 1,000,000", or the capacity of a proportional structure. */
export function lineDetail(line) {
  if (line.basis === 'PROP') return line.capacity ? `capacity ${fmt(line.capacity)}` : '';
  if (line.limit == null) return '';
  return line.attachment ? `${fmt(line.limit)} xs ${fmt(line.attachment)}` : fmt(line.limit);
}

/** What the cedant asked for on this line, to read a quote against. */
export function askedDetail(line) {
  const asked = line.asked || {};
  if (line.basis === 'PROP') {
    return [
      asked.commission_pct != null ? `${asked.commission_pct}% commission` : '',
      asked.epi != null ? `EPI ${fmt(asked.epi)}` : '',
    ].filter(Boolean).join(' · ');
  }
  return [
    asked.premium != null ? `premium ${fmt(asked.premium)}` : '',
    asked.rate_pct != null ? `rate ${asked.rate_pct}%` : '',
  ].filter(Boolean).join(' · ');
}

/** The headline of a quote: its price, as the cells and the reinsurer cards read it. */
export function quoteHeadline(quote, line, currency) {
  if (line.basis === 'PROP') return `${pct(quote.commission_pct)} comm`;
  return quote.premium != null ? `${currency} ${fmt(quote.premium)}` : pct(quote.rate_pct);
}

/** The second line of a quote: EPI for a proportional line, rate and line for a layer. */
export function quoteDetail(quote, line) {
  if (line.basis === 'PROP') return quote.premium != null ? `EPI ${fmt(quote.premium)}` : '';
  return [quote.rate_pct != null ? `${quote.rate_pct}% rate` : '', quote.line_pct != null ? `${quote.line_pct}% line` : '']
    .filter(Boolean).join(' · ');
}

/** The quote a market gave on a line, as the cell shows it. */
function QuoteCell({ quote, line, currency, canEdit, onEdit }) {
  if (!quote) {
    return canEdit
      ? <button type="button" className="neg-cell neg-cell--empty" onClick={onEdit}>Quote</button>
      : <span className="muted">—</span>;
  }
  if (quote.status === 'declined') {
    return (
      <button type="button" className="neg-cell neg-cell--declined" disabled={!canEdit} onClick={onEdit}>
        Declined{quote.notes ? <span className="neg-cell-note">{quote.notes}</span> : null}
      </button>
    );
  }
  return (
    <button type="button" className="neg-cell neg-cell--quoted" disabled={!canEdit} onClick={onEdit}>
      <span className="neg-cell-head">{quoteHeadline(quote, line, currency)}</span>
      <span className="neg-cell-sub">{quoteDetail(quote, line)}</span>
      {quote.variance?.length > 0 && (
        <span className="neg-change-tag neg-change-tag--cell"
          title={quote.variance.map((v) => `${v.label}: ${wasLabel(v.kind, v.from)} → ${wasLabel(v.kind, v.to)}`).join('\n')}>
          {quote.variance.length} changed
        </span>
      )}
      {quote.validity && <span className="neg-cell-note">valid to {day(quote.validity)}</span>}
      <IndicativeTag quote={quote} className="neg-kind-tag--cell" />
    </button>
  );
}

/* ------------------------------------------------------ the quote form */

/**
 * Capture what a market said about one line.
 *
 * The whole layer is quotable, not just its price: an underwriter rarely takes
 * a layer exactly as it was sent. Every column starts at what was sent — so
 * accepting it as it stands takes no typing — and is marked against that the
 * moment it moves.
 */
export function QuoteEditor({ open, line, market, currency, contacts, onSave, onClear, onClose, busy }) {
  const [form, setForm] = useState({});

  useEffect(() => {
    if (!open) return;
    const q = open.quote;
    const sent = line?.terms || {};
    setForm({
      original: originalOf(sent, q),
      status: q?.status || 'quoted',
      // A lead quote unless it was captured as an indication.
      kind: q?.kind === 'indicative' ? 'indicative' : 'lead',
      contact_id: q?.contact_id || '',
      ...valuesFrom(sent, q),
      line_pct: str(q?.line_pct ?? ''),
      validity: day(q?.validity),
      notes: q?.notes || '',
    });
  }, [open, line]);

  if (!open || !form.status) return null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const quoted = form.status === 'quoted';
  const cols = columnsFor(line.basis);
  const changed = quoted ? movedColumns(cols, form, form.original) : [];

  const control = (col) => {
    if (col.kind === 'flag') {
      return (
        <input type="checkbox" className="np-check" checked={form[col.key] !== false}
          aria-label={col.label} onChange={(e) => set({ [col.key]: e.target.checked })} />
      );
    }
    if (col.kind === 'type' || col.kind === 'reinstatements') {
      const options = col.kind === 'type' ? LAYER_TYPES : REINSTATEMENT_OPTIONS;
      return (
        <select className="fi" value={form[col.key] || ''} aria-label={col.label}
          onChange={(e) => set({ [col.key]: e.target.value })}>
          <option value="">—</option>
          {options.map((t) => (
            <option key={t} value={t}>{col.kind === 'reinstatements' ? reinstatementLabel(t) : t}</option>
          ))}
        </select>
      );
    }
    if (col.kind === 'text') {
      return (
        <input className="fi" value={form[col.key]} aria-label={col.label}
          onChange={(e) => set({ [col.key]: e.target.value })} />
      );
    }
    return (
      <input className="fi" inputMode="decimal" value={form[col.key]} aria-label={col.label}
        onChange={(e) => set({ [col.key]: clean(e.target.value) })} />
    );
  };

  return (
    <div className="neg-editor-backdrop" role="dialog" aria-label="Capture quote">
      <div className="neg-editor neg-editor--wide">
        <div className="neg-editor-head">
          <div>
            <div className="np-struct-card-h2">{market.market_name}</div>
            <div className="np-struct-card-hint">
              {line.structure_index ? `Structure ${line.structure_index} · ` : ''}{line.label}
              {lineDetail(line) ? ` — ${lineDetail(line)}` : ''}
            </div>
          </div>
          <button type="button" className="renew-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <div className="neg-editor-body">
          <label className="neg-declined neg-notquoted" title="The underwriter would not quote this line">
            <input type="checkbox" checked={!quoted}
              onChange={(e) => set({ status: e.target.checked ? 'declined' : 'quoted' })} />
            Not quoted
          </label>

          {quoted && (
            <div className="neg-editor-kind" title="A lead quote the placement can be built on, or an indication only">
              <span>What the underwriter gave</span>
              <QuoteKindToggle kind={form.kind} label="Lead quote or indication"
                onChange={(kind) => set({ kind })} />
            </div>
          )}

          <label className="fr"><div className="fr-label">Underwriter</div>
            <select className="fi" value={form.contact_id}
              onChange={(e) => set({ contact_id: e.target.value })}>
              <option value="">— not recorded —</option>
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.role ? ` · ${c.role}` : ''}</option>
              ))}
            </select>
            {contacts.length === 0 && (
              <div className="np-count-hint">No contacts on this reinsurer yet — add them on the Markets register.</div>
            )}
          </label>

          {quoted && (
            <>
              {changed.length > 0 && (
                <div className="np-struct-notice">
                  {changed.length} column{changed.length === 1 ? '' : 's'} moved off what was sent:{' '}
                  {changed.map((c) => c.label).join(', ')}.
                </div>
              )}
              <div className="neg-editor-grid">
                {cols.map((col) => {
                  const isMoved = moved(col, form, form.original);
                  return (
                    <label className={`fr${isMoved ? ' is-changed' : ''}`} key={col.key}>
                      <div className="fr-label">
                        {col.label}{col.currency ? ` (${currency})` : ''}
                        {isMoved && (
                          <span className="neg-term-was">
                            was {wasLabel(col.kind, form.original?.[col.key] ?? null)}
                          </span>
                        )}
                      </div>
                      {control(col)}
                    </label>
                  );
                })}
                <label className="fr"><div className="fr-label">ROL</div>
                  <input className="fi" readOnly value={rolOf(form)} placeholder="—" /></label>
                <label className="fr"><div className="fr-label">Line % offered</div>
                  <input className="fi" inputMode="decimal" value={form.line_pct}
                    onChange={(e) => set({ line_pct: clean(e.target.value) })} /></label>
                <label className="fr"><div className="fr-label">Valid to</div>
                  <input className="fi" type="date" value={form.validity}
                    onChange={(e) => set({ validity: e.target.value })} /></label>
              </div>
            </>
          )}

          <label className="fr"><div className="fr-label">Notes</div>
            <input className="fi" value={form.notes} placeholder={quoted ? 'Subjectivities, conditions' : 'Why they passed'}
              onChange={(e) => set({ notes: e.target.value })} /></label>
        </div>

        <div className="neg-editor-actions">
          {open.quote && (
            <button type="button" className="np-struct-btn" disabled={busy} onClick={onClear}>Clear quote</button>
          )}
          <div className="toolbar">
            <button type="button" className="np-struct-btn" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="np-green-pill" disabled={busy}
              onClick={() => onSave({
                // A line answers either a structure that was sent or one the
                // market put up itself — never both.
                ...(line.market_structure_id
                  ? { market_structure_id: line.market_structure_id }
                  : { structure_index: line.structure_index }),
                layer_index: line.layer_index ?? null,
                status: form.status,
                kind: form.kind,
                contact_id: form.contact_id || null,
                ...termPayload(form),
                line_pct: numOrNull(form.line_pct),
                validity: form.validity || null,
                notes: form.notes.trim() || null,
              })}>
              {busy ? 'Saving…' : 'Save quote'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Quote a structure, or take the alternative an underwriter came back with.
 *
 * Both need to know *which* market is answering, so each is a market picker
 * rather than a bare button — a structure is quoted by a reinsurer, never in
 * the abstract.
 */
function StructureQuoteActions({ structure, markets, onAddQuote, onAlternative }) {
  const [open, setOpen] = useState(null);
  // A structure a market put up is that market's alone to answer.
  const choices = structure.source === 'market'
    ? markets.filter((m) => m.id === structure.negotiation_id)
    : markets;

  if (!choices.length) return null;

  const pick = (mode) => (
    <select className="np-mini-input" value="" aria-label={mode === 'quote' ? 'Add quote for market' : 'Alternative structure for market'}
      onChange={(e) => {
        if (!e.target.value) return;
        (mode === 'quote' ? onAddQuote : onAlternative)(e.target.value);
        setOpen(null);
      }}>
      <option value="">— which market? —</option>
      {choices.map((m) => (
        <option key={m.id} value={m.id}>{m.market_name}</option>
      ))}
    </select>
  );

  // With one market there is nothing to pick — go straight there.
  const start = (mode, run) => () => {
    if (choices.length === 1) run(choices[0].id);
    else setOpen(mode);
  };

  return (
    <>
      {open === 'quote' ? pick('quote') : (
        <button type="button" className="np-struct-btn" onClick={start('quote', onAddQuote)}>
          ＋ Add quote
        </button>
      )}
      {structure.source !== 'market' && (
        open === 'alt' ? pick('alt') : (
          <button type="button" className="np-struct-btn"
            title="The underwriter quoted a different structure — enter it against this one"
            onClick={start('alt', onAlternative)}>
            ＋ Alternative structure
          </button>
        )
      )}
    </>
  );
}

/**
 * The board: every structure with every market's answer on every line.
 *
 * `onEdit(line, market, quote)` opens the quote form; `onAlternative(marketId,
 * structureIndex)` hands the sheet a counter-structure to start from.
 */
export function Board({ data, currency, canEdit, onEdit, onAlternative }) {
  const quoteFor = (line, negotiationId) => line.quotes.find((q) => q.negotiation_id === negotiationId);

  return (
    <>
      {data.board.length === 0 && (
        <StructCard title="Structures to quote"
          notice="Nothing to quote yet — add a structure on the Structure tab and the markets will price it here.">
          <div className="muted">A market quotes each layer of a non-proportional structure, and a proportional structure as a whole.</div>
        </StructCard>
      )}

      <div className="neg-board">
      {data.board.map((structure) => (
        <StructCard
          // A market's own structure is keyed by id: it has no sent index.
          key={structure.source === 'market' ? structure.id : structure.index}
          title={`${structure.label} — ${structure.basis === 'PROP' ? 'proportional' : 'non-proportional'}`}
          hint={structure.source === 'market'
            ? `${structure.market_name} came back with this instead of what it was sent.`
            : 'What each market said about each line of this structure.'}
          actions={(
            <div className="toolbar">
              <span className="np-layer-count">Lines<b>{structure.lines.length}</b></span>
              {canEdit && data.markets.length > 0 && (
                <StructureQuoteActions
                  structure={structure}
                  markets={data.markets}
                  onAddQuote={(marketId) => {
                    const m = data.markets.find((mk) => mk.id === marketId);
                    // Straight into the form on this structure's first line.
                    onEdit(structure.lines[0], m, quoteFor(structure.lines[0], marketId));
                  }}
                  onAlternative={(marketId) => onAlternative(marketId, structure.index)}
                />
              )}
            </div>
          )}
          footnote="A cell is one market's answer on one line. Best premium and rate are the keenest quoted so far; line % is what has been offered in total. A quote marked “changed” moved columns off what was sent — hover it to see which. One marked “indicative” is an indication, not a lead quote — switch it on the reinsurer's card."
        >
          <div className="np-table-wrap">
            <table className="np-struct-table neg-table">
              <thead>
                <tr>
                  <th className="np-table-sticky">Line</th>
                  <th>Asked</th>
                  <th>Best</th>
                  {data.markets.map((m) => (
                    <th key={m.id}>
                      {m.market_name}
                      <div className="neg-market-pack">holding v{m.pack_version ?? '—'}</div>
                    </th>
                  ))}
                  {data.markets.length === 0 && <th>Markets</th>}
                </tr>
              </thead>
              <tbody>
                {structure.lines.map((line) => (
                  <tr key={`${line.structure_index}:${line.layer_index ?? 'prop'}`}>
                    <th className="np-table-sticky neg-line">
                      <span className="np-layer-badge">{line.layer_index == null ? 'T' : line.layer_index + 1}</span>
                      <span className="neg-line-label">{line.label}
                        <span className="neg-line-detail">{lineDetail(line)}</span>
                      </span>
                    </th>
                    <td className="muted small">{askedDetail(line) || '—'}</td>
                    <td className="neg-best">
                      {line.summary.quoted > 0 ? (
                        <>
                          <b>{line.basis === 'PROP'
                            ? pct(line.summary.best_commission_pct)
                            : line.summary.best_premium != null ? `${currency} ${fmt(line.summary.best_premium)}` : pct(line.summary.best_rate_pct)}</b>
                          <div className="muted small">
                            {line.summary.quoted} quoted{line.summary.indicative ? ` (${line.summary.indicative} indicative)` : ''}{line.summary.declined ? `, ${line.summary.declined} declined` : ''}
                            {line.summary.line_pct_total > 0 ? ` · ${fmt(line.summary.line_pct_total)}% offered` : ''}
                          </div>
                        </>
                      ) : <span className="muted">awaited</span>}
                    </td>
                    {data.markets.map((m) => {
                      // A structure a market put up is that market's to answer.
                      const owns = structure.source !== 'market' || structure.negotiation_id === m.id;
                      return (
                        <td key={m.id}>
                          {owns ? (
                            <QuoteCell
                              quote={quoteFor(line, m.id)}
                              line={line}
                              currency={currency}
                              canEdit={canEdit}
                              onEdit={() => onEdit(line, m, quoteFor(line, m.id))}
                            />
                          ) : <span className="muted">—</span>}
                        </td>
                      );
                    })}
                    {data.markets.length === 0 && (
                      <td className="muted small">Send the pack to a market to start quoting.</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StructCard>
      ))}
      </div>
    </>
  );
}
