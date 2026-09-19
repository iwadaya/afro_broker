import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Card, useFetch, Form, StatusPill, ErrorBanner, Money, Pct } from '../components.jsx';
import { useHasRole } from '../auth.jsx';
import { useScreenHead } from '../shell.jsx';

/**
 * Market operations for a layer — the input paths behind the layer workspace:
 * approaching markets, capturing quotes and subjectivities, proposing firm
 * order terms, writing and declining lines, binding, and issuing documents.
 * The workspace at /layers/:id is the read-and-decide view over the same data.
 */
export default function LayerOperations() {
  const { id } = useParams();
  const broker = useHasRole('broker', 'admin');
  const authoriser = useHasRole('underwriter', 'admin');

  const layer = useFetch('GET', `/layers/${id}`, [id]);
  const board = useFetch('GET', `/layers/${id}/quote-board`, [id]);
  const fot = useFetch('GET', `/layers/${id}/fot`, [id]);
  const lines = useFetch('GET', `/layers/${id}/lines`, [id]);
  // Only reinsurers write lines, so the approach list is the reinsurer tab.
  const markets = useFetch('GET', '/markets?type=reinsurer&limit=200', []);
  const alloc = useFetch('GET', `/layers/${id}/premium-allocation`, [id]);

  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [instructing, setInstructing] = useState(false);

  const l = layer.data;
  useScreenHead(l ? `Layer · ${l.name}` : 'Layer', 'Market operations');
  if (layer.error) return <div className="screen"><ErrorBanner error={layer.error} /></div>;
  if (!l) return <div className="screen" />;

  const reloadAll = () => { layer.reload(); board.reload(); fot.reload(); lines.reload(); alloc.reload(); };
  async function act(fn) {
    setError(null);
    try { await fn(); } catch (e) { setError(e); }
  }

  const activeFot = fot.data?.find((f) => f.status === 'authorised');
  const marketOpts = (markets.data || []).map((m) => ({ value: m.id, label: m.name }));

  return (
    <div className="screen">
      <div className="breadcrumb">
        <Link to="/placements">Placements</Link> / <Link to={`/placements/${l.placement_id}`}>placement</Link> / {l.name}
      </div>
      <div className="card-head">
        <h1>{l.name}</h1>
        <StatusPill value={l.status} />
        <span className="actions">
          <Link className="btn btn-secondary" to={`/layers/${id}`}>Open layer workspace</Link>
        </span>
      </div>
      <ErrorBanner error={error} />

      <Card title="Layer">
        <dl className="kv">
          <dt>Type</dt><dd>{l.type}</dd>
          <dt>Attach / Limit</dt><dd><Money amount={l.attachment} /> xs <Money amount={l.limit_amt} /></dd>
          <dt>Order</dt><dd><Pct value={l.order_pct} /></dd>
          <dt>Premium 100%</dt><dd><Money amount={l.premium100} currency={l.currency} /></dd>
          <dt>Brokerage</dt>
          <dd>
            {broker && !['BOUND', 'CLOSED'].includes(l.status)
              ? <BrokerageEditor layerId={id} value={l.brokerage_pct} onSaved={reloadAll} onError={setError} />
              : <Pct value={l.brokerage_pct} />}
          </dd>
          {l.signing_method && (
            <><dt>Signing method</dt><dd>{l.signing_method === 'client_instruction' ? 'Client instruction' : 'Pro-rata sign-down'}</dd></>
          )}
          <dt>Reinstatements</dt>
          <dd>
            {l.reinstatements
              ? <>{l.reinstatements === 'UNLIMITED' ? 'Unlimited' : l.reinstatements}
                {l.reinstatement_pct != null && <> @ <Pct value={l.reinstatement_pct} /></>}</>
              : '—'}
          </dd>
          <dt>EGNPI / Rate</dt>
          <dd>
            {l.egnpi != null ? <Money amount={l.egnpi} currency={l.currency} /> : '—'}
            {l.rate_pct != null && <> @ <Pct value={l.rate_pct} /></>}
          </dd>
          <dt>AAD</dt>
          <dd>{l.aad != null ? <Money amount={l.aad} currency={l.currency} /> : '—'}</dd>
          <dt>Technical benchmark</dt>
          <dd>{board.data?.technical
            ? <>ROL {board.data.technical.technical_rate_on_line ?? '—'} <span className="muted small">({board.data.technical.source})</span></>
            : '—'}</dd>
        </dl>
      </Card>

      {/* ---- Marketing / quote board ---- */}
      <Card title="Quote board — technical vs market">
        {broker && (
          <Form
            submitLabel="Approach market"
            initial={{ role: 'follow' }}
            fields={[
              { name: 'market_id', label: 'Market', type: 'select', required: true, options: marketOpts },
              { name: 'role', label: 'Role', type: 'select', options: ['lead', 'follow'] },
            ]}
            onSubmit={async (v) => { await api('POST', `/layers/${id}/approaches`, v); board.reload(); }}
          />
        )}
        <ErrorBanner error={board.error} />
        <table>
          <thead><tr>
            <th>Market</th><th>Role</th><th>Quote</th><th className="right">ROL</th>
            <th className="right">Line</th><th className="right">vs Tech</th><th>Subj.</th><th>Status</th><th />
          </tr></thead>
          <tbody>
            {board.data?.markets?.map((m) => (
              <tr key={m.approach_id}>
                <td>{m.market_name}</td>
                <td>{m.role}</td>
                <td>{m.quote_type || '—'}</td>
                <td className="right">{m.rol ?? '—'}</td>
                <td className="right">{m.line_offered != null ? <Pct value={m.line_offered} /> : '—'}</td>
                <td className="right">{m.spread_vs_technical ?? '—'}</td>
                <td>{m.open_subjectivities > 0 ? `${m.open_subjectivities} open` : '—'}</td>
                <td><StatusPill value={m.quote_status || m.approach_status} /></td>
                <td className="right toolbar">
                  {broker && (
                    <QuoteActions
                      approachId={m.approach_id}
                      quoteId={m.quote_id}
                      quoteStatus={m.quote_status}
                      onChange={() => { board.reload(); }}
                      onError={setError}
                    />
                  )}
                </td>
              </tr>
            ))}
            {board.data?.markets?.length === 0 && <tr><td colSpan="9" className="muted">No approaches yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      {/* ---- FOT ---- */}
      <Card title="Firm Order Terms">
        {broker && (
          <Form
            submitLabel="Propose FOT"
            fields={[
              { name: 'rol', label: 'Agreed ROL', type: 'number', step: '0.0001' },
              { name: 'agreed_date', label: 'Agreed date', type: 'date' },
            ]}
            onSubmit={async (v) => {
              await api('POST', `/layers/${id}/fot`, { agreed_terms: { rol: v.rol }, agreed_date: v.agreed_date || undefined });
              fot.reload();
            }}
          />
        )}
        <ErrorBanner error={fot.error} />
        <table>
          <thead><tr><th>Version</th><th>Terms</th><th>Status</th><th>Authorised by</th><th /></tr></thead>
          <tbody>
            {fot.data?.map((f) => (
              <tr key={f.id}>
                <td>v{f.version}</td>
                <td className="small">{JSON.stringify(f.agreed_terms)}</td>
                <td><StatusPill value={f.status} /></td>
                <td>{f.authorised_by ? 'yes' : '—'}</td>
                <td className="right">
                  {authoriser && f.status === 'proposed' && (
                    <button className="small" onClick={() => act(async () => {
                      await api('POST', `/layers/${id}/fot/authorise`, {});
                      reloadAll();
                    })}>Authorise (4-eyes)</button>
                  )}
                </td>
              </tr>
            ))}
            {fot.data?.length === 0 && <tr><td colSpan="5" className="muted">No FOT proposed.</td></tr>}
          </tbody>
        </table>
        {!authoriser && fot.data?.some((f) => f.status === 'proposed') && (
          <p className="muted small">A proposal is awaiting an underwriter/admin to authorise (four-eyes).</p>
        )}
      </Card>

      {/* ---- Lines + signing ---- */}
      <Card title="Written lines & signing-down">
        {!activeFot && <p className="muted">Lines can be written once an FOT is authorised.</p>}
        {broker && activeFot && (
          <Form
            submitLabel="Write line"
            fields={[
              { name: 'market_id', label: 'Market', type: 'select', required: true, options: marketOpts },
              { name: 'written_pct', label: 'Written %', type: 'number', step: '0.0001', required: true },
              { name: 'to_stand', label: 'To stand', type: 'checkbox' },
            ]}
            onSubmit={async (v) => { await api('POST', `/layers/${id}/lines`, v); lines.reload(); setPreview(null); }}
          />
        )}
        <ErrorBanner error={lines.error} />
        <table>
          <thead><tr><th>Market</th><th className="right">Written</th><th>Stand</th><th className="right">Signed</th><th className="right">Premium</th><th>Status</th><th /></tr></thead>
          <tbody>
            {lines.data?.map((ln) => (
              <tr key={ln.id}>
                <td>{ln.market_name}</td>
                <td className="right"><Pct value={ln.written_pct} /></td>
                <td>{ln.to_stand ? '✓' : ''}</td>
                <td className="right">{ln.signed_pct != null ? <Pct value={ln.signed_pct} /> : '—'}</td>
                <td className="right"><Money amount={ln.premium_signed} currency={l.currency} /></td>
                <td><StatusPill value={ln.status} /></td>
                <td className="right">
                  {broker && !['SIGNED', 'DECLINED'].includes(ln.status) && l.status !== 'BOUND' && (
                    <button className="small ghost" onClick={() => act(async () => {
                      await api('POST', `/layers/${id}/lines/${ln.market_id}/decline`, {});
                      lines.reload(); setPreview(null);
                    })}>Decline</button>
                  )}
                </td>
              </tr>
            ))}
            {lines.data?.length === 0 && <tr><td colSpan="7" className="muted">No lines.</td></tr>}
          </tbody>
        </table>

        {broker && lines.data?.length > 0 && (
          <div className="toolbar" style={{ marginTop: 12 }}>
            <button className="small secondary" onClick={() => act(async () => {
              setPreview(await api('GET', `/layers/${id}/signing/preview`));
            })}>Preview signing</button>
            <button className="small" onClick={() => act(async () => {
              await api('POST', `/layers/${id}/signing/apply`, {});
              reloadAll(); setPreview(null);
            })}>Apply signing</button>
            <button className="small ghost" onClick={() => act(async () => {
              await api('POST', `/layers/${id}/signing/apply`, { accept_shortfall: true });
              reloadAll(); setPreview(null);
            })}>Apply (accept shortfall)</button>
            <button className="small ghost" onClick={() => setInstructing((s) => !s)}>
              {instructing ? '× Cancel instruction' : 'Client signing instruction'}
            </button>
          </div>
        )}
        {preview && (
          <div className={preview.state === 'UNDERSUBSCRIBED' ? 'err banner' : 'ok banner'}>
            <strong>{preview.state}</strong> — written {preview.writtenTotal}%, factor {preview.signingFactor},
            signed total {preview.signedTotal}%{preview.shortfall ? `, shortfall ${preview.shortfall}%` : ''}
            {preview.brokerage_total != null && <>, brokerage <Money amount={preview.brokerage_total} currency={l.currency} /></>}.
          </div>
        )}
        {instructing && (
          <SigningInstruction
            layerId={id}
            order={Number(l.order_pct)}
            lines={(lines.data || []).filter((ln) => ['WRITTEN', 'SIGNED'].includes(ln.status))}
            onApplied={() => { setInstructing(false); reloadAll(); }}
            onError={setError}
          />
        )}
      </Card>

      {/* ---- Bind + documents ---- */}
      <Card title="Bind & closing">
        <div className="toolbar">
          {broker && l.status === 'SIGNED' && (
            <button className="small secondary" onClick={() => act(async () => {
              await api('POST', `/layers/${id}/bind/propose`, {});
              setError(null); alert('Bind proposed — an underwriter/admin must authorise (four-eyes).');
            })}>Propose bind</button>
          )}
          {authoriser && l.status === 'SIGNED' && (
            <button className="small" onClick={() => act(async () => {
              await api('POST', `/layers/${id}/bind/authorise`, {});
              reloadAll();
            })}>Authorise bind (4-eyes)</button>
          )}
          {broker && ['SIGNED', 'BOUND'].includes(l.status) && (
            <button className="small ghost" onClick={() => act(async () => {
              await api('POST', `/layers/${id}/documents`, { type: 'closing' });
              alert('Closing document generated.');
            })}>Generate closing</button>
          )}
        </div>

        {alloc.data?.lines?.length > 0 && (
          <>
            <h3>Premium allocation (signed)</h3>
            <table>
              <thead><tr><th>Market</th><th className="right">Signed %</th><th className="right">Premium</th><th className="right">Brokerage</th></tr></thead>
              <tbody>
                {alloc.data.lines.map((a) => (
                  <tr key={a.market_id}>
                    <td>{a.market_name}</td>
                    <td className="right"><Pct value={a.signed_pct} /></td>
                    <td className="right"><Money amount={a.premium_signed} currency={l.currency} /></td>
                    <td className="right"><Money amount={a.brokerage_amount} currency={l.currency} /></td>
                  </tr>
                ))}
                <tr>
                  <td><strong>Total</strong></td>
                  <td className="right"><strong><Pct value={alloc.data.signed_total_pct} /></strong></td>
                  <td className="right"><strong><Money amount={alloc.data.premium_allocated} currency={l.currency} /></strong></td>
                  <td className="right"><strong><Money amount={alloc.data.brokerage_total} currency={l.currency} /></strong></td>
                </tr>
              </tbody>
            </table>
            <p className="muted small">
              Brokerage at <Pct value={alloc.data.layer?.brokerage_pct} /> of signed premium
              {alloc.data.layer?.signing_method === 'client_instruction' ? ' · signed per the client’s instruction' : ''}.
            </p>
          </>
        )}
      </Card>

      {l.type === 'XoL' && ['SIGNED', 'BOUND', 'CLOSED'].includes(l.status) && (
        <MdpPanel layerId={id} currency={l.currency} canEdit={broker} />
      )}

      <Documents layerId={id} placementId={l.placement_id} currency={l.currency} canEdit={broker} layerStatus={l.status} />
    </div>
  );
}

/** Inline brokerage % editor — the terms stay editable until the layer binds. */
function BrokerageEditor({ layerId, value, onSaved, onError }) {
  const [pct, setPct] = useState(value != null ? Number(value) : 0);
  const [busy, setBusy] = useState(false);
  const dirty = Number(pct) !== Number(value ?? 0);

  async function save() {
    onError(null);
    setBusy(true);
    try { await api('PATCH', `/layers/${layerId}`, { brokerage_pct: Number(pct) }); onSaved(); }
    catch (e) { onError(e); }
    finally { setBusy(false); }
  }

  return (
    <span className="toolbar" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input
        type="number" step="0.01" min="0" max="100" style={{ width: 90, textAlign: 'right' }}
        value={pct}
        onChange={(e) => setPct(e.target.value === '' ? '' : Number(e.target.value))}
      />
      <span>%</span>
      {dirty && <button className="small secondary" disabled={busy} onClick={save}>Save</button>}
    </span>
  );
}

/**
 * Client signing instruction editor: the cedant dictates each market's signed
 * line; the total must equal the order and no line may exceed its written %.
 */
function SigningInstruction({ layerId, order, lines, onApplied, onError }) {
  const [values, setValues] = useState(() => (
    Object.fromEntries(lines.map((ln) => [ln.market_id, ln.signed_pct != null ? Number(ln.signed_pct) : '']))
  ));
  const [busy, setBusy] = useState(false);

  const total = Object.values(values).reduce((a, v) => a + (v === '' ? 0 : Number(v)), 0);
  const rounded = Math.round(total * 1e4) / 1e4;

  async function apply() {
    onError(null);
    setBusy(true);
    try {
      const allocations = Object.entries(values)
        .filter(([, v]) => v !== '')
        .map(([market_id, v]) => ({ market_id, signed_pct: Number(v) }));
      await api('POST', `/layers/${layerId}/signing/instruction`, { allocations });
      onApplied();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <p className="muted small">
        Enter the signed line the client has instructed for each market. Omitted markets sign at 0%.
      </p>
      <table>
        <thead><tr><th>Market</th><th className="right">Written</th><th className="right">Instructed signed %</th></tr></thead>
        <tbody>
          {lines.map((ln) => (
            <tr key={ln.market_id}>
              <td>{ln.market_name}</td>
              <td className="right"><Pct value={ln.written_pct} /></td>
              <td className="right">
                <input
                  type="number" step="0.0001" min="0" max={Number(ln.written_pct)}
                  style={{ width: 110, textAlign: 'right' }}
                  value={values[ln.market_id]}
                  onChange={(e) => setValues((s) => ({ ...s, [ln.market_id]: e.target.value === '' ? '' : Number(e.target.value) }))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <span className={rounded === order ? 'ok banner' : 'err banner'} style={{ padding: '4px 10px' }}>
          Total {rounded}% / order {order}%
        </span>
        <button className="small" disabled={busy || rounded !== order} onClick={apply}>
          Apply client instruction
        </button>
      </div>
    </div>
  );
}

/** MDP: terms, the instalment schedule and per-market debit notes (XoL). */
function MdpPanel({ layerId, currency, canEdit }) {
  const mdp = useFetch('GET', `/layers/${layerId}/mdp`, [layerId]);
  const [error, setError] = useState(null);

  async function act(fn) {
    setError(null);
    try { await fn(); } catch (e) { setError(e); }
  }

  const m = mdp.data?.mdp;
  const notes = mdp.data?.notes || [];

  return (
    <Card title="MDP — minimum & deposit premium">
      <ErrorBanner error={error} />
      <ErrorBanner error={mdp.error} />
      {canEdit && <p><Link to="/claims-premiums/non-proportional/premium">Open Premium workspace to prepare MDP accounts and obtain independent approval →</Link></p>}
      {m && (
        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Version</dt><dd>v{m.version}</dd>
          <dt>Minimum / Deposit</dt>
          <dd><Money amount={m.minimum_premium} currency={currency} /> / <Money amount={m.deposit_premium} currency={currency} /></dd>
          <dt>Instalments</dt><dd>{m.instalments} × every {m.frequency_months} months from {m.first_due?.slice(0, 10)}</dd>
          {m.adjustment_rate_pct != null && <><dt>Adjustment rate</dt><dd><Pct value={m.adjustment_rate_pct} /></dd></>}
        </dl>
      )}
      {notes.length > 0 && (
        <>
          <h3>Debit notes (auto-generated per market)</h3>
          <table>
            <thead><tr>
              <th>#</th><th>Due</th><th>Market</th><th className="right">Signed</th>
              <th className="right">Gross</th><th className="right">Brokerage</th><th className="right">Net to market</th>
              <th>Status</th><th />
            </tr></thead>
            <tbody>
              {notes.map((n) => (
                <tr key={n.id}>
                  <td>{n.instalment_no}</td>
                  <td>{n.due_date?.slice(0, 10)}</td>
                  <td>{n.market_name}</td>
                  <td className="right"><Pct value={n.signed_pct} /></td>
                  <td className="right"><Money amount={n.gross_amount} currency={currency} /></td>
                  <td className="right"><Money amount={n.brokerage_amount} currency={currency} /></td>
                  <td className="right"><Money amount={n.net_amount} currency={currency} /></td>
                  <td><StatusPill value={n.status} /></td>
                  <td className="right toolbar">
                    {canEdit && n.status === 'pending' && (
                      <button className="small secondary" onClick={() => act(async () => {
                        await api('POST', `/mdp-notes/${n.id}/status`, { status: 'sent' });
                        mdp.reload();
                      })}>Mark sent</button>
                    )}
                    {canEdit && n.status === 'sent' && (
                      <button className="small" onClick={() => act(async () => {
                        await api('POST', `/mdp-notes/${n.id}/status`, { status: 'paid' });
                        mdp.reload();
                      })}>Mark paid</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {!m && !canEdit && <p className="muted">No MDP issued yet.</p>}
    </Card>
  );
}

/** Documents for the layer: list (filtered from the placement) + generate. */
function Documents({ layerId, placementId, currency, canEdit, layerStatus }) {
  const docs = useFetch('GET', `/placements/${placementId}/documents`, [placementId]);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const mine = (docs.data || []).filter((d) => d.layer_id === layerId);
  const signed = ['SIGNED', 'BOUND'].includes(layerStatus);

  async function gen(type) {
    setError(null);
    try { await api('POST', `/layers/${layerId}/documents`, { type }); docs.reload(); }
    catch (e) { setError(e); }
  }

  return (
    <Card title="Documents">
      {canEdit && (
        <div className="toolbar" style={{ marginBottom: 10 }}>
          <button className="small ghost" onClick={() => gen('mrc_slip')}>MRC slip</button>
          <button className="small ghost" onClick={() => gen('cover_note')}>Cover note</button>
          <button className="small ghost" onClick={() => gen('signing_slip')} disabled={!signed} title={signed ? '' : 'Layer must be signed'}>Signing slip</button>
          <button className="small ghost" onClick={() => gen('closing')} disabled={!signed} title={signed ? '' : 'Layer must be signed'}>Closing</button>
        </div>
      )}
      <ErrorBanner error={error} />
      <table>
        <thead><tr><th>Type</th><th>Version</th><th>Created</th><th /></tr></thead>
        <tbody>
          {mine.map((d) => (
            <tr key={d.id}>
              <td>{d.type}</td>
              <td>v{d.version}</td>
              <td className="small">{d.created_at?.replace('T', ' ').slice(0, 16)}</td>
              <td className="right"><button className="small secondary" onClick={() => setOpen(open === d.id ? null : d)}>{open === d.id ? 'Hide' : 'View'}</button></td>
            </tr>
          ))}
          {mine.length === 0 && <tr><td colSpan="4" className="muted">None generated.</td></tr>}
        </tbody>
      </table>
      {open && (
        <pre className="docview">{JSON.stringify(open.content, null, 2)}</pre>
      )}
    </Card>
  );
}

/** Inline quote capture + agree + subjectivities for one approach row. */
function QuoteActions({ approachId, quoteId, quoteStatus, onChange, onError }) {
  const [panel, setPanel] = useState(null); // 'quote' | 'subj' | null

  async function agree() {
    onError(null);
    try { await api('POST', `/quotes/${quoteId}/agree`, {}); onChange(); }
    catch (e) { onError(e); }
  }

  return (
    <span style={{ position: 'relative' }}>
      {quoteId && quoteStatus === 'active' && <button className="small secondary" onClick={agree}>Agree</button>}
      <button className="small ghost" onClick={() => setPanel((p) => (p === 'quote' ? null : 'quote'))}>{panel === 'quote' ? '×' : 'Quote'}</button>
      {quoteId && <button className="small ghost" onClick={() => setPanel((p) => (p === 'subj' ? null : 'subj'))}>{panel === 'subj' ? '×' : 'Subj'}</button>}
      {panel === 'quote' && (
        <div className="popover">
          <Form
            submitLabel="Capture"
            initial={{ type: 'firm' }}
            fields={[
              { name: 'type', label: 'Type', type: 'select', options: ['indicative', 'firm'] },
              { name: 'rol', label: 'ROL', type: 'number', step: '0.0001' },
              { name: 'line_offered', label: 'Line %', type: 'number', step: '0.0001' },
            ]}
            onSubmit={async (v) => { await api('POST', `/approaches/${approachId}/quotes`, v); setPanel(null); onChange(); }}
          />
        </div>
      )}
      {panel === 'subj' && quoteId && (
        <div className="popover">
          <Subjectivities quoteId={quoteId} onChange={onChange} onError={onError} />
        </div>
      )}
    </span>
  );
}

/** List, add and resolve subjectivities for a quote. */
function Subjectivities({ quoteId, onChange, onError }) {
  const subs = useFetch('GET', `/quotes/${quoteId}/subjectivities`, [quoteId]);
  const [text, setText] = useState('');

  async function add() {
    onError(null);
    try { await api('POST', `/quotes/${quoteId}/subjectivities`, { text }); setText(''); subs.reload(); onChange(); }
    catch (e) { onError(e); }
  }
  async function resolve(sid) {
    onError(null);
    try { await api('POST', `/subjectivities/${sid}/resolve`, {}); subs.reload(); onChange(); }
    catch (e) { onError(e); }
  }

  return (
    <div style={{ minWidth: 240 }}>
      <table>
        <tbody>
          {subs.data?.map((s) => (
            <tr key={s.id}>
              <td className={s.resolved ? 'muted' : ''}>{s.text}</td>
              <td className="right">{s.resolved ? '✓' : <button className="small secondary" onClick={() => resolve(s.id)}>Resolve</button>}</td>
            </tr>
          ))}
          {subs.data?.length === 0 && <tr><td className="muted">None.</td></tr>}
        </tbody>
      </table>
      <div className="toolbar" style={{ marginTop: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="New subjectivity" />
        <button className="small" disabled={!text} onClick={add}>Add</button>
      </div>
    </div>
  );
}

