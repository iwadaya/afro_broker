import React, { useState } from 'react';
import { StructCard } from './StructureSections.jsx';
import { wasLabel } from './negotiationTerms.js';
import { pct, day, lineDetail, quoteHeadline, quoteDetail } from './NegotiationBoard.jsx';
import { QuoteKindToggle, IndicativeTag } from './QuoteKind.jsx';

/*
 * The quotes, by reinsurer.
 *
 * One card per reinsurer holding the pack: every structure it has quoted —
 * the ones it was sent, and any it put up itself in their place — line by
 * line, with what it moved off the terms as sent. A structure it has not
 * answered yet is listed as awaited, so what is still outstanding is in view
 * beside what has come in. "Different structure quoted" is where a
 * reinsurer's own structure is entered: it lands on the capture sheet for
 * that market, starting from the structure it varies or from a blank sheet.
 *
 * Each structure a reinsurer has priced is a lead quote or an indication —
 * the switch on the structure says which, and an indication is marked on
 * every line it covers.
 */

/** What the reinsurer moved off the terms it was sent, in a few words. */
function Moved({ quote }) {
  const v = quote.variance || [];
  if (!v.length) return <span className="muted small">as sent</span>;
  return (
    <span className="neg-change-tag" title={v.map((x) => `${x.label}: ${wasLabel(x.kind, x.from)} → ${wasLabel(x.kind, x.to)}`).join('\n')}>
      {v.length} changed
    </span>
  );
}

/**
 * How a market's answer on a structure reads: an indication when every line
 * it priced is one, a lead quote otherwise. A structure with nothing priced
 * (awaited, or declined outright) has no kind to switch.
 */
export function kindOf(lines) {
  const priced = lines.filter((l) => l.quote?.status === 'quoted');
  if (!priced.length) return null;
  return priced.every((l) => l.quote.kind === 'indicative') ? 'indicative' : 'lead';
}

/**
 * The structures one market has answered, and those it still owes.
 *
 * A structure that was sent is answered by any market; one a market put up is
 * its own alone. A line is answered when this market has a quote on it.
 */
export function structuresFor(board, market) {
  const answered = [];
  const awaited = [];
  for (const structure of board) {
    if (structure.source === 'market' && structure.negotiation_id !== market.id) continue;
    const lines = structure.lines.map((line) => ({
      line,
      quote: line.quotes.find((q) => q.negotiation_id === market.id) || null,
    }));
    const entry = { structure, lines, kind: kindOf(lines) };
    if (structure.source === 'market' || lines.some((l) => l.quote)) answered.push(entry);
    else awaited.push(entry);
  }
  return { answered, awaited };
}

/** Start a reinsurer's own structure: from one it was sent, or from nothing. */
function DifferentStructure({ market, structures, onPick }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="np-struct-btn np-struct-btn--accent" data-testid="different-structure"
        title="The reinsurer quoted a structure other than the ones it was sent — enter it"
        onClick={() => setOpen(true)}>
        ＋ Different structure quoted
      </button>
    );
  }
  return (
    <select className="np-mini-input" value="" aria-label={`Different structure quoted by ${market.market_name}`}
      onChange={(e) => {
        if (!e.target.value) return;
        onPick(e.target.value === 'blank' ? null : Number(e.target.value));
        setOpen(false);
      }}>
      <option value="">— start from —</option>
      {structures.map((s) => <option key={s.index} value={s.index}>A variation on {s.label}</option>)}
      <option value="blank">A blank structure</option>
    </select>
  );
}

/**
 * @param onEdit(line, market, quote)         open the quote form on one line
 * @param onKind(market, structure, kind)     mark the market's answer on a structure lead or indicative
 * @param onDifferent(marketId, structureIndex) enter the market's own structure on the sheet
 * @param onOpenSheet(marketId)                open the market on the capture sheet
 */
