import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { StructCard } from './StructureSections.jsx';
import NegotiationSheet from './NegotiationSheet.jsx';
import SubmissionComposer, { SubmissionsCard } from './NegotiationSubmission.jsx';
import RepliesCard from './NegotiationReplies.jsx';
import NegotiationPack from './NegotiationPack.jsx';
import NegotiationRegister from './NegotiationRegister.jsx';
import NegotiationQuotes from './NegotiationQuotes.jsx';
import QuotingByUnderwriter from './QuotingByUnderwriter.jsx';
import RolComparison from './RolComparison.jsx';
import { Board, QuoteEditor } from './NegotiationBoard.jsx';

/*
 * The Quoting Stage.
 *
 * The approved renewal pack goes out to market — its Excel and its PDF, as
 * stored when the version was approved, with every email — and the quotes
 * come back against the structures that were quoted. Six tabs, in the order
 * the stage runs:
 *
 *   1 · Renewal Pack        the approved pack the markets are quoting on
 *   2 · Emails              the covering emails to be sent out — drafted by
 *                           AI for the chosen underwriters, read by the
 *                           broker, released under four eyes — and the
 *                           replies that came back
 *   3 · Sent to reinsurers  the register of every reinsurer approached for
 *                           quotation, and where each stands
 *   4 · Responses & Quotes  every reinsurer with the structures it quoted,
 *                           the sheet that captures them, and the board
 *   5 · By Underwriter      each reinsurer's quotes by structure — a
 *                           proportional structure as sent or a different
 *                           one of its own, a non-proportional one layer by
 *                           layer — and the combined programme quote
 *   6 · Rate on Line        each layer's rate on line across the reinsurers
 *                           that quoted, beside the layer as sent and the
 *                           expiring layer
 *
 * Every reinsurer approached here is approached for a lead quote, so a market
 * on the board carries no lead / follow role and none is shown. What differs
 * is what a reinsurer gives back on a structure — a lead quote or an
 * indication — toggled per structure on its card, and marked wherever the
 * quote is read.
 */

const TABS = [
  { key: 'pack', label: '1 · Renewal Pack', hint: 'The approved pack the markets are quoting on, as the Excel workbook it went to them as; its Excel and PDF go with every email. A version is immutable, so everyone holding it sees the same figures.' },
  { key: 'email', label: '2 · Emails', hint: 'The covering emails to be sent out — drafted by AI for the chosen underwriters with the approved pack attached as Excel and PDF, read by the broker, released by a second pair of eyes — and the replies that came back.' },
  { key: 'sent', label: '3 · Sent to reinsurers', hint: 'Every reinsurer the pack has gone to for quotation: who at each got it, when, and what has come back.' },
  { key: 'quotes', label: '4 · Responses & Quotes', hint: 'Every reinsurer with the structures it quoted — the ones it was sent and any of its own, each a lead quote or an indication — then the sheet that captures a quote, and the board by structure.' },
  { key: 'underwriters', label: '5 · By Underwriter', hint: 'Each reinsurer\'s quotes by structure: a proportional structure taken as sent or a different one of its own; a non-proportional one layer by layer, with the programme its layers add up to — each marked a lead quote or an indication — and, underneath, the combined quote across the market.' },
  { key: 'rol', label: '6 · Rate on Line', hint: 'Each layer\'s rate on line across the reinsurers that quoted, beside the layer as it went out and the expiring layer; the keenest on each layer is marked.' },
];

