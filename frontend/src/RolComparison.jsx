import React from 'react';
import { StructCard } from './StructureSections.jsx';
import { fmt, pct } from './NegotiationBoard.jsx';

/*
 * The rate on line, compared.
 *
 * One table per non-proportional structure: its layers down the side, the
 * reinsurers that quoted across the top, and in each cell that reinsurer's
 * rate on line on that layer — premium over limit, computed from what it
 * quoted, never typed. Beside them the layer as it went out and, where the
 * prior year is known, the expiring layer, so every column reads against the
 * same yardstick. The keenest quote on each layer is marked, and the foot
 * adds each reinsurer's layers into its programme.
 */

const money = (ccy, n) => (n == null ? '—' : `${ccy} ${fmt(n)}`);
const cover = (r) => (r.limit == null ? '—' : r.attachment ? `${fmt(r.limit)} xs ${fmt(r.attachment)}` : fmt(r.limit));

function Cell({ c, currency }) {
  if (!c || c.status === 'awaited') return <td className="awaited">—</td>;
  if (c.status === 'declined') return <td className="declined">declined</td>;
  return (
    <td className={c.best ? 'rolc-best' : 'quoted'} data-testid={c.best ? 'rol-best' : undefined}>
      {c.measure === 'rol' ? pct(c.rol_pct, 4) : c.measure === 'rate' ? `${pct(c.rate_pct)} rate` : '—'}
      <span className="rolc-sub">
        {c.premium != null ? money(currency, c.premium) : ''}{c.line_pct != null ? ` · line ${pct(c.line_pct)}` : ''}{c.kind === 'indicative' ? ' · indicative' : ''}{c.best ? ' · keenest' : ''}
      </span>
    </td>
  );
}

export default function RolComparison({ data, currency }) {
  const cmp = data.rol_comparison || [];
  if (!cmp.length) {
    return (
      <StructCard title="Rate on line comparison" hint="Each layer of a non-proportional structure against every reinsurer that quoted it.">
        <div className="muted" data-testid="rol-empty">No non-proportional structure to compare — a proportional treaty is quoted on its commission, not a rate on line.</div>
      </StructCard>
    );
  }
  return cmp.map((s) => (
    <StructCard
      key={`${s.source}:${s.index ?? s.id}`}
      title={`${s.label} — rate on line by reinsurer`}
      hint="Layers down the side, the reinsurers that quoted across. Rate on line is premium over limit from what each quoted; a quote priced on a rate alone shows that rate. The keenest quote on each layer is marked."
      actions={<span className="np-layer-count">Reinsurers quoting<b>{s.markets.length || '—'}</b></span>}
    >
      {!s.markets.length ? <div className="muted small">No quotes on this structure yet.</div> : (
        <div className="np-table-wrap">
          <table className="np-struct-table rolc-table" data-testid="rol-comparison">
            <thead>
              <tr>
                <th className="np-table-sticky">Layer</th>
                <th>Cover</th>
                <th>As sent</th>
                {s.has_expiring && <th>Expiring</th>}
                {s.markets.map((m) => <th key={m.negotiation_id}>{m.market_name}</th>)}
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => (
                <tr key={r.layer_index}>
                  <th className="np-table-sticky">{r.label}</th>
                  <td>{cover(r)}</td>
                  <td>
                    {r.sent.rol_pct != null ? pct(r.sent.rol_pct, 4) : r.sent.rate_pct != null ? `${pct(r.sent.rate_pct)} rate` : '—'}
                    <span className="rolc-sub">{r.sent.premium != null ? money(currency, r.sent.premium) : ''}</span>
                  </td>
                  {s.has_expiring && (
                    <td>
                      {r.expiring?.rol_pct != null ? pct(r.expiring.rol_pct, 4) : '—'}
                      <span className="rolc-sub">{r.expiring?.premium != null ? money(currency, r.expiring.premium) : ''}{r.expiring?.limit != null && r.expiring.limit !== r.limit ? ` · limit ${fmt(r.expiring.limit)}` : ''}</span>
                    </td>
                  )}
                  {s.markets.map((m) => <Cell key={m.negotiation_id} c={r.cells[m.negotiation_id]} currency={currency} />)}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="qu-rollup">
                <th className="np-table-sticky">Programme</th>
                <td>{s.sent_programme?.limit_total != null ? money(currency, s.sent_programme.limit_total) : '—'}</td>
                <td>
                  {s.sent_programme?.rol_pct != null ? pct(s.sent_programme.rol_pct, 4) : '—'}
                  <span className="rolc-sub">{s.sent_programme?.premium_total != null ? money(currency, s.sent_programme.premium_total) : ''}</span>
                </td>
                {s.has_expiring && (
                  <td>
                    {s.expiring_programme?.rol_pct != null ? pct(s.expiring_programme.rol_pct, 4) : '—'}
                    <span className="rolc-sub">{s.expiring_programme?.premium_total != null ? money(currency, s.expiring_programme.premium_total) : ''}</span>
                  </td>
                )}
                {s.markets.map((m) => {
                  const f = s.foot[m.negotiation_id];
                  return (
                    <td key={m.negotiation_id}>
                      {f?.rol_pct != null ? pct(f.rol_pct, 4) : '—'}
                      <span className="rolc-sub">{f?.premium_total != null ? money(currency, f.premium_total) : ''}{f ? ` · ${f.quoted}/${f.layers} layers` : ''}</span>
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </StructCard>
  ));
}
