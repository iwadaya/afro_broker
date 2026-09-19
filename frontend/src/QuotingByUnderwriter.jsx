import React from 'react';
import { StructCard } from './StructureSections.jsx';
import { fmt, pct, day, lineDetail } from './NegotiationBoard.jsx';
import { QuoteKindToggle, IndicativeTag } from './QuoteKind.jsx';

/*
 * The quotes by underwriter, and what they add up to.
 *
 * One card per reinsurer holding the pack. A proportional structure is quoted
 * as a whole: the reinsurer takes the structure it was sent, or puts up a
 * different one of its own, and either way its terms are kept against it. A
 * non-proportional structure is quoted layer by layer: every layer the
 * reinsurer priced, with its rate on line, and under them the programme its
 * layers add up to — premium, limit and the rate on line those make.
 *
 * Under the cards, the combined quote: every reinsurer's programme side by
 * side, and the best of the market — the keenest quote on each layer,
 * whichever reinsurer gave it, added up.
 *
 * Every structure a reinsurer has priced is a lead quote or an indication:
 * the switch in the structure's head says which, and an indication is marked
 * on its figures here and wherever else they are read.
 */

const money = (ccy, n) => (n == null ? '—' : `${ccy} ${fmt(n)}`);

/** A proportional structure: the terms as sent, and what the reinsurer said. */
function PropCapture({ s, market, currency, canEdit, onEdit, onDifferent }) {
  const { line, quote } = s.lines[0];
  const sent = line.terms || {};
  return (
    <div className="np-table-wrap">
      <table className="np-struct-table qu-prop">
        <thead>
          <tr><th>Terms as sent</th><th>Quoted</th><th>Line %</th><th>Valid to</th><th>Underwriter</th><th /></tr>
        </thead>
        <tbody>
          <tr className={quote?.status === 'declined' ? 'is-declined' : ''}>
            <td>
              {sent.layer_type || line.label}{line.capacity ? ` · capacity ${fmt(line.capacity)}` : ''}
              {line.asked?.commission_pct != null ? ` · ${line.asked.commission_pct}% commission asked` : ''}
              {line.asked?.epi != null ? ` · EPI ${fmt(line.asked.epi)}` : ''}
            </td>
            <td>
              {!quote ? <span className="muted">awaited</span>
                : quote.status === 'declined' ? <span className="neg-standing neg-standing--declined">declined</span>
                  : <><b>{pct(quote.commission_pct)}</b> commission{quote.premium != null ? ` · EPI ${fmt(quote.premium)}` : ''}{quote.variance?.length ? ` · ${quote.variance.length} term${quote.variance.length === 1 ? '' : 's'} moved` : ' · as sent'}<IndicativeTag quote={quote} className="neg-kind-tag--inline" /></>}
            </td>
            <td>{quote?.line_pct != null ? pct(quote.line_pct) : '—'}</td>
            <td className="small">{quote?.validity ? day(quote.validity) : '—'}</td>
            <td className="small">{quote?.contact_name || '—'}</td>
            <td className="right">
              {canEdit && (
                <span className="toolbar">
                  <button type="button" className="np-struct-btn" onClick={() => onEdit(line, market, quote)}>
                    {quote ? 'Edit quote' : 'Quote this structure'}
                  </button>
                  {!s.own && (
                    <button type="button" className="np-struct-btn np-struct-btn--accent" title="The reinsurer quoted a structure other than the one it was sent — capture it"
                      onClick={() => onDifferent(market.id, s.index)}>
                      Different structure
                    </button>
                  )}
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** A non-proportional structure: each layer the reinsurer answered, then the programme. */
function LayerGrid({ s, market, currency, canEdit, onEdit }) {
  const r = s.rollup;
  return (
    <div className="np-table-wrap">
      <table className="np-struct-table qu-layers" data-testid="qu-layers">
        <thead>
          <tr>
            <th className="np-table-sticky">Layer</th><th>Cover</th><th>As sent</th>
            <th>Quoted premium</th><th>ROL</th><th>Rate</th><th>Line %</th><th>Valid to</th><th />
          </tr>
        </thead>
        <tbody>
          {s.lines.map(({ line, quote }) => (
            <tr key={line.layer_index} className={quote?.status === 'declined' ? 'is-declined' : ''}>
              <th className="np-table-sticky">{line.label}</th>
              <td>{lineDetail(line)}</td>
              <td className="small">{line.asked?.premium != null ? money(currency, line.asked.premium) : '—'}{line.asked?.rate_pct != null ? ` · ${line.asked.rate_pct}%` : ''}</td>
              {!quote ? <td colSpan={5} className="muted">awaited</td>
                : quote.status === 'declined' ? <td colSpan={5}><span className="neg-standing neg-standing--declined">declined</span>{quote.notes ? <span className="neg-sub-contact">{quote.notes}</span> : null}</td>
                  : (
                    <>
                      <td><b>{money(currency, quote.terms?.premium ?? quote.premium)}</b><IndicativeTag quote={quote} className="neg-kind-tag--inline" /></td>
                      <td>{pct(quote.rol_pct, 4)}</td>
                      <td>{quote.rate_pct != null ? pct(quote.rate_pct) : '—'}</td>
                      <td>{quote.line_pct != null ? pct(quote.line_pct) : '—'}</td>
                      <td className="small">{quote.validity ? day(quote.validity) : '—'}</td>
                    </>
                  )}
              <td className="right">
                {canEdit && (
                  <button type="button" className="np-struct-btn" onClick={() => onEdit(line, market, quote)}>{quote ? 'Edit' : 'Quote'}</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        {r && (
          <tfoot>
            <tr className="qu-rollup" data-testid="qu-rollup">
              <th className="np-table-sticky">Programme</th>
              <td>{r.limit_total != null ? money(currency, r.limit_total) : '—'}</td>
              <td className="small">{r.quoted}/{r.layers} layers quoted{r.declined ? ` · ${r.declined} declined` : ''}</td>
              <td>{r.premium_total != null ? money(currency, r.premium_total) : '—'}</td>
              <td>{r.rol_pct != null ? pct(r.rol_pct, 4) : '—'}</td>
              <td />
              <td>{r.line_pct_min == null ? '—' : r.line_pct_min === r.line_pct_max ? pct(r.line_pct_min) : `${pct(r.line_pct_min)}–${pct(r.line_pct_max)}`}</td>
              <td colSpan={2} className="small">{r.complete ? 'combined quote complete' : 'combined quote incomplete'}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Every reinsurer's programme side by side, and the best of the market. */
export function CombinedQuote({ combined, currency }) {
  if (!combined?.length) return null;
  return combined.map((c) => (
    <StructCard
      key={`${c.source}:${c.index ?? c.id}`}
      title={`Combined quote — ${c.label}`}
      hint="Each reinsurer's layers added up into a programme — premium, limit and the rate on line those make — and, in the last row, the best of the market: the keenest quote on each layer, whichever reinsurer gave it."
      actions={<span className="np-layer-count">Reinsurers<b>{c.by_market.length || '—'}</b></span>}
    >
      {!c.by_market.length ? <div className="muted small">No layer quotes yet on this structure.</div> : (
        <div className="np-table-wrap">
          <table className="np-struct-table qu-combined" data-testid="qu-combined">
            <thead>
              <tr>
                <th className="np-table-sticky">Reinsurer</th>
                {c.best.layers.map((l) => <th key={l.layer_index}>{l.label}</th>)}
                <th>Programme premium</th><th>Programme ROL</th><th>Layers</th>
              </tr>
            </thead>
            <tbody>
              {c.by_market.map((m) => (
                <tr key={m.negotiation_id}>
                  <th className="np-table-sticky">{m.market_name}<IndicativeTag kind={m.kind} className="neg-kind-tag--inline" /></th>
                  {m.layers.map((l) => (
                    <td key={l.layer_index} className={l.status}>
                      {l.status === 'quoted' ? <>{money(currency, l.premium)}<span className="rolc-sub">{l.rol_pct != null ? `ROL ${pct(l.rol_pct, 4)}` : l.rate_pct != null ? `rate ${pct(l.rate_pct)}` : ''}{l.line_pct != null ? ` · line ${pct(l.line_pct)}` : ''}{l.kind === 'indicative' ? ' · indicative' : ''}</span></>
                        : l.status === 'declined' ? 'declined' : '—'}
                    </td>
                  ))}
                  <td><b>{m.rollup.premium_total != null ? money(currency, m.rollup.premium_total) : '—'}</b></td>
                  <td>{m.rollup.rol_pct != null ? pct(m.rollup.rol_pct, 4) : '—'}</td>
                  <td className="small">{m.rollup.quoted}/{m.rollup.layers}{m.rollup.complete ? '' : ' (incomplete)'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="qu-best" data-testid="qu-best">
                <th className="np-table-sticky">Best of market</th>
                {c.best.layers.map((l) => (
                  <td key={l.layer_index}>
                    {l.premium != null ? <>{money(currency, l.premium)}<span className="rolc-sub">{l.market_name}{l.rol_pct != null ? ` · ROL ${pct(l.rol_pct, 4)}` : ''}{l.kind === 'indicative' ? ' · indicative' : ''}</span></> : l.market_name ? <>{l.market_name}<span className="rolc-sub">{l.rate_pct != null ? `rate ${pct(l.rate_pct)}` : ''}{l.kind === 'indicative' ? ' · indicative' : ''}</span></> : '—'}
                  </td>
                ))}
                <td>{c.best.premium_total != null ? money(currency, c.best.premium_total) : '—'}</td>
                <td>{c.best.rol_pct != null ? pct(c.best.rol_pct, 4) : '—'}</td>
                <td className="small">{c.best.complete ? `every layer · ${c.best.markets.join(', ')}` : 'incomplete'}{c.best.indicative ? ' · on an indication' : ''}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </StructCard>
  ));
}

/**
 * @param onEdit(line, market, quote)          open the quote form on one line
 * @param onKind(market, structure, kind)      mark the reinsurer's answer on a structure lead or indicative
 * @param onDifferent(negotiationId, index)     capture the reinsurer's own structure on the sheet
 * @param onOpenSheet(negotiationId)            open the reinsurer on the capture sheet
 */
export default function QuotingByUnderwriter({ data, currency, canEdit, onEdit, onKind, onDifferent, onOpenSheet }) {
  const by = data.by_underwriter || [];
  const marketOf = (negotiationId) => data.markets.find((m) => m.id === negotiationId);

  if (!by.length) {
    return (
      <StructCard title="Quotes by underwriter" hint="Every reinsurer holding the pack, with what it quoted on each structure — a proportional structure as a whole, a non-proportional one layer by layer with the programme those layers add up to.">
        <div className="muted" data-testid="qu-empty">Nobody holds the pack yet — send it from the Emails tab, and each reinsurer's quotes are kept here.</div>
      </StructCard>
    );
  }

  return (
    <div className="qu" data-testid="qu-by-underwriter">
      {by.map((u) => {
        const market = marketOf(u.negotiation_id);
        return (
          <StructCard
            key={u.negotiation_id}
            title={u.market_name}
            hint={`${u.summary.answered} of ${u.summary.structures_sent} structure${u.summary.structures_sent === 1 ? '' : 's'} sent answered${u.summary.own ? ` · ${u.summary.own} of its own` : ''}`}
            actions={(
              <div className="toolbar">
                <span className={`neg-standing neg-standing--${String(u.status).toLowerCase()}`}>{u.status}</span>
                {canEdit && market && (
                  <button type="button" className="np-struct-btn" onClick={() => onOpenSheet(u.negotiation_id)} title="Price every structure this reinsurer was sent, on one sheet">
                    Open on the sheet
                  </button>
                )}
              </div>
            )}
          >
            {u.structures.map((s) => (
              <div key={`${s.source}:${s.index ?? s.id}`} className="qu-structure" data-testid="qu-structure">
                <div className="qu-structure-head">
                  <b>{s.label}</b>
                  <span className="pill-mini">{s.basis === 'PROP' ? 'PROPORTIONAL' : 'NON-PROPORTIONAL'}</span>
                  {s.own && <span className="pill-mini">ITS OWN STRUCTURE</span>}
                  {s.declined && <span className="neg-standing neg-standing--declined">declined</span>}
                  {!s.answered && !s.own && <span className="muted small">awaited</span>}
                  {/* Lead quote or indication — the reinsurer's answer on this
                      structure as a whole. Nothing to switch until it has
                      priced a line of it. */}
                  {s.answered && !s.declined && (canEdit && market
                    ? (
                      <QuoteKindToggle kind={s.kind} label={`${u.market_name} on ${s.label}: lead quote or indication`}
                        onChange={(next) => onKind(market, s, next)} />
                    )
                    : <IndicativeTag kind={s.kind} />)}
                </div>
                {s.basis === 'PROP'
                  ? <PropCapture s={s} market={market} currency={currency} canEdit={canEdit && !!market} onEdit={onEdit} onDifferent={onDifferent} />
                  : <LayerGrid s={s} market={market} currency={currency} canEdit={canEdit && !!market} onEdit={onEdit} />}
              </div>
            ))}
            {!u.structures.length && <div className="muted small">Nothing to quote — add a structure on the Quote Structure tab.</div>}
          </StructCard>
        );
      })}
      <CombinedQuote combined={data.combined} currency={currency} />
    </div>
  );
}
