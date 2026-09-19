import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, ErrorBanner, Pill, StatusPill, fmtMoney, fmtDate, fmtStamp } from '../../components.jsx';
import { useHasRole } from '../../auth.jsx';
import { useToast } from '../../toast.jsx';
import { StageEmpty } from './panels.jsx';
import { stageOf } from './stages.js';

/*
 * 06 Claims — proportional and non-proportional, on the contract the pack
 * was placed as.
 *
 * Claims open on a contract, never on nothing: the search in the header
 * finds one by reference, name, cedant or class, and a pack linked to its
 * placement opens on that contract. The contract, the basis and the open
 * claim live in the URL (?contract=…&basis=np&claim=…) so any state of the
 * screen can be linked. Every figure is the server's: the XoL engine's loss
 * to layer and reinstatement premium, the settlement domain's ladder and
 * each reinsurer's share of it, the bordereaux as ingested.
 */

const money = (ccy, v) => (v == null || v === '' || Number.isNaN(Number(v))
  ? '—'
  : `${ccy ? `${ccy} ` : ''}${fmtMoney(v, Number(v) % 1 ? 2 : 0)}`);
const bracket = (ccy, v) => (Number(v) ? `(${money(ccy, v)})` : '—');
const pct = (v, dp = 1) => (v == null || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(dp)}%`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CASH_TONE = {
  'Cash call issued': 'blue', 'Cash call funded': 'green', 'PLA sent': 'gold', 'Advice only': 'neutral', Settled: 'neutral',
};
const BDX_TONE = { Reconciled: 'green', 'Awaiting cedant': 'gold', 'Query raised': 'red', Superseded: 'neutral' };
const SOURCE_LABEL = { broker_claims_inbox: 'Broker claims inbox', cedant_claims_inbox: 'Cedant claims inbox', cedant_portal: 'Cedant portal' };

/** The desk's own URL state, beside ?tab=: the contract, the basis, the open claim. */
function useDeskParams() {
  const [params, setParams] = useSearchParams();
  const set = useCallback((patch) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '') next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: true });
  }, [setParams]);
  return [params, set];
}

export default function ClaimsTab({ shared }) {
  const { analysis: a } = shared;
  const stage = stageOf('claims');
  const [params, setParam] = useDeskParams();
  const contractId = params.get('contract') || a.placement?.id || null;
  const open = useCallback((id) => setParam({ contract: id, claim: null, basis: null }), [setParam]);

  return (
    <div className="rpa-claims">
      <div className="rpa-cl-head">
        <div>
          <h3 className="rpa-resp-title">Claims</h3>
          <div className="muted small rpa-cl-lede">
            Search a contract by name, cedant, class or reference — the screen renders against the contract you open
          </div>
        </div>
        <ContractSearch currentId={contractId} onOpen={open} />
      </div>

      {contractId ? (
        <Contract
          key={contractId}
          id={contractId}
          claimId={params.get('claim') || null}
          basisParam={params.get('basis')}
          setParam={setParam}
        />
      ) : (
        <StageEmpty
          stage={stage}
          title="Open a contract"
          note="Claims open on a contract, never on nothing. Search above by name, cedant, class or reference; a pack linked to its placement on the Renewal pack tab opens on that contract."
        >
          <button type="button" className="btn btn-secondary" onClick={() => shared.setTab('pack')}>Link a placement</button>
        </StageEmpty>
      )}
    </div>
  );
}

/** The search in the header: reference, name, cedant and class, over the contracts with layers. */
function ContractSearch({ currentId, onOpen }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const term = q.trim();

  useEffect(() => {
    if (!term) { setResults(null); setError(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      api('GET', `/claims/contracts?q=${encodeURIComponent(term)}`)
        .then((rows) => { if (alive) { setResults(rows); setError(null); } })
        .catch((e) => { if (alive) setError(e); });
    }, 180);
    return () => { alive = false; clearTimeout(t); };
  }, [term]);

  const chip = (c) => (c.id === currentId ? ['green', 'Open']
    : c.sections.np && c.sections.p ? ['blue', 'Both sections']
      : c.sections.np ? ['blue', 'Non-proportional']
        : c.sections.p ? ['blue', 'Proportional'] : ['neutral', 'No layers']);

  return (
    <div className="rpa-cl-search" onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}>
      <input
        className="input rpa-cl-search-input"
        aria-label="Search contracts"
        placeholder="Search contracts — Risk XL, Britam, KE-RXL-2027…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {term && (
        <div className="rpa-cl-results">
          <div className="rpa-cl-results-head">
            <span>{results ? plural(results.length, 'contract') : 'Searching…'}</span>
            <button type="button" className="rpa-linkbtn" onClick={() => setQ('')}>Clear</button>
          </div>
          {error && <div className="rpa-cl-noresult">{error.message}</div>}
          {results?.map((c) => {
            const [tone, label] = chip(c);
            return (
              <button
                key={c.id}
                type="button"
                className="rpa-cl-result"
                aria-current={c.id === currentId ? 'true' : undefined}
                onClick={() => { onOpen(c.id); setQ(''); }}
              >
                <span className="rpa-cl-result-line">
                  <span className="rpa-cl-result-name">{c.name}</span>
                  <Pill tone={tone}>{label}</Pill>
                </span>
                <span className="rpa-cl-result-cedant">{c.cedant || 'No cedant on the placement'}</span>
                <span className="rpa-cl-result-ref">{c.reference} · {c.structure}</span>
              </button>
            );
          })}
          {results && results.length === 0 && (
            <div className="rpa-cl-noresult">No contract matches that search. Try a cedant, a class or a reference.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** One contract: the header plate, the KPIs, and the basis in view. */
function Contract({ id, claimId, basisParam, setParam }) {
  const ctx = useFetch('GET', `/claims/contracts/${id}`, [id]);
  const c = ctx.data;
  const toast = useToast();

  if (ctx.error) return <ErrorBanner error={ctx.error} />;
  if (!c) return <p className="muted">Opening the contract…</p>;

  const basis = basisParam === 'p' || basisParam === 'np' ? basisParam : (c.basis === 'p' ? 'p' : 'np');
  const isNP = basis === 'np';
  const claimOpen = isNP && Boolean(claimId);
  const cells = [
    ['Class', c.contract.class], ['Structure', c.contract.structure], ['Period', c.contract.period],
    ['Currency', c.contract.currency], ['Order placed', c.contract.order], ['Claims sections', c.contract.sections.label],
  ];

  return (
    <>
      <section className="blueprint rpa-cl-plate">
        <div className="rpa-cl-plate-head">
          <div className="rpa-cl-plate-id">
            <div className="rpa-secname-row">
              <span className="kicker accent">{c.contract.reference} · underwriting year {c.contract.uy || '—'}</span>
              <StatusPill value={c.contract.status} />
            </div>
            <h2 className="rpa-cl-plate-title">{c.contract.cedant || 'No cedant on the placement'}<br />{c.contract.name}</h2>
          </div>
          <div className="rpa-seg" role="group" aria-label="Claims basis">
            <button type="button" aria-pressed={isNP} onClick={() => setParam({ basis: 'np', claim: null })}>Non-proportional</button>
            <button type="button" aria-pressed={!isNP} onClick={() => setParam({ basis: 'p', claim: null })}>Proportional</button>
          </div>
        </div>
        <div className="rpa-facts rpa-facts--3 rpa-cl-facts">
          {cells.map(([k, v]) => (
            <div key={k} className="rpa-fact">
              <div className="rpa-fact-k">{k}</div>
              <div className="rpa-fact-v">{v || '—'}</div>
            </div>
          ))}
        </div>
      </section>

      {!claimOpen && <Kpis c={c} basis={basis} />}
      {isNP
        ? <NonProportional c={c} claimId={claimId} setParam={setParam} reload={ctx.reload} announce={toast} />
        : <Proportional c={c} />}
    </>
  );
}

function Kpis({ c, basis }) {
  const ccy = c.contract.currency;
  let cells;
  if (basis === 'np') {
    if (!c.np) return null;
    const k = c.np.kpis;
    cells = [
      ['Advices open', String(k.open), k.cash_calls ? `${plural(k.cash_calls, 'cash call')} outstanding` : 'No cash call outstanding'],
      ['Incurred to layers', money(ccy, k.incurred_to_layers), k.layers_reached.length ? `Across ${k.layers_reached.join(', ')}` : 'No layer reached'],
      ['Paid', money(ccy, k.paid), k.incurred > 0 && k.paid > 0 ? `${pct((k.paid / k.incurred) * 100)} of incurred` : 'Nothing paid yet'],
      ['Cash calls due', money(ccy, k.net_due), `${plural(c.np.panel_size, 'reinsurer')} on the signed panel`],
    ];
  } else {
    if (!c.p) return null;
    const k = c.p.kpis;
    cells = [
      ['Sections', String(k.sections), c.contract.structure],
      ['Premium ceded YTD', money(ccy, k.premium_ceded_ytd), k.year ? `${k.year} accounts` : 'All accounts'],
      ['Claims paid YTD', money(ccy, k.claims_paid_ytd), `OS reserves ${money(ccy, k.outstanding_ytd)}`],
      ['Blended loss ratio', k.blended_loss_ratio_pct != null ? pct(k.blended_loss_ratio_pct) : '—',
        k.unreconciled ? `${plural(k.unreconciled, 'bordereau', 'bordereaux')} unreconciled` : 'All bordereaux reconciled'],
    ];
  }
  return (
    <div className="rpa-kpis rpa-kpis--grid rpa-cl-kpis">
      {cells.map(([k, v, note]) => (
        <div key={k} className="rpa-kpi">
          <div className="rpa-kpi-k">{k}</div>
          <div className="rpa-kpi-v num">{v}</div>
          <div className="rpa-kpi-n">{note}</div>
        </div>
      ))}
    </div>
  );
}

/** The other basis, on a contract written one way: named, never blank. */
function BasisEmpty({ title, c, basis }) {
  return (
    <div className="blueprint rpa-cl-empty">
      <div className="rpa-cl-empty-title">{title}</div>
      <div className="rpa-cl-empty-note">
        This contract has no {basis} section. {c.contract.name} is written as {c.written_as}.
      </div>
    </div>
  );
}

// ── Non-proportional ────────────────────────────────────────────────────

function NonProportional({ c, claimId, setParam, reload, announce }) {
  if (!c.np) return <BasisEmpty title="No excess of loss section on this contract" c={c} basis="non-proportional" />;
  if (claimId) return <ClaimWorkspace c={c} claimId={claimId} setParam={setParam} reloadContract={reload} announce={announce} />;
  return <AdvicesList c={c} setParam={setParam} reload={reload} announce={announce} />;
}

function AdvicesList({ c, setParam, reload, announce }) {
  const canAct = useHasRole('broker', 'admin');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [pasting, setPasting] = useState(false);
  const ccy = c.contract.currency;
  const np = c.np;

  async function act(key, fn, then) {
    setBusy(key);
    setError(null);
    try {
      const out = await fn();
      reload();
      if (then) then(out);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  const load = (n) => act(`load:${n.id}`, () => api('POST', `/claim-notifications/${n.id}/load`, {}), (out) => {
    const ref = out.loss_event?.reference || out.loss_event?.name || 'the claim';
    announce(out.already
      ? `${ref} was already loaded from this notice.`
      : `Claim ${ref} loaded from the inbox and preliminary loss advice sent to ${out.advice ? plural(out.advice.delivered, 'panel reinsurer') : 'the panel'}.`);
    if (out.loss_event?.id) setParam({ claim: out.loss_event.id });
  });
  const park = (n) => act(`park:${n.id}`, () => api('POST', `/claim-notifications/${n.id}/park`, {}),
    () => announce('Parked for triage. It stays on this contract until it is matched or loaded.'));
  const match = (n) => act(`match:${n.id}`, () => api('POST', `/claim-notifications/${n.id}/match`, { placement_id: c.contract.id }),
    () => announce(`Matched to ${c.contract.reference} on your say-so — load it to advise the panel.`));
  const ingest = (input) => act('ingest', () => api('POST', '/claim-notifications/ingest', input), (out) => {
    const n = out.notification;
    setPasting(false);
    if (out.duplicate) announce('That advice had already been read — the notice is the one on record.');
    else if (n.placement_id === c.contract.id) announce(`Read and matched to ${c.contract.reference} on ${n.match_basis}.`);
    else if (n.placement_id) announce(`Read and matched to ${n.placement_reference} — open that contract to load it.`);
    else announce('Read, but not matched with confidence — it is held for triage below when its best match is this contract.');
  });

  return (
    <>
      <section className="blueprint rpa-cl-section">
        <div className="rpa-cl-sechead">
          <h3 className="rpa-cl-h2">Inbox monitoring</h3>
          <span className="kicker accent">Loss advices matched to contracts automatically</span>
        </div>
        <div className="rpa-inbox">
          {np.inbox.map((b) => (
            <div key={b.key} className="rpa-inbox-src">
              <span className={`rpa-inbox-dot${b.state === 'Not connected' ? ' is-off' : ''}`} aria-hidden="true" />
              <span>
                <span className="rpa-inbox-box">{b.box}</span>
                <span className="rpa-inbox-note">{b.note} · {b.state}</span>
              </span>
            </div>
          ))}
        </div>

        {np.notifications.map((n) => (
          <NotificationCard
            key={n.id}
            n={n}
            ccy={ccy}
            panelSize={np.panel_size}
            canAct={canAct}
            busy={busy}
            onLoad={() => load(n)}
            onPark={() => park(n)}
            onMatch={() => match(n)}
          />
        ))}

        <div className="rpa-cl-inbox-foot">
          {np.notifications.length === 0 && (
            <span className="muted small">No advice is waiting on this contract. Matched notices appear here to load; a loaded one is on the advices below.</span>
          )}
          {canAct && !pasting && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPasting(true)}>Paste an advice</button>
          )}
        </div>
        {pasting && <PasteAdvice busy={busy === 'ingest'} onCancel={() => setPasting(false)} onSubmit={ingest} />}
        <ErrorBanner error={error} />
      </section>

      <section className="blueprint rpa-cl-section">
        <div className="rpa-cl-sechead">
          <h3 className="rpa-cl-h2">Excess of loss advices</h3>
          <span className="kicker accent">Per risk · per layer erosion</span>
        </div>
        <div className="table-wrap rpa-cl-tablewrap">
          <table className="table rpa-cl-table">
            <thead>
              <tr>
                <th>Reference</th><th>Insured / cause</th><th>DOL</th><th>Layer</th>
                <th className="r">Incurred</th><th className="r">Paid</th><th className="r">Outstanding</th>
                <th className="rpa-cl-erosion-col">Layer erosion</th><th>Cash call</th>
              </tr>
            </thead>
            <tbody>
              {np.advices.length === 0 && (
                <tr><td colSpan="9" className="muted">No loss advised on this contract yet. A notice loaded from the inbox appears here.</td></tr>
              )}
              {np.advices.map((r) => (
                <tr
                  key={r.id}
                  className="rpa-cl-row"
                  tabIndex={0}
                  onClick={() => setParam({ claim: r.id })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setParam({ claim: r.id }); } }}
                >
                  <td className="rpa-cl-ref">{r.reference}</td>
                  <td><div>{r.insured}</div><div className="rpa-book-sub">{r.cause || '—'}</div></td>
                  <td className="rpa-cl-dol">{fmtDate(r.loss_date)}</td>
                  <td className="rpa-cl-layer">{r.layer || '—'}</td>
                  <td className="r num">{money(ccy, r.incurred)}</td>
                  <td className="r num">{money(ccy, r.paid)}</td>
                  <td className="r num">{money(ccy, r.outstanding)}</td>
                  <td><Erosion value={r.erosion_pct} layer={r.layer} /></td>
                  <td><Pill tone={CASH_TONE[r.cash_status] || 'neutral'}>{r.cash_status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Erosion({ value, layer }) {
  if (value == null || !layer) return <span className="rpa-erosion-txt">Below the programme</span>;
  const width = Math.max(0, Math.min(100, Number(value)));
  return (
    <>
      <div className="rpa-erosion" role="img" aria-label={`${pct(value)} of ${layer} limit`}>
        <div className="rpa-erosion-fill" style={{ width: `${width}%` }} />
      </div>
      <div className="rpa-erosion-txt">{pct(value)} of {layer} limit</div>
    </>
  );
}

function NotificationCard({ n, ccy, panelSize, canAct, busy, onLoad, onPark, onMatch }) {
  const p = n.parsed || {};
  const conf = n.match_confidence != null ? Math.round(Number(n.match_confidence) * 100) : null;
  const [tone, tag] = n.status === 'matched' ? ['blue', 'New claim notification']
    : n.status === 'parked' ? ['neutral', 'Parked for triage'] : ['gold', 'Needs a match'];
  const explain = n.status === 'matched'
    ? `Matched on ${n.match_basis}${conf != null ? ` at ${conf}% confidence` : ''}. Loading creates the loss event, runs it against the layers and issues the preliminary loss advice to the full signed panel.`
    : n.status === 'parked'
      ? `Parked${n.parked_by_name ? ` by ${n.parked_by_name}` : ''}${n.notes ? ` — ${n.notes}` : ''}. Match it to this contract to load it.`
      : `Suggested on ${n.match_basis || 'the particulars'}${conf != null ? ` at ${conf}% confidence` : ''} — below the mark for an automatic match. Confirm it to load.`;
  const facts = [
    ['Reference', p.cedant_reference || p.treaty_reference || '—'],
    ['Insured', p.insured || '—'],
    ['Date of loss', p.date_of_loss ? fmtDate(p.date_of_loss) : '—'],
    ['Attaches', n.attaches || '—'],
    ['Reserve advised', Number(p.advised_reserve) ? money(p.currency || ccy, p.advised_reserve) : 'Not advised'],
  ];
  const busyHere = busy && busy.endsWith(`:${n.id}`);
  return (
    <div className={`rpa-notif is-${n.status}`}>
      <div className="rpa-notif-head">
        <Pill tone={tone}>{tag}</Pill>
        <span className="rpa-notif-subject">{n.subject || p.summary || 'Loss advice'}</span>
        <span className="rpa-notif-meta">{n.sender || SOURCE_LABEL[n.source] || n.source} · {fmtStamp(n.received_at)}</span>
      </div>
      <div className="rpa-notif-facts">
        {facts.map(([k, v]) => (
          <div key={k} className="rpa-notif-fact">
            <div className="rpa-notif-k">{k}</div>
            <div className="rpa-notif-v">{v}</div>
          </div>
        ))}
      </div>
      <div className="rpa-notif-actions">
        {n.status === 'matched' ? (
          <button type="button" className="btn btn-primary" disabled={!canAct || Boolean(busy) || !panelSize} onClick={onLoad}>
            {busyHere ? 'Loading…' : `Load claim & send PLA to ${plural(panelSize, 'reinsurer')}`}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!canAct || Boolean(busy)} onClick={onMatch}>
            {busyHere ? 'Matching…' : 'Match to this contract'}
          </button>
        )}
        {n.status !== 'parked' && (
          <button type="button" className="btn btn-secondary" disabled={!canAct || Boolean(busy)} onClick={onPark}>Park for triage</button>
        )}
        <span className="rpa-notif-match">
          {explain}
          {n.status === 'matched' && !panelSize ? ' No market has a signed line on this contract yet, so the advice has nobody to go to — sign the lines first.' : ''}
        </span>
      </div>
    </div>
  );
}

/** With no mailbox connected, an advice is pasted in and read the same way. */
function PasteAdvice({ busy, onCancel, onSubmit }) {
  const [sender, setSender] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  return (
    <form
      className="rpa-paste"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim()) return;
        onSubmit({ source: 'broker_claims_inbox', sender: sender.trim() || undefined, subject: subject.trim() || undefined, body });
      }}
    >
      <div className="kicker accent">Paste an advice — read and matched like one that arrived by mail</div>
      <div className="rpa-paste-row">
        <input className="input" aria-label="From" placeholder="From (sender)" value={sender} onChange={(e) => setSender(e.target.value)} />
        <input className="input" aria-label="Subject" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <textarea
        className="input rpa-paste-body"
        aria-label="Advice text"
        placeholder={'Treaty reference: …\nClaim reference: …\nInsured: …\nDate of loss: …\nCause: …\nAdvised reserve: USD …'}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="rpa-paste-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !body.trim()}>{busy ? 'Reading…' : 'Read and match'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── The claim workspace ─────────────────────────────────────────────────

const LADDER_FIELDS = ['gross_loss', 'lae', 'salvage', 'cash_funded'];

function ClaimWorkspace({ c, claimId, setParam, reloadContract, announce }) {
  const canAct = useHasRole('broker', 'admin');
  const ev = useFetch('GET', `/losses/${claimId}`, [claimId]);
  const advices = useFetch('GET', `/losses/${claimId}/advices`, [claimId]);
  const draft = useFetch('GET', `/losses/${claimId}/advice-draft`, [claimId]);
  const e = ev.data;
  const ccy = c.contract.currency;

  const [fields, setFields] = useState({});
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  // The ladder's inputs follow the record; the draft follows the ladder
  // until the broker has edited it.
  useEffect(() => {
    if (!e) return;
    setFields(Object.fromEntries(LADDER_FIELDS.map((f) => [f, e[f] == null ? '' : String(e[f])])));
  }, [e]);
  useEffect(() => {
    if (!draft.data || dirty) return;
    setSubject(draft.data.subject);
    setBody(draft.data.body);
  }, [draft.data, dirty]);

  if (ev.error) return <ErrorBanner error={ev.error} />;
  if (!e) return <p className="muted">Opening the claim…</p>;
  if (e.placement_id !== c.contract.id) {
    return (
      <div className="blueprint rpa-cl-empty">
        <div className="rpa-cl-empty-title">That claim is on another contract</div>
        <button type="button" className="btn btn-secondary" onClick={() => setParam({ claim: null })}>Back to advices</button>
      </div>
    );
  }

  const ladder = e.settlement?.ladder || null;
  const markets = e.settlement?.markets || [];
  const pla = (advices.data || []).find((x) => x.kind === 'preliminary') || null;
  const claimAdvice = (advices.data || []).find((x) => x.kind === 'claim') || null;
  const settled = e.status === 'settled';
  const panel = c.np.panel || [];
  const whoIs = new Map(panel.map((m) => [m.market_id, m]));
  const adviceStatus = new Map((claimAdvice?.recipients || []).map((r) => [r.market_id, r.status]));
  const ref = e.reference || e.name;
  const attaching = ladder?.attaching_layer ? ladder.layers.find((l) => l.layer_id === ladder.attaching_layer.id) : null;
  const locked = !canAct || Boolean(busy) || settled;

  async function act(key, fn, then) {
    setBusy(key);
    setError(null);
    try {
      const out = await fn();
      if (then) then(out);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }
  const afterCalc = () => { ev.reload(); draft.reload(); reloadContract(); };
  const recalc = (patch) => act('calc', async () => {
    if (patch) await api('PATCH', `/losses/${e.id}`, patch);
    return api('POST', `/losses/${e.id}/calculate`);
  }, afterCalc);
  const commit = (field) => {
    const raw = String(fields[field] ?? '').replace(/[,\s]/g, '');
    const v = raw === '' ? 0 : Number(raw);
    if (Number.isNaN(v) || v < 0 || v === Number(e[field] ?? 0)) {
      setFields((f) => ({ ...f, [field]: e[field] == null ? '' : String(e[field]) }));
      return;
    }
    recalc({ [field]: v });
  };
  const sendPla = () => act('pla', () => api('POST', `/losses/${e.id}/preliminary-advice`, { resend: true }), (out) => {
    advices.reload();
    reloadContract();
    announce(`Preliminary loss advice sent to ${plural(out.advice.delivered, 'panel reinsurer')} for ${ref}.`);
  });
  const sendAdvice = () => act('advice', () => api('POST', `/losses/${e.id}/claim-advice`, { subject, body }), (out) => {
    advices.reload();
    reloadContract();
    announce(`Claim advice sent to ${plural(out.delivered, 'reinsurer')} — net ${money(ccy, ladder?.net_due)} apportioned by signed line.${
      out.skipped?.length ? ` No underwriter on file for ${out.skipped.join(', ')}.` : ''}`);
  });

  const ladderInput = (field, label, sub) => (
    <div className="rpa-ladder-row">
      <label className="rpa-ladder-k" htmlFor={`rpa-ladder-${field}`}>
        {label}
        {sub && <span className="rpa-ladder-sub">{sub}</span>}
      </label>
      <input
        id={`rpa-ladder-${field}`}
        className="input rpa-ladder-input num"
        inputMode="decimal"
        disabled={locked}
        value={fields[field] ?? ''}
        onChange={(ev2) => setFields((f) => ({ ...f, [field]: ev2.target.value }))}
        onBlur={() => commit(field)}
        onKeyDown={(ev2) => { if (ev2.key === 'Enter') { ev2.preventDefault(); ev2.target.blur(); } }}
      />
    </div>
  );

  return (
    <>
      <div className="rpa-claim-head">
        <div className="rpa-claim-id">
          <div className="rpa-secname-row">
            <span className="kicker accent">{c.contract.reference} · {c.contract.name}</span>
            <Pill tone={pla ? 'green' : 'gold'}>{pla ? `PLA sent to ${plural(pla.delivered, 'reinsurer')}` : 'PLA not yet sent'}</Pill>
            {settled && <Pill tone="neutral">Settled</Pill>}
          </div>
          <h2 className="rpa-claim-title">{ref}{e.insured && e.insured !== ref ? ` · ${e.insured}` : ''}</h2>
          <div className="rpa-claim-sub">
            {e.cause || e.description || 'Cause not advised'} · date of loss {fmtDate(e.loss_date)}
            {attaching ? ` · ${attaching.layer_name} — limit ${money(ccy, attaching.limit)}` : ladder ? ' · below the programme at the figure advised' : ''}
          </div>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => setParam({ claim: null })}>Back to advices</button>
      </div>

      <div className="rpa-claim-grid">
        <section className="blueprint rpa-cl-card rpa-ladder">
          <div className="rpa-cl-sechead">
            <h3 className="rpa-cl-h3">Settlement calculation — 100% of layer</h3>
            {ladder && (
              <button type="button" className="btn btn-ghost btn-sm" disabled={locked} onClick={() => recalc({ waive_reinstatement: !e.waive_reinstatement })}>
                {ladder.reinstatement_waived ? 'Apply reinstatement' : 'Waive reinstatement'}
              </button>
            )}
          </div>
          {ladderInput('gross_loss', 'Gross loss advised (100%)', 'From the ground up, as the cedant advises it')}
          <div className="rpa-ladder-row is-gross">
            <span className="rpa-ladder-k">
              Gross loss to layer
              <span className="rpa-ladder-sub">
                {attaching
                  ? `${attaching.layer_name} · ${pct(attaching.erosion_pct)} of the limit${ladder.layers_reached > 1 ? ` · ${plural(ladder.layers_reached, 'layer')} reached` : ''}`
                  : ladder ? 'Below the programme at the figure advised' : 'Not yet run against the layers'}
              </span>
            </span>
            <span className="rpa-ladder-v num">{money(ccy, ladder?.gross_to_layer)}</span>
          </div>
          {ladderInput('lae', 'Add loss adjustment expenses')}
          {ladderInput('salvage', 'Less salvage & recoveries')}
          <div className="rpa-ladder-row is-rip">
            <span className="rpa-ladder-k">
              Less reinstatement premium
              <span className="rpa-ladder-sub">
                {!ladder ? '—'
                  : ladder.reinstatement_waived ? `Waived · would be ${money(ccy, ladder.reinstatement_premium_full)}`
                    : `${ladder.reinstated_pct != null ? `${pct(ladder.reinstated_pct)} of layer reinstated · ` : ''}${ladder.reinstatement_basis}`}
              </span>
            </span>
            <span className="rpa-ladder-v rpa-ladder-rip num">
              {!ladder ? '—' : ladder.reinstatement_waived ? 'waived' : bracket(ccy, ladder.reinstatement_premium)}
            </span>
          </div>
          {ladderInput('cash_funded', 'Less cash call already funded')}
          <div className="rpa-ladder-net">
            <span>
              <span className="rpa-ladder-net-k">Net amount due from reinsurers</span>
              <span className="rpa-ladder-net-note">Gross plus expenses, less salvage, reinstatement premium and cash already funded</span>
            </span>
            <span className="rpa-ladder-net-v num">{money(ccy, ladder?.net_due)}</span>
          </div>
          {busy === 'calc' && <div className="muted small">Recalculating…</div>}
          {!ladder && !busy && (
            <div className="rpa-notice">
              <span>Not run against the layers yet — every figure above waits on the calculation.</span>
              {canAct && <button type="button" className="btn btn-secondary btn-sm" onClick={() => recalc(null)}>Calculate</button>}
            </div>
          )}
          <ErrorBanner error={error} />
        </section>

        <div className="rpa-cl-side">
          <section className="blueprint rpa-cl-card">
            <div className="rpa-cl-sechead">
              <h3 className="rpa-cl-h3">Preliminary loss advice</h3>
              <Pill tone={pla ? 'green' : 'gold'}>{pla ? `PLA sent to ${plural(pla.delivered, 'reinsurer')}` : 'PLA not yet sent'}</Pill>
            </div>
            <p className="rpa-cl-para">
              {pla
                ? `Preliminary loss advice issued to the full signed panel — reserve only, no payment requested. Sent ${fmtStamp(pla.sent_at)}${pla.sent_by_name ? ` by ${pla.sent_by_name}` : ''}.`
                : 'The preliminary loss advice goes to every reinsurer on the signed panel, regardless of which layer the loss reaches.'}
            </p>
            <button type="button" className="btn btn-secondary" disabled={!canAct || Boolean(busy) || !panel.length} onClick={sendPla}>
              {busy === 'pla' ? 'Sending…' : pla ? 'Re-send PLA' : `Send PLA to ${plural(panel.length, 'panel reinsurer')}`}
            </button>
          </section>

          <section className="blueprint rpa-cl-card">
            <h3 className="rpa-cl-h3">Claim advice</h3>
            <div className="rpa-cl-para">
              {claimAdvice
                ? `Advices sent with individual share schedules · ${fmtStamp(claimAdvice.sent_at)} · ${claimAdvice.delivered} of ${claimAdvice.recipients.length} reached`
                : 'One template, each reinsurer\'s share merged from their signed line'}
            </div>
            <div className="rpa-mail-row">
              <label className="rpa-mail-k" htmlFor="rpa-claim-subject">Subject</label>
              <input id="rpa-claim-subject" className="rpa-mail-subject" value={subject} onChange={(ev2) => { setSubject(ev2.target.value); setDirty(true); }} />
            </div>
            <textarea
              className="input rpa-mail-body rpa-advice-body"
              aria-label="Claim advice body"
              value={body}
              onChange={(ev2) => { setBody(ev2.target.value); setDirty(true); }}
            />
            <p className="muted small rpa-merge-note">
              <code>{'{{schedule}}'}</code> becomes each reinsurer's own share; <code>{'{{market_name}}'}</code> and <code>{'{{contact_name}}'}</code> theirs.
              {dirty && draft.data ? (
                <> <button type="button" className="rpa-linkbtn" onClick={() => { setDirty(false); setSubject(draft.data.subject); setBody(draft.data.body); }}>Restore the template</button></>
              ) : null}
            </p>
            <button type="button" className="btn btn-primary rpa-mail-send" disabled={!canAct || Boolean(busy) || !markets.length || !ladder} onClick={sendAdvice}>
              {busy === 'advice' ? 'Sending…' : claimAdvice ? 'Re-send claim advices' : `Send claim advice to ${plural(markets.length, 'reinsurer')}`}
            </button>
          </section>
        </div>
      </div>

      {markets.length ? (
        <section className="blueprint rpa-cl-section">
          <h3 className="rpa-cl-h3 rpa-cl-h3--table">Reinsurer breakdown — apportioned on signed lines</h3>
          <div className="table-wrap rpa-cl-tablewrap">
            <table className="table rpa-cl-table rpa-breakdown">
              <thead>
                <tr>
                  <th>Reinsurer / underwriter</th><th className="r">Signed line</th><th className="r">Share of gross</th>
                  <th className="r">Expenses net of salvage</th><th className="r">Reinstatement premium</th>
                  <th className="r">Cash already funded</th><th className="r">Net due</th><th>Advice</th>
                </tr>
              </thead>
              <tbody>
                {markets.map((m) => {
                  const who = whoIs.get(m.market_id);
                  const st = adviceStatus.get(m.market_id);
                  return (
                    <tr key={m.market_id}>
                      <td>
                        <div className="rpa-resp-name">{m.market_name}</div>
                        <div className="rpa-book-sub">{who?.contact_name || 'No underwriter on file'}{who?.email ? ` · ${who.email}` : ''}</div>
                      </td>
                      <td className="r num">{pct(m.signed_pct, 2)}</td>
                      <td className="r num">{money(ccy, m.gross)}</td>
                      <td className="r num">{money(ccy, m.expenses_net)}</td>
                      <td className="r num rpa-cl-rip">{ladder.reinstatement_waived ? 'waived' : bracket(ccy, m.reinstatement_premium)}</td>
                      <td className="r num">{bracket(ccy, m.cash_funded)}</td>
                      <td className="r num rpa-cl-net">{money(ccy, m.net_due)}</td>
                      <td>
                        {st === 'sent' ? <Pill tone="green">Advice sent</Pill>
                          : st === 'failed' ? <Pill tone="red">Not reached</Pill>
                            : <Pill tone="neutral">Advice pending</Pill>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="rpa-breakdown-total">
                  <td>100% of layer</td>
                  <td />
                  <td className="r num">{money(ccy, ladder.gross_to_layer)}</td>
                  <td className="r num">{money(ccy, ladder.lae - ladder.salvage)}</td>
                  <td className="r num rpa-cl-rip">{ladder.reinstatement_waived ? 'waived' : bracket(ccy, ladder.reinstatement_premium)}</td>
                  <td className="r num">{bracket(ccy, ladder.cash_funded)}</td>
                  <td className="r num rpa-cl-net">{money(ccy, ladder.net_due)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      ) : (
        <div className="blueprint rpa-cl-empty">
          <div className="rpa-cl-empty-title">Panel not loaded for this claim</div>
          <div className="rpa-cl-empty-note">
            {!ladder ? 'Run the calculation to apportion the loss on the signed lines.'
              : ladder.layers_reached === 0 ? 'The loss does not reach any layer at the figure advised, so there is nothing to apportion.'
                : 'No market has a signed line on the layer this loss reaches.'}
          </div>
        </div>
      )}
    </>
  );
}

// ── Proportional ────────────────────────────────────────────────────────

function Proportional({ c }) {
  if (!c.p) return <BasisEmpty title="No proportional section on this contract" c={c} basis="proportional" />;
  const ccy = c.contract.currency;
  const p = c.p;
  return (
    <>
      <section className="blueprint rpa-cl-section">
        <div className="rpa-cl-sechead">
          <h3 className="rpa-cl-h2">Bordereaux — quota share &amp; surplus</h3>
          <span className="kicker accent">Quarterly accounts</span>
        </div>
        <div className="table-wrap rpa-cl-tablewrap">
          <table className="table rpa-cl-table">
            <thead>
              <tr>
                <th>Treaty / section</th><th>Period</th><th className="r">Premium ceded</th><th className="r">Claims paid</th>
                <th className="r">OS reserves</th><th className="r">Loss ratio</th><th className="r">Commission</th><th>Bordereau</th>
              </tr>
            </thead>
            <tbody>
              {p.bordereaux.length === 0 && (
                <tr>
                  <td colSpan="8" className="muted">
                    No bordereau has been ingested for this contract yet. They come in through the{' '}
                    <Link to={`/placements/${c.contract.id}/claims`}>claims &amp; premiums screen</Link>.
                  </td>
                </tr>
              )}
              {p.bordereaux.map((b) => (
                <tr key={b.id}>
                  <td><div className="rpa-resp-name">{b.section}</div><div className="rpa-book-sub">{plural(b.rows || 0, 'row')}</div></td>
                  <td className="rpa-cl-dol">{b.period}</td>
                  <td className="r num">{money(ccy, b.premium_ceded)}</td>
                  <td className="r num">{money(ccy, b.claims_paid)}</td>
                  <td className="r num">{money(ccy, b.outstanding)}</td>
                  <td className="r num rpa-cl-lr">{b.loss_ratio_pct != null ? pct(b.loss_ratio_pct) : '—'}</td>
                  <td className="r num">{b.commission_pct != null ? pct(b.commission_pct) : '—'}</td>
                  <td><Pill tone={BDX_TONE[b.status] || 'neutral'}>{b.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="blueprint rpa-cl-section">
        <h3 className="rpa-cl-h2 rpa-cl-h3--table">Large loss listing — over {money(ccy, p.large_loss_threshold)}</h3>
        <div className="table-wrap rpa-cl-tablewrap">
          <table className="table rpa-cl-table">
            <thead>
              <tr>
                <th>Reference</th><th>Insured / cause</th><th>DOL</th><th>Treaty</th>
                <th className="r">Gross</th><th className="r">Ceded share</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {p.large_losses.length === 0 && (
                <tr>
                  <td colSpan="7" className="muted">
                    {p.has_listing ? 'No loss over the threshold on the listing.' : 'No large loss listing has been ingested for this contract.'}
                  </td>
                </tr>
              )}
              {p.large_losses.map((l, i) => (
                <tr key={`${l.reference || l.insured}-${i}`}>
                  <td className="rpa-cl-ref">{l.reference || '—'}</td>
                  <td><div>{l.insured}</div><div className="rpa-book-sub">{l.cause || '—'}</div></td>
                  <td className="rpa-cl-dol">{fmtDate(l.loss_date)}</td>
                  <td className="rpa-cl-dol">{l.section}</td>
                  <td className="r num">{money(ccy, l.gross)}</td>
                  <td className="r num">{money(ccy, l.ceded)}</td>
                  <td>{l.status ? <Pill tone="neutral">{l.status}</Pill> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