export default function NegotiationQuotes({ data, currency, canEdit, onEdit, onKind, onDifferent, onOpenSheet }) {
  const sent = data.board.filter((s) => s.source !== 'market');

  if (!data.markets.length) {
    return (
      <StructCard title="Quotes by reinsurer" hint="Every reinsurer holding the pack, with the structures it quoted.">
        <div className="muted" data-testid="neg-by-reinsurer-empty">
          Nobody holds the pack yet — send it from the Email tab, and each reinsurer's quotes are collected here.
        </div>
      </StructCard>
    );
  }

  return (
    <div className="neg-by-reinsurer" data-testid="neg-by-reinsurer">
      {data.markets.map((m) => {
        const { answered, awaited } = structuresFor(data.board, m);
        const own = answered.filter((a) => a.structure.source === 'market').length;
        const sentAnswered = answered.length - own;
        return (
          <StructCard
            key={m.id}
            title={m.market_name}
            hint={`Holding pack v${m.pack_version ?? '—'} · quoted ${sentAnswered} of ${sent.length} structure${sent.length === 1 ? '' : 's'} sent${own ? ` · ${own} of its own` : ''}`}
            actions={(
              <div className="toolbar">
                <span className={`neg-standing neg-standing--${m.status.toLowerCase()}`}>{m.status}</span>
                {canEdit && (
                  <>
                    <DifferentStructure market={m} structures={sent} onPick={(index) => onDifferent(m.id, index)} />
                    <button type="button" className="np-struct-btn" onClick={() => onOpenSheet(m.id)}
                      title="Price every structure this market was sent, on one sheet">
                      Open on the sheet
                    </button>
                  </>
                )}
              </div>
            )}
          >
            <div className="np-table-wrap">
              <table className="np-struct-table neg-rx-table">
                <thead>
                  <tr>
                    <th className="np-table-sticky">Structure</th>
                    <th>Line</th>
                    <th>Quoted</th>
                    <th>Terms</th>
                    <th>Line %</th>
                    <th>Valid to</th>
                    <th>Underwriter</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {answered.map(({ structure, lines, kind }) => lines.map(({ line, quote }, i) => (
                    <tr key={`${structure.source === 'market' ? structure.id : structure.index}:${line.layer_index ?? 'prop'}`}
                      className={quote?.status === 'declined' ? 'is-declined' : ''}>
                      {i === 0 && (
                        <th className="np-table-sticky neg-rx-structure" rowSpan={lines.length}>
                          {structure.label}
                          <span className="neg-line-detail">
                            {structure.basis === 'PROP' ? 'proportional' : 'non-proportional'}
                            {structure.source === 'market' ? ' · its own structure' : ''}
                          </span>
                          {/* Lead quote or indication: the market's answer on
                              this structure as a whole. Nothing to switch
                              until it has priced a line. */}
                          {kind && (canEdit
                            ? (
                              <QuoteKindToggle kind={kind} size="mini"
                                label={`${m.market_name} on ${structure.label}: lead quote or indication`}
                                onChange={(next) => onKind(m, structure, next)} />
                            )
                            : <IndicativeTag kind={kind} />)}
                        </th>
                      )}
                      <td className="neg-rx-line">
                        <span className="np-layer-badge">{line.layer_index == null ? 'T' : line.layer_index + 1}</span>
                        <span className="neg-line-label">{line.label}
                          <span className="neg-line-detail">{lineDetail(line)}</span>
                        </span>
                      </td>
                      <td>
                        {!quote ? (
                          canEdit
                            ? <button type="button" className="neg-cell neg-cell--empty" onClick={() => onEdit(line, m, null)}>Quote</button>
                            : <span className="muted">—</span>
                        ) : quote.status === 'declined' ? (
                          <button type="button" className="neg-cell neg-cell--declined" disabled={!canEdit} onClick={() => onEdit(line, m, quote)}>Declined</button>
                        ) : (
                          <button type="button" className="neg-cell neg-cell--quoted" disabled={!canEdit} onClick={() => onEdit(line, m, quote)}>
                            <span className="neg-cell-head">{quoteHeadline(quote, line, currency)}</span>
                            <span className="neg-cell-sub">{quoteDetail(quote, line)}</span>
                            <IndicativeTag quote={quote} className="neg-kind-tag--cell" />
                          </button>
                        )}
                      </td>
                      <td>{quote && quote.status !== 'declined' ? <Moved quote={quote} /> : <span className="muted">—</span>}</td>
                      <td>{quote?.line_pct != null ? pct(quote.line_pct) : '—'}</td>
                      <td className="small">{quote?.validity ? day(quote.validity) : '—'}</td>
                      <td className="small">{quote?.contact_name || '—'}</td>
                      <td className="small muted">{quote?.notes || '—'}</td>
                    </tr>
                  )))}
                  {awaited.map(({ structure, lines }) => (
                    <tr key={`awaited-${structure.index}`} className="is-awaited">
                      <th className="np-table-sticky neg-rx-structure">
                        {structure.label}
                        <span className="neg-line-detail">{structure.basis === 'PROP' ? 'proportional' : 'non-proportional'}</span>
                      </th>
                      <td className="muted small">{lines.length} line{lines.length === 1 ? '' : 's'}</td>
                      <td>
                        {canEdit
                          ? <button type="button" className="neg-cell neg-cell--empty" onClick={() => onEdit(lines[0].line, m, null)}>Quote</button>
                          : <span className="muted">awaited</span>}
                      </td>
                      <td className="muted small" colSpan={5}>Awaited — nothing back from {m.market_name} on this structure yet.</td>
                    </tr>
                  ))}
                  {answered.length === 0 && awaited.length === 0 && (
                    <tr><td colSpan={8} className="muted">Nothing to quote — add a structure on the Structure tab.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </StructCard>
        );
      })}
    </div>
  );
}
