import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import {
  useFetch, Blueprint, ErrorBanner, fmtMoney, fmtPct, fmtStamp,
} from '../components.jsx';
import { useScreenHead, useWorkspace, useRole } from '../shell.jsx';
import { computeSigning, allocatePremium } from '../signing.js';

/**
 * The signing worksheet: the arithmetic that turns written lines into signed
 * lines, and the proof that it reconciles to the order. Toggling any stand
 * recomputes the factor, every signed %, every reduction, every premium and
 * the variance live — there is no save step until signing is applied.
 */
export default function SigningWorksheet() {
  const { id } = useParams();
  const navigate = useNavigate();
  const ws = useWorkspace();
  const role = useRole();

  const layer = useFetch('GET', `/layers/${id}`, [id]);
  const lines = useFetch('GET', `/layers/${id}/lines`, [id]);
  const audit = useFetch('GET', `/layers/${id}/audit`, [id]);

  const [placement, setPlacement] = useState(null);
  const [position, setPosition] = useState(null);
  const [stand, setStand] = useState({});
  const [error, setError] = useState(null);
  const [applied, setApplied] = useState(false);

  const l = layer.data;

  useEffect(() => {
    let alive = true;
    if (!l?.placement_id) return undefined;
    (async () => {
      try {
        const p = await api('GET', `/placements/${l.placement_id}`);
        if (!alive) return;
        setPlacement(p);
        const pos = (p.layers || []).findIndex((x) => x.id === l.id) + 1;
        setPosition(pos || null);
        ws.setPlacement(p);
        ws.setLayer({ ...l, placement: p, position: pos });
      } catch { /* crumb falls back to the layer name */ }
    })();
    return () => { alive = false; };
  }, [l?.id, l?.placement_id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  useScreenHead(
    placement && position ? `${placement.reference} · Layer ${position}` : (l?.name || '…'),
    'Signing worksheet',
    show ? 'SIGNED' : null,
  );

  if (layer.error) return <div className="screen"><ErrorBanner error={layer.error} /></div>;
  if (!l) return <div className="screen" />;

  async function act(fn) {
    setError(null);
    try { await fn(); } catch (e) { setError(e); }
  }

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

  const over = sg.state === 'OVERSUBSCRIBED';
  const factorText = over ? sg.rawFactor.toFixed(6) : '1.000000';
  const variance = sg.signedTotal - (over || sg.state === 'EXACT' ? order : sg.writtenTotal);
  const premiumAllocated = Object.values(alloc).reduce((a, v) => a + v, 0);

  return (
    <div className="screen">
      <ErrorBanner error={error || lines.error} />

      <div className="signgrid">
        <div className="signcol">
          <Blueprint className="factorpanel">
            <div className="factorrow">
              <div>
                <div className="kicker">Signing factor</div>
                <div className="factor-big">{factorText}</div>
              </div>
              <p className="factor-formula">
                {sg.standingTotal > 0
                  ? `(order ${fmtPct(order)} − stands ${fmtPct(sg.standingTotal)}) ÷ (written ${fmtPct(sg.writtenTotal)} − stands ${fmtPct(sg.standingTotal)}). Lines set to stand are reserved at their written value and excluded from the factor.`
                  : over
                    ? `order ${fmtPct(order)} ÷ written ${fmtPct(sg.writtenTotal)}. Every line signs down in the same proportion.`
                    : `Written ${fmtPct(sg.writtenTotal)} does not exceed the order ${fmtPct(order)} — the factor clamps to 1 and every line signs at written.`}
              </p>
            </div>
            <div className="factorstats">
              <FStat value={fmtPct(sg.writtenTotal)} label="total written" />
              <FStat value={fmtPct(order)} label="order" />
              <FStat value={fmtPct(sg.standingTotal)} label="reserved to stand" />
              <FStat value={String(active.length)} label="markets on the panel" />
            </div>
          </Blueprint>

          <Blueprint className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Market</th><th className="r">Written</th><th className="c">Stand</th>
                  <th className="r">Factor applied</th><th className="r">Signed</th>
                  <th className="r">Signed down by</th><th className="r">Premium {l.currency}</th>
                </tr>
              </thead>
              <tbody>
                {active.map((line) => {
                  const on = !!stand[line.id];
                  const written = Number(line.written_pct);
                  const signed = signedById[line.id];
                  return (
                    <tr key={line.id}>
                      <td>{line.market_name}</td>
                      <td className="r">{fmtPct(written)}</td>
                      <td className="c">
                        <button
                          className={`standbtn${on ? ' on' : ''}`}
                          onClick={() => toggleStand(line)}
                          disabled={show}
                          title={on ? 'Reserved at written' : 'Signs down with the panel'}
                        >{on ? '■' : '□'}</button>
                      </td>
                      <td className="r" style={{ fontSize: 12.5, color: 'var(--color-neutral-600)' }}>
                        {on ? 'reserved' : factorText}
                      </td>
                      <td className="r" style={{ fontWeight: 500 }}>{fmtPct(signed)}</td>
                      <td className="r" style={{ color: 'var(--color-neutral-600)' }}>
                        {on ? 'stands' : fmtPct(written - signed)}
                      </td>
                      <td className="r">{fmtMoney(alloc[line.id], 2)}</td>
                    </tr>
                  );
                })}
                {active.length === 0 && (
                  <tr><td colSpan="7" className="muted">No written lines to sign.</td></tr>
                )}
                {active.length > 0 && (
                  <tr className="total-row">
                    <td className="total-label">Total</td>
                    <td className="r">{fmtPct(sg.writtenTotal)}</td>
                    <td /><td />
                    <td className="r signed-total">{fmtPct(sg.signedTotal)}</td>
                    <td />
                    <td className="r">{fmtMoney(premiumAllocated, 2)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Blueprint>
        </div>

        <div className="signcol">
          <Blueprint className="reconpanel">
            <div className="kicker">Reconciliation</div>
            <div className="reconrow"><span className="k">Σ signed</span><span className="v">{fmtPct(sg.signedTotal)}</span></div>
            <div className="reconrow"><span className="k">Order</span><span className="v">{fmtPct(order)}</span></div>
            <div className="reconrow">
              <span className="k">Variance</span>
              <span className="v" style={{ color: Math.abs(variance) < 0.005 ? 'var(--color-accent-700)' : 'var(--color-accent-900)' }}>
                {fmtPct(variance)}
              </span>
            </div>
            <div className="reconrow">
              <span className="k">Premium allocated</span>
              <span className="v">{l.currency} {fmtMoney(premiumAllocated, 2)}</span>
            </div>
            <p className="reconnote">
              Residual from rounding is distributed by largest remainder, so signed lines sum to the
              order exactly.
            </p>
          </Blueprint>

          <Blueprint className="actionpanel">
            <div className="kicker">Actions</div>
            <button
              className="btn btn-primary btn-block"
              disabled={!role.canBroke || active.length === 0 || show}
              onClick={() => act(async () => {
                await api('POST', `/layers/${id}/signing/apply`, {});
                setApplied(true);
                lines.reload(); layer.reload(); audit.reload();
              })}
            >Apply signing to all lines</button>
            <button
              className="btn btn-secondary btn-block"
              disabled={!role.canBroke || !show}
              onClick={() => act(async () => {
                await api('POST', `/layers/${id}/documents`, { type: 'signing_slip' });
                audit.reload();
              })}
            >Generate signing slips</button>
            <button
              className="btn btn-secondary btn-block"
              disabled={!role.canBroke || !show}
              onClick={() => act(async () => {
                await api('POST', `/layers/${id}/documents`, { type: 'closing' });
                audit.reload();
              })}
            >Export to closing</button>
            {sg.state === 'UNDERSUBSCRIBED' && active.length > 0 && !show && (
              <button
                className="btn btn-secondary btn-block"
                disabled={!role.canBroke}
                onClick={() => act(async () => {
                  await api('POST', `/layers/${id}/signing/apply`, { accept_shortfall: true });
                  setApplied(true);
                  lines.reload(); layer.reload(); audit.reload();
                })}
              >Firm-order at written (accept shortfall)</button>
            )}
            {show && (
              <div className="confirm">
                Signing applied. Layer moved to SIGNED — bind needs a second authoriser.
              </div>
            )}
            {!role.canBroke && !show && (
              <div className="small muted">Applying signing needs the broker seat — switch the acting role.</div>
            )}
          </Blueprint>

          <Blueprint className="auditpanel">
            <div className="kicker">Audit</div>
            {(audit.data || []).slice(0, 6).map((e) => (
              <div className="auditrow" key={e.id}>
                <span className="audittime">{fmtStamp(e.created_at)}</span>
                <span className="audittext">{auditText(e)}</span>
              </div>
            ))}
            {audit.data?.length === 0 && <div className="small muted">No events on this layer yet.</div>}
          </Blueprint>

          <button className="btn btn-secondary btn-block" onClick={() => navigate(`/layers/${id}`)}>
            Back to layer workspace
          </button>
          <button className="btn btn-secondary btn-block" onClick={() => navigate(`/signing/${l.placement_id}`)}>
            All signings on this contract
          </button>
        </div>
      </div>
    </div>
  );
}

function FStat({ value, label }) {
  return (
    <div>
      <div className="fstat-value">{value}</div>
      <div className="fstat-label">{label}</div>
    </div>
  );
}

/** Audit rows carry either a seeded narrative or a structured action. */
function auditText(e) {
  if (e.detail?.text) return e.detail.text;
  const who = e.user_name ? ` by ${e.user_name}` : '';
  const actions = {
    sign_down: `Signing applied — factor ${e.detail?.factor ?? '—'}, Σ signed ${e.detail?.signedTotal ?? '—'}%`,
    write: `Line written ${e.detail?.written_pct ?? ''}%`,
    decline: 'Line declined',
    authorise: 'FOT authorised (four-eyes)',
    propose: 'FOT proposed',
    bind: 'Layer bound (four-eyes)',
    propose_bind: 'Bind proposed',
    generate: `Document generated — ${e.detail?.type || 'document'}`,
  };
  return `${actions[e.action] || `${e.entity_type} ${e.action}`}${who}`;
}
