import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import {
  useFetch, Blueprint, SectionLabel, Pill, StatusPill, ErrorBanner,
  WorkflowTracker, fmtMoney, fmtPct, fmtDate,
} from '../components.jsx';
import { useScreenHead, useWorkspace, useRole } from '../shell.jsx';
import { computeSigning, allocatePremium } from '../signing.js';

/**
 * The layer workspace: market the layer, agree firm order terms, capture the
 * written lines, and watch the order fill. Signed values are derived on every
 * render from written lines + stands + order — never stored client-side.
 */
const BAR_MAX = 120; // the completion bar runs 0 → 120%

export default function LayerWorkspace() {
  const { id } = useParams();
  const navigate = useNavigate();
  const ws = useWorkspace();
  const role = useRole();

  const layer = useFetch('GET', `/layers/${id}`, [id]);
  const board = useFetch('GET', `/layers/${id}/quote-board`, [id]);
  const fot = useFetch('GET', `/layers/${id}/fot`, [id]);
  const lines = useFetch('GET', `/layers/${id}/lines`, [id]);

  const [placement, setPlacement] = useState(null);
  const [siblings, setSiblings] = useState([]);
  const [stand, setStand] = useState({});
  const [error, setError] = useState(null);
  const [applied, setApplied] = useState(false);

  const l = layer.data;

  // Placement context: the crumb, and "layer N of M".
  useEffect(() => {
    let alive = true;
    if (!l?.placement_id) return undefined;
    (async () => {
      try {
        const p = await api('GET', `/placements/${l.placement_id}`);
        if (!alive) return;
        setPlacement(p);
        setSiblings(p.layers || []);
        ws.setPlacement(p);
        ws.setLayer({ ...l, placement: p, position: (p.layers || []).findIndex((x) => x.id === l.id) + 1 });
      } catch { /* crumb falls back to the layer name */ }
    })();
    return () => { alive = false; };
  }, [l?.id, l?.placement_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seed provisional stands from the persisted per-line flags.
  useEffect(() => {
    if (!lines.data) return;
    setStand(Object.fromEntries(lines.data.filter((x) => x.to_stand).map((x) => [x.id, true])));
  }, [lines.data]);

  // The panel reads largest line first, as a signing panel is read.
  const active = useMemo(
    () => (lines.data || [])
      .filter((x) => ['WRITTEN', 'SIGNED'].includes(x.status))
      .sort((a, b) => Number(b.written_pct) - Number(a.written_pct) || a.market_name.localeCompare(b.market_name)),
    [lines.data],
  );
  const isSigned = active.length > 0 && active.every((x) => x.status === 'SIGNED');
  const show = isSigned || applied;

  const order = Number(l?.order_pct ?? 100);
  const premium100 = Number(l?.premium100 ?? 0);
  const sg = useMemo(
    () => computeSigning(order, active.map((x) => ({
      id: x.id, written: Number(x.written_pct), toStand: !!stand[x.id],
    }))),
    [order, active, stand],
  );
  const alloc = useMemo(
    () => Object.fromEntries(allocatePremium(premium100, sg.lines).map((a) => [a.id, a.premiumSigned])),
    [premium100, sg.lines],
  );
  const signedById = Object.fromEntries(sg.lines.map((s) => [s.id, s.signed]));

  const position = siblings.findIndex((x) => x.id === id) + 1;
  const activeFot = (fot.data || []).find((f) => f.status === 'authorised');
  const proposedFot = (fot.data || []).find((f) => f.status === 'proposed');
  const currentFot = activeFot || proposedFot;

  useScreenHead(
    placement && position ? `${placement.reference} · Layer ${position}` : (l?.name || '…'),
    l?.name || '…',
    show ? 'SIGNED' : active.length ? 'LINES WRITTEN' : null,
  );

  if (layer.error) return <div className="screen"><ErrorBanner error={layer.error} /></div>;
  if (!l) return <div className="screen" />;

  async function act(fn) {
    setError(null);
    try { await fn(); } catch (e) { setError(e); }
  }

  // Toggling a stand recomputes everything immediately; when the user holds the
  // broker seat it also persists the flag so `apply` signs the same panel.
  function toggleStand(line) {
    const next = !stand[line.id];
    setStand((cur) => ({ ...cur, [line.id]: next }));
    if (!role.canBroke || show) return;
    act(async () => {
      await api('POST', `/layers/${id}/lines`, {
        market_id: line.market_id,
        written_pct: Number(line.written_pct),
        to_stand: next,
        market_ref: line.market_ref || undefined,
      });
    });
  }

  const maxWritten = Math.max(1, ...active.map((x) => Number(x.written_pct)));
  const writtenTotal = sg.writtenTotal;
  const over = writtenTotal - order;
  const factorText = sg.state === 'OVERSUBSCRIBED' ? sg.rawFactor.toFixed(6) : '1.000000';
  const orderPointPct = writtenTotal > 0 ? Math.min(100, (order / writtenTotal) * 100) : 100;

  const facts = [
    ['Layer', position && siblings.length ? `${position} of ${siblings.length}` : l.name],
    ['Cover', l.limit_amt ? `${fmtCompactAmt(l.limit_amt)} xs ${fmtCompactAmt(l.attachment)}` : l.type],
    ['Order', fmtPct(order)],
    [`Premium 100%`, `${l.currency} ${fmtMoney(premium100)}`],
    ['Status', show ? 'Signed' : active.length ? 'Lines written' : 'Open'],
  ];

  const techRol = board.data?.technical?.technical_rate_on_line;

  // Leads first, then by the line each market offers — the order a broker
  // works the panel down in.
  const boardRows = [...(board.data?.markets || [])].sort((a, b) =>
    (a.role === b.role ? 0 : a.role === 'lead' ? -1 : 1)
    || Number(b.line_offered || 0) - Number(a.line_offered || 0)
    || a.market_name.localeCompare(b.market_name));

  // BEST marks the best *compliant* commercial term, not merely the keenest
  // rate: a quote only qualifies if it is firm, still live, and carries no
  // open subjectivity. Among those, the lowest rate on line wins.
  const bestApproachId = (() => {
    const compliant = boardRows.filter((m) => (
      m.rol != null
      && m.quote_type === 'firm'
      && !m.open_subjectivities
      && !['superseded', 'withdrawn', 'declined'].includes(m.quote_status)
      && !(m.validity && new Date(m.validity) < new Date() && m.quote_status === 'active')
    ));
    if (!compliant.length) return null;
    return compliant.reduce((a, b) => (Number(a.rol) <= Number(b.rol) ? a : b)).approach_id;
  })();

  return (
    <div className="screen">
      <ErrorBanner error={error || board.error || lines.error} />

      {placement && (
        <Blueprint style={{ padding: '18px 22px 14px' }}>
          <WorkflowTracker current={placement.status} label="Placement lifecycle" />
        </Blueprint>
      )}

      <div className="factstrip" style={{ gridTemplateColumns: `repeat(${facts.length}, 1fr)` }}>
        {facts.map(([label, value]) => (
          <div className="factcell" key={label}>
            <div className="factlabel">{label}</div>
            <div className="factvalue">{value}</div>
          </div>
        ))}
      </div>

      <section>
        <div className="sechead">
          <SectionLabel>Quote board — technical benchmark vs market</SectionLabel>
          {techRol != null && (
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--color-accent-700)' }}>
              Universe technical ROL {fmtPct(techRol)}
            </span>
          )}
          <div className="sechead-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/layers/${id}/operations`)}>
              Market operations
            </button>
          </div>
        </div>
        <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Market</th><th>Role</th><th>Quote</th><th className="r">ROL</th>
                <th className="r">vs tech</th><th className="r">Line offered</th>
                <th>Subjectivities</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {boardRows.map((m) => {
                const pastValidity = m.validity && new Date(m.validity) < new Date() && m.quote_status === 'active';
                return (
                  <tr key={m.approach_id} className={m.approach_id === bestApproachId ? 'is-best' : undefined}>
                    <td>
                      <span className="person" style={{ gap: 8 }}>
                        <span className="person-name" title={m.market_name}>{m.market_name}</span>
                        {m.approach_id === bestApproachId && <span className="badge-best">BEST</span>}
                      </span>
                    </td>
                    <td style={{ textTransform: 'capitalize' }}>{m.role}</td>
                    <td style={{ textTransform: 'capitalize' }}>{m.quote_type || '—'}</td>
                    <td className="r">{m.rol != null ? fmtPct(m.rol) : '—'}</td>
                    <td className="r"><Spread points={m.spread_vs_technical} /></td>
                    <td className="r">{m.line_offered != null ? fmtPct(m.line_offered) : '—'}</td>
                    <td>
                      {m.open_subjectivities > 0
                        ? <span className="status pill-gold">{m.open_subjectivities} open</span>
                        : <span className="muted">—</span>}
                    </td>
                    <td>
                      {pastValidity
                        ? <span className="status pill-gold">Past validity</span>
                        : <StatusPill value={m.quote_status || m.approach_status} />}
                    </td>
                  </tr>
                );
              })}
              {boardRows.length === 0 && (
                <tr><td colSpan="8" className="muted">No approaches yet — take the layer to market from Placements.</td></tr>
              )}
            </tbody>
          </table>
        </Blueprint>
      </section>

      <div className="workgrid">
        <Blueprint className="fotpanel">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div className="kicker">
                {currentFot
                  ? `FOT v${currentFot.version} — ${activeFot ? 'agreed' : 'proposed'} ${fmtDate(currentFot.agreed_date || currentFot.created_at)}`
                  : 'Firm order terms'}
              </div>
              <div className="fotrol">
                {currentFot?.agreed_terms?.rol != null ? `ROL ${fmtPct(currentFot.agreed_terms.rol)}` : '—'}
              </div>
            </div>
            {currentFot && <StatusPill value={currentFot.status} />}
          </div>
          <div className="fotterms">
            {currentFot ? fotTerms(currentFot.agreed_terms, order) : 'No firm order terms proposed yet.'}
          </div>
          <div className="fotnote">
            <span>{fotNote(activeFot, proposedFot, role)}</span>
            <div className="fotbtns">
              <button
                className="btn btn-primary"
                disabled={!role.canAuthorise || !proposedFot || !!activeFot}
                onClick={() => act(async () => {
                  await api('POST', `/layers/${id}/fot/authorise`, {});
                  fot.reload(); layer.reload(); lines.reload();
                })}
              >Authorise FOT (four-eyes)</button>
              {role.canBroke && !activeFot && (
                <button className="btn btn-secondary" onClick={() => navigate(`/placements/${l.placement_id}`)}>
                  New version
                </button>
              )}
            </div>
          </div>
        </Blueprint>

        <Blueprint className="completion">
          <div className="comp-baseline">
            <div>
              <div className="comp-big">{fmtPct(writtenTotal)}</div>
              <div className="stat-label">written</div>
            </div>
            <div>
              <div className="comp-big signed">{show ? fmtPct(sg.signedTotal) : '—'}</div>
              <div className="stat-label">signed</div>
            </div>
            <div className="comp-over">
              <div className="comp-big">{over >= 0 ? `+${over.toFixed(2)}%` : `−${Math.abs(over).toFixed(2)}%`}</div>
              <div className="stat-label">{over >= 0 ? 'oversubscribed' : 'shortfall'}</div>
            </div>
          </div>
          <div>
            <div className="comp-track">
              <div
                className="comp-fill"
                style={{
                  width: `${Math.min(100, (writtenTotal / BAR_MAX) * 100)}%`,
                  background: `linear-gradient(90deg, var(--color-accent) 0, var(--color-accent) ${orderPointPct}%, var(--color-accent-300) ${orderPointPct}%)`,
                }}
              />
              <div className="comp-mark" style={{ left: `${(order / BAR_MAX) * 100}%` }} />
            </div>
            <div className="comp-scale">
              <span>0%</span><span>order {order.toFixed(0)}%</span><span>{BAR_MAX}%</span>
            </div>
          </div>
          <div className="comp-note">
            {writtenTotal > order
              ? `Written exceeds the order by ${over.toFixed(2)} points. Signing at a factor of ${factorText} brings the panel to exactly ${fmtPct(order)}${sg.standingTotal ? `, with ${fmtPct(sg.standingTotal)} reserved at written across lines set to stand` : ''}.`
              : writtenTotal === order
                ? `Written matches the order exactly — every line signs at written.`
                : `Written is ${(order - writtenTotal).toFixed(2)} points short of the order. Continue marketing or firm-order at written to close the layer as INCOMPLETE.`}
          </div>
        </Blueprint>
      </div>

      <section>
        <div className="sechead">
          <SectionLabel>Written lines</SectionLabel>
          <span className="hint">click a row's stand cell to reserve that line at written · signing applies the factor to the rest</span>
          <div className="sechead-actions">
            <button className="btn btn-secondary" onClick={() => navigate(`/layers/${id}/signing`)}>Open signing worksheet</button>
            <button
              className="btn btn-primary"
              disabled={!role.canBroke || active.length === 0 || show}
              onClick={() => act(async () => {
                await api('POST', `/layers/${id}/signing/apply`, {});
                setApplied(true);
                lines.reload(); layer.reload();
              })}
            >Apply signing</button>
          </div>
        </div>
        <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Market</th><th>Ref</th><th className="r">Written %</th><th className="c">To stand</th>
                <th className="r">Signed %</th><th className="r">Signed premium</th><th>Line</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {active.map((line) => {
                const on = !!stand[line.id];
                const written = Number(line.written_pct);
                return (
                  <tr key={line.id}>
                    <td style={{ fontWeight: 500 }}>{line.market_name}</td>
                    <td className="mono" style={{ fontSize: 11.5, color: 'var(--color-neutral-600)' }}>{line.market_ref || '—'}</td>
                    <td className="r">{fmtPct(written)}</td>
                    <td className="c">
                      <button
                        className={`standbtn${on ? ' on' : ''}`}
                        title={on ? 'Reserved at written' : 'Signs down with the panel'}
                        onClick={() => toggleStand(line)}
                        disabled={show}
                      >{on ? '■' : '□'}</button>
                    </td>
                    <td className="r" style={{ color: show ? 'var(--color-accent-800)' : 'var(--color-neutral-500)' }}>
                      {show ? fmtPct(signedById[line.id]) : '—'}
                    </td>
                    <td className="r">{show ? fmtMoney(alloc[line.id], 2) : '—'}</td>
                    <td>
                      <div className="minibar">
                        <i className={on ? 'stand' : ''} style={{ width: `${(written / maxWritten) * 100}%` }} />
                      </div>
                    </td>
                    <td>{show ? <Pill tone="solid">Signed</Pill> : <Pill tone="accent">Written</Pill>}</td>
                  </tr>
                );
              })}
              {active.length === 0 && (
                <tr><td colSpan="8" className="muted">No lines written yet — lines are collected once an FOT is authorised.</td></tr>
              )}
              {active.length > 0 && (
                <tr className="total-row">
                  <td className="total-label">Total</td>
                  <td />
                  <td className="r">{fmtPct(writtenTotal)}</td>
                  <td />
                  <td className="r signed-total">{show ? fmtPct(sg.signedTotal) : '—'}</td>
                  <td className="r">{show ? fmtMoney(sg.signedTotal / 100 * premium100, 2) : '—'}</td>
                  <td /><td />
                </tr>
              )}
            </tbody>
          </table>
        </Blueprint>
      </section>
    </div>
  );
}

/** 20m xs 10m — the cover geometry as brokers write it. */
function fmtCompactAmt(v) {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e9) return `${+(n / 1e9).toFixed(2)}bn`;
  if (Math.abs(n) >= 1e6) return `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}m`;
  if (Math.abs(n) >= 1e3) return `${+(n / 1e3).toFixed(0)}k`;
  return fmtMoney(n);
}

