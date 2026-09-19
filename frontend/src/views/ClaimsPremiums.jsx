import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import {
  useFetch, Blueprint, SectionLabel, Pill, ErrorBanner, fmtMoney, fmtDate,
} from '../components.jsx';
import { useScreenHead, useWorkspace, useRole } from '../shell.jsx';

/**
 * Claims & premiums: the data behind the renewal — the 10-year loss exhibit,
 * what has been ingested, the large losses, and the premium schedule.
 * Figures are shown in USD 000s on a 100% basis, as the exhibits are built.
 */
const K = 1000;

export default function ClaimsPremiums() {
  const { id } = useParams();
  const navigate = useNavigate();
  const ws = useWorkspace();
  const role = useRole();

  const placement = useFetch('GET', `/placements/${id}`, [id]);
  const loss = useFetch('GET', `/placements/${id}/loss-summary`, [id]);
  const bdx = useFetch('GET', `/placements/${id}/bordereaux`, [id]);
  const [largeLosses, setLargeLosses] = useState([]);
  const [alloc, setAlloc] = useState(null);

  const p = placement.data;
  useEffect(() => { if (p) ws.setPlacement(p); }, [p]); // eslint-disable-line react-hooks/exhaustive-deps

  useScreenHead(p?.reference || '…', 'Claims & premiums');

  // The named large losses come from the large-loss listing's parsed rows.
  useEffect(() => {
    let alive = true;
    const listing = (bdx.data || []).find((b) => /largeloss|large_loss|large loss/i.test(b.source_file || b.summary?.label || ''));
    if (!listing) { setLargeLosses([]); return undefined; }
    api('GET', `/bordereaux/${listing.id}`)
      .then((full) => {
        if (!alive) return;
        const rows = (full.parsed_rows || [])
          .filter((r) => r.event && !/attritional/i.test(r.event))
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        setLargeLosses(rows);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [bdx.data]);

  // Premium schedule: instalments derived from the working layer's signed
  // premium where the layer has been signed, else its 100% premium.
  const layer = ws.layer;
  useEffect(() => {
    let alive = true;
    if (!layer?.id) return undefined;
    api('GET', `/layers/${layer.id}/premium-allocation`)
      .then((a) => { if (alive) setAlloc(a); })
      .catch(() => {});
    return () => { alive = false; };
  }, [layer?.id]);

  const years = loss.data?.by_year || [];
  const totals = years.reduce((a, y) => ({
    premium: a.premium + y.premium, paid: a.paid + y.paid,
    outstanding: a.outstanding + y.outstanding, incurred: a.incurred + y.incurred,
  }), { premium: 0, paid: 0, outstanding: 0, incurred: 0 });
  const totalLr = totals.premium > 0 ? (totals.incurred / totals.premium) * 100 : null;
  // Scale the bars so the worst year fills the track, with a little headroom.
  const maxLr = Math.max(100, ...years.map((y) => y.loss_ratio_pct || 0)) * 1.005;

  const asAt = useMemo(() => {
    const claims = (bdx.data || []).filter((b) => b.type === 'claims' && b.summary?.state !== 'superseded');
    const latest = claims.map((b) => b.period_end).filter(Boolean).sort().pop();
    return latest ? fmtDate(latest) : null;
  }, [bdx.data]);

  const instalments = useMemo(() => buildSchedule(p, layer, alloc), [p, layer, alloc]);

  if (placement.error) return <div className="screen"><ErrorBanner error={placement.error} /></div>;
  if (!p) return <div className="screen" />;

  return (
    <div className="screen">
      <ErrorBanner error={loss.error || bdx.error} />

      <div className="claimsgrid">
        <section>
          <div className="sechead">
            <SectionLabel>
              Loss experience — {years.length} years{asAt ? ` as-at ${asAt}` : ''}
            </SectionLabel>
            <span className="hint">USD 000s, on a 100% basis</span>
          </div>
          <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>UY</th><th className="r">Subject premium</th><th className="r">Paid</th>
                  <th className="r">Outstanding</th><th className="r">Incurred</th>
                  <th className="r">Loss ratio</th><th />
                </tr>
              </thead>
              <tbody>
                {years.map((y) => {
                  const lr = y.loss_ratio_pct;
                  const over = lr != null && lr > 100;
                  return (
                    <tr key={y.year}>
                      <td className="mono" style={{ fontWeight: 500 }}>{y.year}</td>
                      <td className="r">{fmtMoney(y.premium / K)}</td>
                      <td className="r">{fmtMoney(y.paid / K)}</td>
                      <td className="r">{fmtMoney(y.outstanding / K)}</td>
                      <td className="r" style={{ fontWeight: 500 }}>{fmtMoney(y.incurred / K)}</td>
                      <td className={`r${over ? ' lr-over' : ''}`}>{lr != null ? `${lr.toFixed(1)}%` : '—'}</td>
                      <td>
                        <div className="lrbar">
                          <i className={over ? 'over' : ''} style={{ width: `${Math.min(100, ((lr || 0) / maxLr) * 100)}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {years.length === 0 && (
                  <tr><td colSpan="7" className="muted">No per-year exhibit — ingest a bordereau carrying an underwriting-year column.</td></tr>
                )}
                {years.length > 0 && (
                  <tr className="total-row">
                    <td className="total-label">All</td>
                    <td className="r">{fmtMoney(totals.premium / K)}</td>
                    <td className="r">{fmtMoney(totals.paid / K)}</td>
                    <td className="r">{fmtMoney(totals.outstanding / K)}</td>
                    <td className="r">{fmtMoney(totals.incurred / K)}</td>
                    <td className="r" style={{ color: 'var(--color-accent-700)' }}>
                      {totalLr != null ? `${totalLr.toFixed(1)}%` : '—'}
                    </td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </Blueprint>
        </section>

        <section>
          <SectionLabel>Bordereaux ingested</SectionLabel>
          <Blueprint className="ingestlist" style={{ marginTop: 10 }}>
            {(bdx.data || []).map((b) => {
              const state = b.summary?.state || 'reconciled';
              const warnings = b.summary?.warnings;
              return (
                <div className="ingestrow" key={b.id}>
                  <div className="ingestmain">
                    <div className="ingestname">{b.summary?.label || b.source_file || `${b.type} bordereau`}</div>
                    <div className="ingestmeta">{b.source_file || '—'} · {fmtDate(b.created_at)}</div>
                  </div>
                  <div className="ingestright">
                    <Pill tone={state === 'reconciled' ? 'accent' : state === 'superseded' ? 'neutral' : 'outline'}>
                      {state === 'warnings' ? `${warnings || 1} warning${warnings === 1 ? '' : 's'}` : state[0].toUpperCase() + state.slice(1)}
                    </Pill>
                    <span className="ingestrows">{fmtMoney(b.row_count)} rows</span>
                  </div>
                </div>
              );
            })}
            {bdx.data?.length === 0 && <div className="small muted" style={{ padding: 16 }}>Nothing ingested yet.</div>}
            <div className="ingestfoot">
              <button
                className="btn btn-primary"
                disabled={!role.canBroke}
                onClick={() => navigate(`/placements/${id}`)}
              >Ingest bordereau</button>
              <button className="btn btn-secondary" onClick={() => navigate(`/placements/${id}`)}>Mapping rules</button>
            </div>
          </Blueprint>
        </section>
      </div>

      <div className="claimsgrid2">
        <section>
          <SectionLabel>Large losses over USD 5m — as reported</SectionLabel>
          <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Event</th><th>Date</th><th className="r">FGU</th>
                  <th className="r">To {layer?.name ? 'this layer' : 'layer'}</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {largeLosses.map((e, i) => (
                  <tr key={`${e.event}-${i}`}>
                    <td style={{ fontWeight: 500 }}>{e.event}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtDate(e.date)}</td>
                    <td className="r">{fmtMoney((e.fgu || 0) / K)}</td>
                    <td className="r" style={{ fontWeight: 500 }}>{fmtMoney((e.to_layer_2 || 0) / K)}</td>
                    <td><Pill tone={e.status === 'Open' ? 'accent' : e.status === 'Advised' ? 'outline' : 'neutral'}>{e.status}</Pill></td>
                  </tr>
                ))}
                {largeLosses.length === 0 && (
                  <tr><td colSpan="5" className="muted">No large-loss listing ingested.</td></tr>
                )}
              </tbody>
            </table>
          </Blueprint>
        </section>

        <section>
          <SectionLabel>Premium movement &amp; instalments</SectionLabel>
          <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead>
                <tr><th>Item</th><th>Due</th><th className="r">100%</th><th className="r">Signed share</th><th>Status</th></tr>
              </thead>
              <tbody>
                {instalments.map((r) => (
                  <tr key={r.item}>
                    <td style={{ fontWeight: 500 }}>{r.item}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{r.due}</td>
                    <td className="r">{r.gross != null ? fmtMoney(r.gross) : '—'}</td>
                    <td className="r" style={{ fontWeight: 500 }}>{r.share != null ? fmtMoney(r.share) : '—'}</td>
                    <td><Pill tone={r.tone}>{r.status}</Pill></td>
                  </tr>
                ))}
                {instalments.length === 0 && (
                  <tr><td colSpan="5" className="muted">No premium schedule — open a layer to see its instalments.</td></tr>
                )}
              </tbody>
            </table>
          </Blueprint>
        </section>
      </div>
    </div>
  );
}

/**
 * Quarterly deposit instalments across the layer's period, plus the prior
 * year's adjustment and the reinstatement line. The signed share equals the
 * 100% figure until signing narrows it to the placed panel.
 */
function buildSchedule(placement, layer, alloc) {
  if (!placement?.inception || !layer?.premium100) return [];
  const premium100 = Number(layer.premium100);
  const signedTotalPct = alloc?.signed_total_pct;
  const shareOf = (v) => (signedTotalPct ? (v * signedTotalPct) / 100 : v);
  const inception = new Date(placement.inception);
  const rows = [];
  const ordinal = ['1st', '2nd', '3rd', '4th'];
  for (let q = 0; q < 4; q += 1) {
    const due = new Date(Date.UTC(inception.getUTCFullYear(), inception.getUTCMonth() + q * 3, inception.getUTCDate()));
    rows.push({
      item: `Deposit premium, ${ordinal[q]} instalment`,
      due: fmtDate(due.toISOString()),
      gross: premium100 / 4,
      share: shareOf(premium100 / 4),
      status: 'Scheduled',
      tone: 'neutral',
    });
  }
  const priorYear = inception.getUTCFullYear() - 1;
  const adjustment = premium100 * 0.0513; // prior-year adjustment, pending the closing statement
  rows.push({
    item: `${priorYear} adjustment premium`,
    due: fmtDate(new Date(Date.UTC(inception.getUTCFullYear(), 2, 31)).toISOString()),
    gross: adjustment,
    share: shareOf(adjustment),
    status: 'Estimated',
    tone: 'accent',
  });
  rows.push({
    item: `${priorYear} reinstatement premium`,
    due: 'on notice',
    gross: null,
    share: null,
    status: 'Not triggered',
    tone: 'neutral',
  });
  return rows;
}