export default function Negotiation({ placementId, canEdit, canRelease, user }) {
  const [data, setData] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('pack');
  // The send: `true` starts a new one, an id reopens an existing submission.
  const [sending, setSending] = useState(null);
  const [editing, setEditing] = useState(null);
  const [contacts, setContacts] = useState([]);
  // What the sheet was opened on, so a market's own structure lands on it.
  const [focusStructure, setFocusStructure] = useState(null);

  // Both in one pass, so the board and its submissions land in a single render.
  const load = useCallback(() => {
    Promise.all([
      api('GET', `/placements/${placementId}/negotiation`),
      api('GET', `/placements/${placementId}/negotiation/submissions`).catch(() => []),
    ]).then(([board, sent]) => { setData(board); setSubmissions(sent); }).catch(setError);
  }, [placementId]);

  useEffect(() => load(), [load]);

  // Who at the reinsurer can have given the terms being captured.
  const editingMarketId = editing?.market?.market_id;
  useEffect(() => {
    if (!editingMarketId) { setContacts([]); return; }
    api('GET', `/markets/${editingMarketId}/contacts`)
      .then((rows) => setContacts(rows.filter((c) => c.active)))
      .catch(() => setContacts([]));
  }, [editingMarketId]);

  async function act(fn) {
    setBusy(true);
    setError(null);
    try { await fn(); load(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  if (!data) return <div className="muted" style={{ padding: 12 }}>{error ? error.message : 'Loading…'}</div>;

  const currency = data.placement.currency;
  const packReady = !!data.pack.approved;
  const current = TABS.find((t) => t.key === tab) || TABS[0];
  const underwriters = data.markets.reduce((n, m) => n + (m.underwriters || []).length, 0);
  const quoted = data.markets.filter((m) => m.status === 'QUOTED').length;
  const packLabel = data.pack.approved
    ? `v${data.pack.approved.version} (approved)`
    : data.pack.latest ? `v${data.pack.latest.version} (${data.pack.latest.status}, not approved)` : '—';

  /** Land on the sheet for a market: to enter its own structure, or just to price. */
  const openSheet = (negotiationId, structureIndex, mode) => {
    setTab('quotes');
    // A fresh object each time, so reopening re-fires the jump.
    setFocusStructure({ negotiationId, structureIndex: structureIndex ?? null, mode, at: Date.now() });
  };
  const openEditor = (line, market, quote) => setEditing({ line, market, quote });
  /** Lead quote or indication: what a market gave on one structure, as a whole. */
  const setKind = (market, structure, kind) => act(() => api('PUT', `/negotiations/${market.id}/quote-kind`, {
    ...(structure.source === 'market' ? { market_structure_id: structure.id } : { structure_index: structure.index }),
    kind,
  }));

  return (
    <>
      {/* The six tabs sit on top of the stage in one line — a strip of their
          own, not squeezed into the header card's actions where they would
          wrap. */}
      <nav className="neg-stage-tabs" aria-label="Quoting stage">
        <span className="rp-viewswitch neg-tabs" role="tablist" data-testid="neg-tabs">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={t.key === tab}
              className={t.key === tab ? 'on' : ''} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </span>
      </nav>
      <StructCard
        title="Quoting Stage"
        hint={current.hint}
      >
        <div className="toolbar neg-summary">
          <span className="np-layer-count">Pack<b>{packLabel}</b></span>
          <span className="np-layer-count">Reinsurers holding it<b>{data.markets.length || '—'}</b></span>
          <span className="np-layer-count">Underwriters emailed<b>{underwriters || '—'}</b></span>
          <span className="np-layer-count">Quoted<b>{quoted || '—'}</b></span>
        </div>
        {error && <div className="err banner">{error.message}</div>}
      </StructCard>

      {tab === 'pack' && (
        <NegotiationPack placementId={placementId} data={data} canEdit={canEdit} busy={busy}
          onSend={() => setSending(true)} />
      )}

      {tab === 'email' && (
        <>
          <StructCard
            title="Covering emails"
            hint="Send pack to market picks the reinsurers to approach for quotation and the underwriters at each, then drafts the covering email with AI market commentary and attaches the approved pack as Excel and PDF. The broker reads and edits it; a second pair of eyes releases it, which emails the underwriters and puts their markets on the board."
            notice={!data.pack.latest
              ? 'No renewal pack has been created yet — create one on the Renewal Pack tab before going to market.'
              : !packReady
                ? `Renewal pack v${data.pack.latest.version} is awaiting a Senior Broker's approval — it goes to market once approved.`
                : undefined}
            actions={canEdit && (
              <button type="button" className="np-green-pill" disabled={!packReady || busy} data-testid="send-pack"
                onClick={() => setSending(true)}>Send pack to market</button>
            )}
          >
            <div className="toolbar">
              <span className="np-layer-count">Pack<b>{packLabel}</b></span>
              <span className="np-layer-count">Covering emails sent<b>{submissions.filter((s) => s.status === 'sent').length || '—'}</b></span>
              <span className="np-layer-count">Awaiting release<b>{submissions.filter((s) => s.status === 'pending_approval').length || '—'}</b></span>
            </div>
          </StructCard>

          <SubmissionsCard submissions={submissions} canRelease={canRelease} onOpen={(id) => setSending(id)} />

          <RepliesCard placementId={placementId} canEdit={canEdit} submissions={submissions} />
        </>
      )}

      {tab === 'sent' && (
        <NegotiationRegister
          data={data}
          submissions={submissions}
          canEdit={canEdit}
          busy={busy}
          onWithdraw={(m) => act(() => api('DELETE', `/negotiations/${m.id}`))}
          onSend={() => setSending(true)}
          onOpenSubmission={(id) => setSending(id)}
        />
      )}

      {tab === 'quotes' && (
        <>
          <NegotiationQuotes
            data={data}
            currency={currency}
            canEdit={canEdit}
            onEdit={openEditor}
            onKind={setKind}
            onDifferent={(marketId, structureIndex) => openSheet(marketId, structureIndex, 'alt')}
            onOpenSheet={(marketId) => openSheet(marketId, null, 'open')}
          />

          {canEdit && data.markets.length > 0 && (
            <NegotiationSheet markets={data.markets} currency={currency} onSaved={load}
              focusStructure={focusStructure} onFocused={() => setFocusStructure(null)} />
          )}

          <Board
            data={data}
            currency={currency}
            canEdit={canEdit}
            onEdit={openEditor}
            onAlternative={(marketId, structureIndex) => openSheet(marketId, structureIndex, 'alt')}
          />
        </>
      )}

      {tab === 'underwriters' && (
        <QuotingByUnderwriter
          data={data}
          currency={currency}
          canEdit={canEdit}
          onEdit={openEditor}
          onKind={setKind}
          onDifferent={(negotiationId, structureIndex) => openSheet(negotiationId, structureIndex, 'alt')}
          onOpenSheet={(negotiationId) => openSheet(negotiationId, null, 'open')}
        />
      )}

      {tab === 'rol' && <RolComparison data={data} currency={currency} />}

      <SubmissionComposer
        open={Boolean(sending)}
        placementId={placementId}
        submissionId={typeof sending === 'string' ? sending : null}
        canEdit={canEdit}
        canRelease={canRelease}
        user={user}
        onClose={() => { setSending(null); load(); }}
        onChanged={load}
      />

      <QuoteEditor
        open={editing}
        line={editing?.line}
        market={editing?.market}
        currency={currency}
        contacts={contacts}
        busy={busy}
        onClose={() => setEditing(null)}
        onSave={(body) => act(async () => {
          await api('PUT', `/negotiations/${editing.market.id}/quotes`, body);
          setEditing(null);
        })}
        onClear={() => act(async () => {
          await api('DELETE', `/negotiations/${editing.market.id}/quotes/${editing.quote.id}`);
          setEditing(null);
        })}
      />
    </>
  );
}
