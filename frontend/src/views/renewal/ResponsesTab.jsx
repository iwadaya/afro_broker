import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, ErrorBanner, Pill, fmtMoney, fmtCompact, fmtDate } from '../../components.jsx';
import { useAuth, useHasRole } from '../../auth.jsx';
import { useToast } from '../../toast.jsx';
import { StageEmpty } from './panels.jsx';
import { stageOf } from './stages.js';

const STATUS = {
  written: ['green', 'Written'],
  quoted: ['blue', 'Quoted'],
  declined: ['red', 'Declined'],
  awaiting: ['grey', 'Awaiting'],
};

const pct = (v, dp = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(dp)}%`);
const cover = (l) => (l.limit_amt != null
  ? `${l.currency} ${fmtCompact(l.limit_amt)} xs ${fmtCompact(l.attachment)}`
  : `${l.currency} · ${l.type}`);
const today = () => new Date().toISOString().slice(0, 10);

/** How a layer stands against its order, in the design's words. */
function layerState(l) {
  const diff = Math.round((l.written_total - l.order_pct) * 100) / 100;
  if (diff === 0 && l.written_total > 0) return { label: 'Complete', full: true };
  if (diff > 0) return { label: `Over ${pct(diff, 1)}`, full: true };
  return { label: `Short ${pct(-diff, 1)}`, full: false };
}

/**
 * 04 Responses — one row per reinsurer, written and signed by layer, on the
 * line ledger. Every edit persists through the line endpoints; signing down
 * is the engine's; the release is the one gate the desk adds.
 */
export default function ResponsesTab({ shared }) {
  const { analysis: a, setTab } = shared;
  const stage = stageOf('responses');
  if (!a.placement) {
    return (
      <StageEmpty
        stage={stage}
        title="Not linked to a placement"
        note="Responses are recorded against the layers of the placement this pack belongs to. Link it to its placement on the Renewal pack tab."
      >
        <button type="button" className="btn btn-secondary" onClick={() => setTab('pack')}>Link a placement</button>
      </StageEmpty>
    );
  }
  return <Responses shared={shared} />;
}

function Responses({ shared }) {
  const { analysis: a, setTab, reload: reloadRecord } = shared;
  const { user } = useAuth();
  const canEdit = useHasRole('broker', 'admin');
  const canAuthorise = useHasRole('underwriter', 'admin');
  const ctx = useFetch('GET', `/renewal-analyses/${a.id}/responses`, [a.id, a.placement_id]);
  const c = ctx.data;
  const stage = stageOf('responses');

  const [layerId, setLayerId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  // The one notice that stays on the page: a short layer, with the action that firms it.
  const [notice, setNotice] = useState(null);
  const toast = useToast();
  // Optimistic cell edits, keyed layer:market, until the ledger comes back.
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(0);
  const timers = useRef({});

  useEffect(() => {
    if (c?.layers?.length && !c.layers.some((l) => l.id === layerId)) setLayerId(c.layers[0].id);
  }, [c, layerId]);
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  if (ctx.error) return <ErrorBanner error={ctx.error} />;
  if (!c) return <p className="muted">Reading the lines…</p>;
  if (!c.ready) {
    const p = c.placement;
    return (
      <StageEmpty stage={stage} title={p ? `No layers on ${p.reference} yet` : 'Not linked to a placement'} note={c.blockers.join(' ')}>
        {p && <Link className="btn btn-secondary" to={`/placements/${p.id}`}>Open the placement</Link>}
      </StageEmpty>
    );
  }

  const layer = c.layers.find((l) => l.id === layerId) || c.layers[0];
  const key = (marketId) => `${layer.id}:${marketId}`;
  const edited = (row, field) => edits[key(row.market_id)]?.[field];
  const value = (row, field) => (edited(row, field) !== undefined ? edited(row, field) : row[field]);
  const fotOk = layer.fot?.status === 'authorised';

  function refresh() {
    ctx.reload();
    reloadRecord();
  }

  async function run(label, fn) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      refresh();
      return out;
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Persist one cell after the typing settles; the ledger's reply replaces the edit. */
  function edit(row, field, raw) {
    const k = key(row.market_id);
    setEdits((prev) => ({ ...prev, [k]: { ...(prev[k] || {}), [field]: raw } }));
    clearTimeout(timers.current[`${k}:${field}`]);
    timers.current[`${k}:${field}`] = setTimeout(async () => {
      setSaving((n) => n + 1);
      setError(null);
      try {
        if (field === 'written_pct') {
          await api('POST', `/layers/${layer.id}/lines`, { market_id: row.market_id, written_pct: Number(raw) || 0 });
        } else if (field === 'signed_pct') {
          await api('PATCH', `/layers/${layer.id}/lines/${row.market_id}`, { signed_pct: raw === '' ? null : Number(raw) });
        } else {
          await api('PATCH', `/layers/${layer.id}/lines/${row.market_id}`, { notes: raw });
        }
        setEdits((prev) => {
          const next = { ...prev, [k]: { ...(prev[k] || {}) } };
          delete next[k][field];
          return next;
        });
        refresh();
      } catch (e) {
        setError(e);
        setEdits((prev) => {
          const next = { ...prev, [k]: { ...(prev[k] || {}) } };
          delete next[k][field];
          return next;
        });
      } finally {
        setSaving((n) => n - 1);
      }
    }, 600);
  }

  async function decline(row) {
    await run('decline', async () => {
      if (!row.line_id) await api('POST', `/layers/${layer.id}/lines`, { market_id: row.market_id, written_pct: 0 });
      await api('POST', `/layers/${layer.id}/lines/${row.market_id}/decline`, {});
    });
  }

  async function signDown(target, { acceptShortfall = false } = {}) {
    setBusy('sign');
    setError(null);
    setNotice(null);
    try {
      const out = await api('POST', `/layers/${target.id}/signing/apply`, acceptShortfall ? { accept_shortfall: true } : {});
      refresh();
      toast(
        out.state === 'OVERSUBSCRIBED'
          ? `${target.name} signed down from ${pct(out.writtenTotal)} written to exactly ${pct(out.order)}. Every line stays editable.`
          : out.state === 'UNDERSUBSCRIBED'
            ? `${target.name} firmed at written — ${pct(out.signedTotal)} of the ${pct(out.order)} order; the shortfall stands.`
            : `${target.name} signed as written — ${pct(out.signedTotal)}, exactly the order.`,
      );
    } catch (e) {
      if (e.status === 409 && /Undersubscribed/.test(e.message)) {
        setNotice({
          text: `${target.name} is short: ${e.message.replace(/^Undersubscribed: /, '').replace(/ Keep marketing.*$/, '')} A line is never signed above the amount written, so it cannot be signed up to the order.`,
          action: { label: 'Firm at written (accept the shortfall)', run: () => signDown(target, { acceptShortfall: true }) },
        });
      } else {
        setError(e);
      }
    } finally {
      setBusy(null);
    }
  }

  async function signDownAll() {
    setBusy('sign-all');
    setError(null);
    setNotice(null);
    const done = [];
    const short = [];
    const failed = [];
    for (const l of c.layers) {
      if (!l.written_total) { short.push(`${l.name} (nothing written)`); continue; }
      try {
        const out = await api('POST', `/layers/${l.id}/signing/apply`, {});
        done.push(`${l.name} ${pct(out.signedTotal)}`);
      } catch (e) {
        if (e.status === 409 && /Undersubscribed/.test(e.message)) short.push(`${l.name} (${pct(l.written_total)} written)`);
        else failed.push(`${l.name}: ${e.message}`);
      }
    }
    refresh();
    setBusy(null);
    toast(
      [
        done.length ? `Signed to exactly the order: ${done.join(', ')}.` : '',
        short.length ? `Still short — not signed: ${short.join(', ')}.` : '',
        failed.length ? failed.join(' ') : '',
      ].filter(Boolean).join(' '),
    );
  }

  async function release() {
    const out = await run('release', () => api('POST', `/renewal-analyses/${a.id}/release`, {}));
    if (out) {
      setTab('signed');
      toast('Signed lines released — the signing advice is ready to send.');
    }
  }

  async function proposeFot(target) {
    await run('fot', () => api('POST', `/layers/${target.id}/fot`, {
      agreed_terms: {
        order_pct: target.order_pct, premium100: target.premium100, limit: target.limit_amt,
        attachment: target.attachment, currency: target.currency, reinstatements: target.reinstatements,
        source: 'renewal desk',
      },
      agreed_date: today(),
    }));
  }
  async function authoriseFot(target) {
    await run('fot', () => api('POST', `/layers/${target.id}/fot/authorise`, {}));
  }

  const allSigned = c.layers.length > 0 && c.layers.every((l) => l.signed_to_order);
  const shortLayers = c.layers.filter((l) => !l.signed_to_order);
  const state = layerState(layer);
  const kpis = [
    ['Order', pct(layer.order_pct), ''],
    ['Written', pct(layer.written_total), layer.written_total >= layer.order_pct && layer.written_total > 0 ? 'is-accent' : ''],
    ['Signed', pct(layer.signed_total), ''],
    ['Declinatures', String(layer.declined), ''],
    ['Awaiting', String(layer.awaiting), ''],
  ];

  return (
    <>
      <div className="rpa-resp-head">
        <div>
          <div className="kicker accent">Firm order responses · {c.placement.reference}</div>
          <h3 className="rpa-resp-title">{c.placement.cedant_name || a.cedant_name} — written and signed by layer</h3>
          <p className="muted small">
            {c.emailed
              ? `Written to ${c.emailed} underwriter${c.emailed === 1 ? '' : 's'} from this desk; every one is a row on every layer until it answers.`
              : 'Nothing has gone to market from this desk yet; the rows are the lines and approaches already on the layers.'}
          </p>
        </div>
        <div className="rpa-kpis">
          {kpis.map(([k, v, cls]) => (
            <div key={k} className="rpa-kpi">
              <div className="rpa-kpi-k">{k}</div>
              <div className={`rpa-kpi-v num ${cls}`}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="rpa-layercards" style={{ gridTemplateColumns: `repeat(${Math.min(c.layers.length, 6)}, minmax(0, 1fr))` }} role="tablist" aria-label="Layers">
        {c.layers.map((l) => {
          const st = layerState(l);
          const on = l.id === layer.id;
          return (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={on}
              className={`rpa-layercard${on ? ' is-on' : ''}`}
              onClick={() => { setLayerId(l.id); setNotice(null); }}
            >
              <span className="rpa-layercard-head">
                <span className="rpa-layercard-name">{l.name}</span>
                <span className="rpa-layercard-cover">{cover(l)}</span>
              </span>
              <span className="rpa-layercard-bar" aria-hidden="true">
                <span
                  className={`rpa-layercard-fill${st.full ? ' is-full' : ''}`}
                  style={{ width: `${Math.min(100, l.order_pct ? (l.written_total / l.order_pct) * 100 : 0)}%` }}
                />
              </span>
              <span className="rpa-layercard-foot">
                <span className="rpa-layercard-pct num">{pct(l.written_total, 1)}</span>
                <span className={`rpa-layercard-state${st.full ? ' is-full' : ''}`}>{st.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      <section className="blueprint rpa-resp">
        <div className="rpa-resp-bar">
          <h3 className="rpa-resp-layer">{layer.name} <span className="muted">· {cover(layer)}{layer.premium100 ? ` · deposit premium ${layer.currency} ${fmtMoney(layer.premium100)}` : ''}</span></h3>
          <div className="rpa-resp-totals">
            <span>Order required <strong className="num">{pct(layer.order_pct)}</strong></span>
            <span>Written <strong className={`num${layer.written_total >= layer.order_pct && layer.written_total > 0 ? ' accent' : ''}`}>{pct(layer.written_total)}</strong></span>
            <span>Signed <strong className={`num${layer.signed_to_order ? ' accent' : ''}`}>{pct(layer.signed_total)}</strong></span>
            {canEdit && (
              <>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !fotOk || !layer.written_total} onClick={() => signDown(layer)}>
                  {busy === 'sign' ? 'Signing…' : 'Sign down this layer'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={signDownAll}>
                  {busy === 'sign-all' ? 'Signing…' : 'Sign down all layers'}
                </button>
              </>
            )}
          </div>
        </div>

        {!layer.fot && (
          <div className="warn banner rpa-fot">
            Firm order terms are not on this layer yet — lines are collected against authorised FOT.
            {canEdit && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => proposeFot(layer)}>
                {busy === 'fot' ? 'Proposing…' : 'Propose firm order terms'}
              </button>
            )}
          </div>
        )}
        {layer.fot?.status === 'proposed' && (
          <div className="warn banner rpa-fot">
            Firm order terms v{layer.fot.version} proposed — awaiting authorisation by a second pair of eyes before lines are collected.
            {canAuthorise && user?.id !== layer.fot.proposed_by && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => authoriseFot(layer)}>
                {busy === 'fot' ? 'Authorising…' : 'Authorise'}
              </button>
            )}
          </div>
        )}
        {notice && (
          <div className="rpa-notice">
            <span>{notice.text}</span>
            {notice.action && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={notice.action.run}>{notice.action.label}</button>
            )}
          </div>
        )}
        <ErrorBanner error={error} />

        <div className="table-wrap">
          <table className="table rpa-resp-table">
            <thead>
              <tr>
                <th className="rpa-resp-who">Reinsurer / underwriter</th>
                <th>Status</th>
                <th className="r">Offered %</th>
                <th className="r">Written %</th>
                <th className="r">Signed % <span className="accent">· broker</span></th>
                <th className="r">Signed premium</th>
                <th className="rpa-resp-notes">Declinature reason / notes</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {layer.rows.length === 0 && (
                <tr><td colSpan="8" className="muted">No reinsurer has been written to or has answered on this layer.</td></tr>
              )}
              {layer.rows.map((row) => {
                const [tone, label] = STATUS[row.status] || STATUS.awaiting;
                const written = value(row, 'written_pct');
                const signed = value(row, 'signed_pct');
                const signedNum = signed === '' || signed == null ? null : Number(signed);
                const premium = signedNum != null && layer.premium100 != null ? layer.premium100 * (signedNum / 100) : null;
                const editable = canEdit && fotOk && row.status !== 'declined';
                return (
                  <tr key={row.market_id} className={`rpa-resp-row is-${row.status}`}>
                    <td className="rpa-resp-who">
                      <div className="rpa-resp-name">{row.market_name}</div>
                      <div className="rpa-book-sub">{[row.underwriter, row.rating].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td>
                      <Pill tone={tone}>{label}</Pill>
                      {canEdit && row.status !== 'declined' && (
                        <button type="button" className="rpa-linkbtn rpa-resp-decline" disabled={busy || (!row.line_id && !fotOk)} onClick={() => decline(row)}>
                          decline
                        </button>
                      )}
                    </td>
                    <td className="r num muted">{row.offered_pct != null ? pct(row.offered_pct) : '—'}</td>
                    <td className="r">
                      {editable ? (
                        <input
                          type="number" min="0" step="0.01" className="input rpa-cell num"
                          value={written ?? ''} placeholder="0.00"
                          aria-label={`${row.market_name} written percent`}
                          onChange={(e) => edit(row, 'written_pct', e.target.value)}
                        />
                      ) : <span className="num">{row.status === 'declined' ? 'nil' : pct(row.written_pct)}</span>}
                    </td>
                    <td className="r">
                      {editable && row.line_id ? (
                        <input
                          type="number" min="0" step="0.01" className={`input rpa-cell rpa-signed num${signedNum ? ' is-signed' : ''}`}
                          value={signed ?? ''} placeholder="—"
                          aria-label={`${row.market_name} signed percent`}
                          onChange={(e) => edit(row, 'signed_pct', e.target.value)}
                        />
                      ) : <span className="num">{row.status === 'declined' ? 'nil' : pct(row.signed_pct)}</span>}
                    </td>
                    <td className="r num">{premium != null ? `${layer.currency} ${fmtMoney(premium)}` : '—'}</td>
                    <td className="rpa-resp-notes">
                      {row.line_id && canEdit ? (
                        <input
                          className="rpa-notes-input"
                          value={value(row, 'notes') ?? ''}
                          placeholder={row.status === 'declined' ? 'Declinature reason' : '—'}
                          aria-label={`${row.market_name} notes`}
                          onChange={(e) => edit(row, 'notes', e.target.value)}
                        />
                      ) : row.status === 'awaiting' ? (
                        <span className="muted small">
                          {row.emailed_at ? `Sent ${fmtDate(row.emailed_at)} — no response yet` : 'Approached — no response yet'}
                        </span>
                      ) : <span className="small">{row.notes || '—'}</span>}
                    </td>
                    <td className="rpa-book-sub num">{row.received_at ? fmtDate(row.received_at) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {saving > 0 && <div className="muted small">Saving…</div>}

        <div className="rpa-resp-release">
          {canEdit && (
            <button type="button" className="btn btn-primary rpa-mail-send" disabled={busy || !allSigned} onClick={release}>
              {busy === 'release' ? 'Releasing…' : 'Release signed lines'}
            </button>
          )}
          <span className="rpa-resp-hint">
            {allSigned
              ? `Every layer signs to exactly its order. Releasing locks the signed lines and drafts one signing advice for every reinsurer with a line.`
              : `Every layer must sign to exactly its order before release. Short: ${
                shortLayers.map((l) => `${l.name} (${pct(l.signed_total)} of ${pct(l.order_pct)})`).join(', ')}.`}
          </span>
        </div>
      </section>
    </>
  );
}