function fotTerms(terms = {}, order) {
  const parts = [`Order ${fmtPct(terms.order_pct ?? order)}`];
  // Stored as '2 @ 100% pro rata'; read out as '2 reinstatements @ 100% pro rata'.
  if (terms.reinstatements) parts.push(String(terms.reinstatements).replace(/^(\d+)\s*@/, '$1 reinstatements @'));
  if (terms.no_claims_bonus) parts.push(`No claims bonus ${terms.no_claims_bonus}`);
  return parts.join(' · ');
}

function fotNote(activeFot, proposedFot, role) {
  if (activeFot) {
    return `Authorised on ${fmtDate(activeFot.authorised_at)}. Immutable — a change requires a new version that supersedes this one.`;
  }
  if (!proposedFot) return 'Propose firm order terms from the placement once the lead has agreed.';
  if (role.canAuthorise) {
    return `Proposed on ${fmtDate(proposedFot.agreed_date || proposedFot.created_at)}. You may authorise as the second pair of eyes.`;
  }
  return 'An underwriter or admin must authorise — the proposer cannot authorise their own FOT.';
}

/**
 * Spread against the technical benchmark, in percentage points.
 *
 * The sign carries the meaning — − below technical, + above — so the reading
 * survives without colour; the tint only supplements it.
 */
function Spread({ points }) {
  if (points == null) return <span className="muted">—</span>;
  const n = Number(points);
  if (!Number.isFinite(n)) return <span className="muted">—</span>;
  const tone = n < 0 ? 'spread-under' : n > 0 ? 'spread-over' : '';
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return <span className={`spread ${tone}`}>{sign}{Math.abs(n).toFixed(2)} pts</span>;
}
