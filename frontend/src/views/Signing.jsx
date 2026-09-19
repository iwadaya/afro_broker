import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import {
  useFetch, Blueprint, SectionLabel, Pill, StatusPill, ErrorBanner,
  fmtMoney, fmtPct, fmtDate, fmtCompact,
} from '../components.jsx';
import { useScreenHead, useWorkspace } from '../shell.jsx';

/**
 * Signing (§04) — by contract.
 *
 * The workflow opens on a question, not on a layer: which contract's
 * signings? The chooser lists every placement with a programme, and the
 * one picked shows its programme — the layers in tower order with their
 * order, premium and firm order terms — and its signings: the written line
 * each market gave on each layer, and the line it signed. A layer not yet
 * signed shows the engine's preview in the signed column, marked as such;
 * the arithmetic and the apply stay on the layer's own worksheet.
 *
 * The contract lives in the URL (/signing/:id) so a reading can be linked;
 * /signing with no contract asks on arrival.
 */

const SIGNING_STATE = {
  SIGNED: ['green', 'Signed'],
  PARTLY_SIGNED: ['gold', 'Partly signed'],
  LINES_WRITTEN: ['gold', 'Lines written'],
  NO_LINES: ['grey', 'No lines yet'],
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** USD 20m xs USD 10m — the cover geometry as brokers write it. */
function coverOf(l) {
  if (l.limit_amt != null) return `${l.currency} ${fmtCompact(l.limit_amt)} xs ${fmtCompact(l.attachment || 0)}`;
  return `${l.currency} · ${l.type}`;
}

const factorText = (f) => (f == null ? '—' : Number(f).toFixed(6));

/** Where a layer stands, in the words the worksheet uses. */
function layerState(l) {
  if (l.status === 'BOUND') return { tone: 'green', label: 'Bound' };
  if (l.signing.applied) {
    return { tone: 'green', label: l.signing.method === 'client_instruction' ? 'Signed · client instruction' : 'Signed' };
  }
  if (l.lines.length) {
    const st = l.signing.preview.state;
    return { tone: 'gold', label: st === 'OVERSUBSCRIBED' ? 'Written · over the order' : st === 'UNDERSUBSCRIBED' ? 'Written · short' : 'Written · exact' };
  }
  if (l.fot?.status === 'authorised') return { tone: 'grey', label: 'Awaiting lines' };
  return { tone: 'grey', label: 'No lines' };
}

/** One sentence on where the engine would land an unsigned panel. */
function previewSentence(l) {
  const p = l.signing.preview;
  const order = fmtPct(l.order_pct);
  const written = fmtPct(l.signing.written_total);
  if (p.state === 'OVERSUBSCRIBED') {
    return `written ${written} against an order of ${order} signs down at a factor of ${factorText(p.factor)}${
      p.standing_total ? `, with ${fmtPct(p.standing_total)} reserved at written on the lines set to stand` : ''}`;
  }
  if (p.state === 'UNDERSUBSCRIBED') {
    return `written ${written} is ${fmtPct(p.shortfall)} short of the order of ${order} — every line signs at written once the shortfall is accepted`;
  }
  return `written ${written} matches the order exactly — every line signs at written`;
}

export default function Signing() {
  const { id } = useParams();
  const navigate = useNavigate();
  const ws = useWorkspace();
  const [choosing, setChoosing] = useState(!id);
  const [view, setView] = useState('layer');

  const ctx = useFetch('GET', id ? `/signing/contracts/${id}` : null, [id]);
  const c = ctx.data;

  // Arriving with no contract asks which; arriving with one shows it.
  useEffect(() => { setChoosing(!id); }, [id]);

  // The hub's contextual tiles follow the contract opened here.
  useEffect(() => {
    if (!c) return undefined;
    let alive = true;
    api('GET', `/placements/${c.contract.id}`)
      .then((p) => {
        if (!alive) return;
        ws.setPlacement(p);
        const layers = p.layers || [];
        const hot = layers.find((l) => l.status !== 'OPEN') || layers[0];
        if (hot) ws.setLayer({ ...hot, placement: p, position: layers.findIndex((x) => x.id === hot.id) + 1 });
      })
      .catch(() => { /* the screen stands on its own read model */ });
    return () => { alive = false; };
  }, [c?.contract.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const state = c ? SIGNING_STATE[c.signing_state] || SIGNING_STATE.NO_LINES : null;
  useScreenHead(
    'Signing',
    c ? `${c.contract.cedant} — ${c.contract.name}` : 'Signings by contract',
    c ? `${c.contract.reference} · ${state[1]}` : null,
  );

  return (
    <div className="screen sg-screen">
      <ErrorBanner error={ctx.error} />

      {choosing && (
        <ContractChooser
          currentId={id || null}
          workingId={ws.placement?.id || null}
          onChoose={(pick) => {
            setChoosing(false);
            if (pick.id !== id) navigate(`/signing/${pick.id}`);
          }}
          onClose={() => setChoosing(false)}
        />
      )}

      {!id && (
        <section className="blueprint rpa-stage-empty" data-testid="signing-empty">
          <span className="kicker accent">Signing</span>
          <h3 className="rpa-stage-empty-title">Choose a contract</h3>
          <p className="rpa-stage-empty-note">
            The signings open on a contract, never on nothing. Pick the programme, and its layers
            appear with the written line and the signed line of every market on each.
          </p>
          <div className="rpa-stage-empty-actions">
            <button type="button" className="btn btn-primary" onClick={() => setChoosing(true)} data-testid="signing-choose">
              Choose a contract
            </button>
          </div>
        </section>
      )}

      {id && !c && !ctx.error && <p className="muted">Opening the contract…</p>}

      {c && (
        <>
          <ContractPlate c={c} state={state} onChange={() => setChoosing(true)} />
          <Programme c={c} />
          <Signings c={c} view={view} setView={setView} />
        </>
      )}
    </div>
  );
}

/**
 * The pop-up on arrival: which contract? Every placement with a programme,
 * searchable by cedant, reference, class, treaty type or year, with where
 * its signing stands. The working placement, when it is on the list, comes
 * first.
 */
function ContractChooser({ currentId, workingId, onChoose, onClose }) {
  const list = useFetch('GET', '/signing/contracts?limit=200');
  const [q, setQ] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = list.data || [];
  const term = q.trim().toLowerCase();
  const filtered = useMemo(() => (term
    ? rows.filter((c) => [c.cedant, c.reference, c.name, c.class, c.treaty_type, c.class_of_business, c.uy]
      .some((v) => v && String(v).toLowerCase().includes(term)))
    : rows), [rows, term]);
  const working = filtered.find((c) => c.id === workingId && c.id !== currentId) || null;
  const rest = filtered.filter((c) => c !== working);

  return (
    <div className="cob-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="cob-panel rpa-choice-panel sg-choice-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sg-choice-title"
        data-testid="signing-contract-choice"
      >
        <div className="renew-head">
          <div>
            <div className="renew-kicker">SIGNING</div>
            <div className="renew-title" id="sg-choice-title">Which contract&rsquo;s signings?</div>
          </div>
          <button type="button" className="renew-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sg-choice-search">
          <input
            ref={inputRef}
            className="input"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by cedant, reference, class or year…"
            aria-label="Search contracts"
            data-testid="signing-contract-search"
          />
          <span className="sg-choice-count">
            {list.data ? (term ? `${filtered.length} of ${rows.length}` : plural(rows.length, 'contract')) : 'Loading…'}
          </span>
        </div>
        <ErrorBanner error={list.error} />
        <div className="sg-choice-list">
          {working && (
            <>
              <div className="sg-choice-group">Working placement</div>
              <ContractRow c={working} current={false} onChoose={onChoose} />
              {rest.length > 0 && <div className="sg-choice-group">Every contract with a programme</div>}
            </>
          )}
          {rest.map((c) => <ContractRow key={c.id} c={c} current={c.id === currentId} onChoose={onChoose} />)}
          {list.data && filtered.length === 0 && (
            <div className="sg-choice-none">
              {rows.length
                ? 'No contract matches that search. Try a cedant, a reference or a class.'
                : 'No contract has a programme yet — add layers to a placement first.'}
            </div>
          )}
        </div>
        <div className="rpa-choice-foot">
          A contract is a placement with a programme; its signings are the written and signed lines on each layer.
        </div>
      </div>
    </div>
  );
}

function ContractRow({ c, current, onChoose }) {
  const [tone, label] = SIGNING_STATE[c.signing_state] || SIGNING_STATE.NO_LINES;
  const meta = [
    plural(c.layer_count, 'layer'),
    c.markets ? plural(c.markets, 'market') : null,
    c.lines_signed ? `${c.lines_signed} signed` : c.lines_written ? `${c.lines_written} written` : null,
  ].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      className="sg-choice"
      aria-current={current ? 'true' : undefined}
      onClick={() => onChoose(c)}
      data-testid="signing-contract-option"
    >
      <span className="sg-choice-main">
        <span className="sg-choice-cedant">{c.cedant}</span>
        <span className="sg-choice-name">{c.name}{c.uy ? ` · ${c.uy}` : ''}</span>
        <span className="sg-choice-ref">{c.reference}{c.cedant_domicile ? ` · ${c.cedant_domicile}` : ''}</span>
      </span>
      <span className="sg-choice-side">
        <Pill tone={current ? 'green' : tone}>{current ? 'Open' : label}</Pill>
        <span className="sg-choice-meta">{meta}</span>
      </span>
    </button>
  );
}

/** The contract's header plate: who and what, and the signing in numbers. */
function ContractPlate({ c, state, onChange }) {
  const k = c.contract;
  const t = c.totals;
  const facts = [
    ['Period', `${fmtDate(k.inception, { shortYear: true })} → ${fmtDate(k.expiry, { shortYear: true })}`],
    ['Currency', k.currency],
    ['Layers', t.layers_with_lines ? `${t.layers} · ${t.layers_with_lines} with lines` : String(t.layers)],
    ['Markets on the panel', String(t.markets)],
    ['Lines', `${t.lines_written} written · ${t.lines_signed} signed`],
  ];
  return (
    <Blueprint className="sg-plate" data-testid="signing-plate">
      <div className="sg-plate-head">
        <div className="sg-plate-id">
          <span className="kicker accent">
            {k.reference} · underwriting year {k.uy || '—'}{k.treaty_type ? ` · ${k.treaty_type}` : ''}
            {' · placement '}<StatusPill value={k.status} />
          </span>
          <h2 className="sg-plate-title">{k.cedant}<br />{k.name}</h2>
        </div>
        <div className="sg-plate-actions">
          <Pill tone={state[0]}>{state[1]}</Pill>
          <Link className="btn btn-secondary" to={`/placements/${k.id}`}>Open placement</Link>
          <button type="button" className="btn btn-primary" onClick={onChange} data-testid="signing-change-contract">
            Change contract
          </button>
        </div>
      </div>
      <div className="factstrip" style={{ gridTemplateColumns: `repeat(${facts.length}, 1fr)` }}>
        {facts.map(([label, value]) => (
          <div className="factcell" key={label}>
            <div className="factlabel">{label}</div>
            <div className="factvalue">{value}</div>
          </div>
        ))}
      </div>
    </Blueprint>
  );
}

/** The programme: the layers in tower order, each with where its signing stands. */
function Programme({ c }) {
  return (
    <section>
      <div className="sechead">
        <SectionLabel>Programme</SectionLabel>
        <span className="hint">
          {plural(c.totals.layers, 'layer')} in tower order · order, premium and firm order terms per layer
        </span>
      </div>
      <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
        <table className="table sg-programme" data-testid="signing-programme">
          <thead>
            <tr>
              <th>Layer</th><th>Cover</th><th>Type</th><th className="r">Order</th>
              <th className="r">Premium 100%</th><th>FOT</th><th className="r">Written</th>
              <th className="r">Signed</th><th className="r">Factor</th><th>State</th><th />
            </tr>
          </thead>
          <tbody>
            {c.programme.map((l) => {
              const s = l.signing;
              const st = layerState(l);
              const hasLines = l.lines.length > 0;
              return (
                <tr key={l.id}>
                  <td>
                    <span className="sg-layer-n">Layer {l.position}</span>
                    <span className="sg-layer-name">{l.name}</span>
                  </td>
                  <td>{coverOf(l)}</td>
                  <td>{l.type}</td>
                  <td className="r">{fmtPct(l.order_pct)}</td>
                  <td className="r">{l.currency} {fmtMoney(l.premium100)}</td>
                  <td>
                    {l.fot
                      ? `v${l.fot.version} ${l.fot.status}${l.fot.rol != null ? ` · ROL ${fmtPct(l.fot.rol)}` : ''}`
                      : <span className="muted">none</span>}
                  </td>
                  <td className="r">{hasLines ? fmtPct(s.written_total) : '—'}</td>
                  <td className="r">
                    {s.applied
                      ? <span className="sg-signed">{fmtPct(s.signed_total)}</span>
                      : hasLines ? <span className="sg-preview" title="Preview — signing not yet applied">{fmtPct(s.preview.signed_total)}</span> : '—'}
                  </td>
                  <td className="r">
                    {s.applied
                      ? (s.method === 'client_instruction' ? 'instruction' : factorText(s.factor))
                      : hasLines ? <span className="sg-preview">{factorText(s.preview.factor)}</span> : '—'}
                  </td>
                  <td><Pill tone={st.tone}>{st.label}</Pill></td>
                  <td className="r">
                    <Link className="btn btn-secondary btn-sm" to={`/layers/${l.id}/signing`}>Worksheet</Link>
                  </td>
                </tr>
              );
            })}
            {c.programme.length === 0 && (
              <tr><td colSpan="11" className="muted">No layers on this contract yet.</td></tr>
            )}
          </tbody>
        </table>
      </Blueprint>
    </section>
  );
}

/** The signings, read by layer or by reinsurer. */
function Signings({ c, view, setView }) {
  return (
    <section>
      <div className="sechead">
        <SectionLabel>Signings</SectionLabel>
        <span className="hint">the written line each market gave on each layer, and the line it signed</span>
        <div className="sechead-actions">
          <div className="rpa-seg" role="group" aria-label="Read the signings by">
            <button type="button" aria-pressed={view === 'layer'} onClick={() => setView('layer')} data-testid="signing-view-layer">By layer</button>
            <button type="button" aria-pressed={view === 'market'} onClick={() => setView('market')} data-testid="signing-view-market">By reinsurer</button>
          </div>
        </div>
      </div>
      {view === 'layer'
        ? (
          <div className="sg-layers">
            {c.programme.map((l) => <LayerSignings key={l.id} layer={l} />)}
            {c.programme.length === 0 && (
              <Blueprint className="sg-layer"><p className="muted small sg-layer-empty">No layers on this contract yet.</p></Blueprint>
            )}
          </div>
        )
        : <MarketSignings c={c} />}
    </section>
  );
}

function LayerSignings({ layer: l }) {
  const s = l.signing;
  const st = layerState(l);
  const hasLines = l.lines.length > 0;
  const provisional = hasLines && !s.applied;
  const previewPremiumTotal = l.lines.reduce((a, x) => a + (x.preview_premium || 0), 0);

  return (
    <Blueprint className="sg-layer" data-testid="signing-layer">
      <div className="sg-layer-head">
        <div>
          <div className="kicker">Layer {l.position} · {coverOf(l)} · order {fmtPct(l.order_pct)} · premium 100% {l.currency} {fmtMoney(l.premium100)}</div>
          <div className="sg-layer-title">{l.name}</div>
        </div>
        <div className="sg-layer-stats">
          <div>
            <div className="fstat-value">{hasLines ? fmtPct(s.written_total) : '—'}</div>
            <div className="fstat-label">written</div>
          </div>
          <div>
            <div className={`fstat-value${provisional ? ' sg-preview' : ''}`}>
              {s.applied ? fmtPct(s.signed_total) : provisional ? fmtPct(s.preview.signed_total) : '—'}
            </div>
            <div className="fstat-label">{provisional ? 'signed · preview' : 'signed'}</div>
          </div>
          <div>
            <div className={`fstat-value${provisional ? ' sg-preview' : ''}`}>
              {s.applied
                ? (s.method === 'client_instruction' ? 'instruction' : factorText(s.factor))
                : provisional ? factorText(s.preview.factor) : '—'}
            </div>
            <div className="fstat-label">factor</div>
          </div>
        </div>
        <div className="sg-layer-actions">
          <Pill tone={st.tone}>{st.label}</Pill>
          <Link className="btn btn-secondary btn-sm" to={`/layers/${l.id}`}>Layer workspace</Link>
          <Link className="btn btn-primary btn-sm" to={`/layers/${l.id}/signing`}>Signing worksheet</Link>
        </div>
      </div>

      {hasLines ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Market</th><th>Ref</th><th className="r">Written line</th><th className="c">Stand</th>
                <th className="r">{s.applied ? 'Signed line' : 'Signed line · preview'}</th>
                <th className="r">Signed premium {l.currency}</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {l.lines.map((x) => (
                <tr key={x.id}>
                  <td style={{ fontWeight: 500 }}>
                    {x.market_name}
                    {x.market_rating ? <span className="muted small"> {x.market_rating}</span> : null}
                  </td>
                  <td className="mono small muted">{x.market_ref || '—'}</td>
                  <td className="r">{fmtPct(x.written_pct)}</td>
                  <td className="c">
                    {x.to_stand
                      ? <span className="standbtn on" title="Reserved at written">■</span>
                      : <span className="standbtn" title="Signs down with the panel">□</span>}
                  </td>
                  <td className={`r ${s.applied ? 'sg-signed' : 'sg-preview'}`}>
                    {fmtPct(s.applied ? x.signed_pct : x.preview_signed_pct)}
                  </td>
                  <td className={`r${s.applied ? '' : ' sg-preview'}`}>
                    {fmtMoney(s.applied ? x.premium_signed : x.preview_premium, 2)}
                  </td>
                  <td>{x.status === 'SIGNED' ? <Pill tone="green">Signed</Pill> : <Pill tone="gold">Written</Pill>}</td>
                </tr>
              ))}
              <tr className="total-row">
                <td className="total-label">Total</td>
                <td />
                <td className="r">{fmtPct(s.written_total)}</td>
                <td />
                <td className={`r signed-total${s.applied ? '' : ' sg-preview'}`}>
                  {fmtPct(s.applied ? s.signed_total : s.preview.signed_total)}
                </td>
                <td className={`r${s.applied ? '' : ' sg-preview'}`}>
                  {fmtMoney(s.applied ? s.premium_signed_total : previewPremiumTotal, 2)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small sg-layer-empty">
          {l.fot?.status === 'authorised'
            ? 'No lines written yet — the layer is collecting lines against its firm order terms.'
            : 'No lines on this layer — lines are collected once firm order terms are authorised.'}
        </p>
      )}

      {provisional && (
        <p className="sg-note">
          Signing has not been applied on this layer. The signed column is the engine&rsquo;s preview at the
          current stand set: {previewSentence(l)}. Apply it on the signing worksheet.
        </p>
      )}
      {l.declined.length > 0 && (
        <p className="muted small sg-layer-empty">Declined: {l.declined.map((d) => d.market_name).join(', ')}.</p>
      )}
    </Blueprint>
  );
}

/** The same lines read by reinsurer — one block per market, a row per layer it wrote. */
function MarketSignings({ c }) {
  const layersOf = new Map(c.programme.map((l) => [l.id, l]));
  const anyPreview = c.markets.some((m) => m.lines.some((x) => !x.applied));
  if (!c.markets.length) {
    return (
      <Blueprint className="sg-layer" style={{ marginTop: 10 }} data-testid="signing-by-market">
        <p className="muted small sg-layer-empty">No market has written a line on this contract yet.</p>
      </Blueprint>
    );
  }
  return (
    <Blueprint className="table-wrap sg-by-market" style={{ marginTop: 10 }} data-testid="signing-by-market">
      <table className="table">
        <thead>
          <tr>
            <th>Reinsurer</th><th>Layer</th><th className="r">Written line</th><th className="c">Stand</th>
            <th className="r">Signed line</th><th className="r">Signed premium</th><th>Status</th>
          </tr>
        </thead>
        {c.markets.map((m) => (
          <tbody key={m.market_id}>
            {m.lines.map((x, i) => {
              const l = layersOf.get(x.layer_id);
              return (
                <tr key={x.layer_id}>
                  {i === 0 && (
                    <td rowSpan={m.lines.length} className="sg-market-cell">
                      <span className="sg-market-name">{m.market_name}</span>
                      {m.market_rating ? <span className="muted small"> {m.market_rating}</span> : null}
                      <span className="muted small sg-market-meta">{plural(m.lines.length, 'layer')}</span>
                    </td>
                  )}
                  <td>Layer {x.layer_position} · {x.layer_name}</td>
                  <td className="r">{fmtPct(x.written_pct)}</td>
                  <td className="c">
                    {x.to_stand
                      ? <span className="standbtn on" title="Reserved at written">■</span>
                      : <span className="standbtn" title="Signs down with the panel">□</span>}
                  </td>
                  <td className={`r ${x.applied ? 'sg-signed' : 'sg-preview'}`}>
                    {fmtPct(x.applied ? x.signed_pct : x.preview_signed_pct)}
                    {!x.applied && <span className="sg-preview-mark" title="Preview — signing not yet applied">*</span>}
                  </td>
                  <td className={`r${x.applied ? '' : ' sg-preview'}`}>
                    {l?.currency} {fmtMoney(x.applied ? x.premium_signed : x.preview_premium, 2)}
                  </td>
                  <td>{x.status === 'SIGNED' ? <Pill tone="green">Signed</Pill> : <Pill tone="gold">Written</Pill>}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
      {anyPreview && (
        <p className="sg-note sg-note--table">* preview — signing has not been applied on that layer.</p>
      )}
    </Blueprint>
  );
}
