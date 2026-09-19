import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { StructCard } from './StructureSections.jsx';
import { providerLabel } from './components.jsx';

/*
 * The responses: what came back from the underwriters the pack went to.
 *
 * Replies are read from the connected Outlook inbox (or logged by hand when
 * one arrived some other way), tied to the underwriter they came from, and
 * read by the AI — what kind of answer it is, the terms it carries, the
 * questions it asks, what to do next. The board itself is the broker's to
 * move: a quote is captured on the sheet, a decline noted.
 */

const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const num = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 }));

const KIND_LABEL = { quote: 'quote', decline: 'declined', question: 'question', acknowledgement: 'acknowledged', other: 'other', unread: 'unread' };
const KIND_TONE = { quote: 'quoted', decline: 'declined', question: 'sent', acknowledgement: 'sent', other: 'sent', unread: 'sent' };

export function KindPill({ kind }) {
  return <span className={`neg-standing neg-standing--${KIND_TONE[kind] || 'sent'}`}>{KIND_LABEL[kind] || kind}</span>;
}

/** The AI's reading of one reply. */
function Reading({ read }) {
  if (!read || !read.summary) return null;
  return (
    <div className="neg-reading">
      <div className="neg-reading-summary">{read.summary}</div>
      {read.terms?.length > 0 && (
        <table className="np-struct-table neg-terms">
          <thead><tr><th>Structure</th><th>Layer</th><th>Premium</th><th>Rate %</th><th>Line %</th><th>Comm. %</th><th>Subjectivities</th></tr></thead>
          <tbody>
            {read.terms.map((t, i) => (
              <tr key={i}>
                <td>{t.structure || '—'}</td><td>{t.layer || '—'}</td>
                <td>{num(t.premium)}</td><td>{num(t.rate_pct)}</td><td>{num(t.line_pct)}</td><td>{num(t.commission_pct)}</td>
                <td>{(t.subjectivities || []).join('; ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {read.questions?.length > 0 && (
        <ul className="neg-reading-list">{read.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
      )}
      <div className="neg-reading-meta">
        {read.deadline && <span>Deadline: <b>{read.deadline}</b> · </span>}
        Next: <b>{read.next_action}</b>
        <span className="muted"> · read by {read.source === 'ai' ? `${providerLabel(read.provider)} (${read.model})` : 'the keyword reader (no AI key configured)'}</span>
      </div>
    </div>
  );
}

/** Paste in a reply that arrived outside the mailbox. */
function LogReply({ recipients, busy, onLog, onCancel }) {
  const [recipientId, setRecipientId] = useState(recipients[0]?.recipient_id || '');
  const [fromEmail, setFromEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const chosen = recipients.find((r) => r.recipient_id === recipientId);
  return (
    <div className="neg-log-reply" data-testid="log-reply">
      <div className="neg-editor-grid neg-log-grid">
        <label className="fr">
          <div className="fr-label">From</div>
          <select className="fi" value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
            {recipients.map((r) => (
              <option key={r.recipient_id} value={r.recipient_id}>{r.market_name} · {r.name || r.email} (pack v{r.pack_version})</option>
            ))}
            <option value="">Someone else…</option>
          </select>
        </label>
        {!recipientId && (
          <label className="fr">
            <div className="fr-label">Their email</div>
            <input className="fi" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="underwriter@reinsurer.com" />
          </label>
        )}
        <label className="fr">
          <div className="fr-label">Subject</div>
          <input className="fi" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="RE: …" />
        </label>
      </div>
      <label className="fr">
        <div className="fr-label">The reply</div>
        <textarea className="fi neg-mail" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Paste the underwriter's email here…" data-testid="log-reply-body" />
      </label>
      <div className="toolbar">
        <button type="button" className="np-struct-btn" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="np-green-pill" disabled={busy || !body.trim() || (!recipientId && !fromEmail)} data-testid="log-reply-submit"
          onClick={() => onLog({
            submissionId: chosen?.submission_id || recipients[0]?.submission_id,
            recipient_id: recipientId || undefined,
            from_email: recipientId ? undefined : fromEmail,
            subject: subject || undefined,
            body,
          })}>
          {busy ? 'Reading…' : 'Log reply'}
        </button>
      </div>
    </div>
  );
}

export default function RepliesCard({ placementId, canEdit, submissions }) {
  const [data, setData] = useState(null);
  const [mailbox, setMailbox] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [logging, setLogging] = useState(false);
  const [open, setOpen] = useState({});
  const [note, setNote] = useState(null);

  const load = useCallback(() => Promise.all([
    api('GET', `/placements/${placementId}/negotiation/replies`),
    api('GET', '/outlook/status').catch(() => null),
  ]).then(([r, m]) => { setData(r); setMailbox(m); }).catch(setError), [placementId]);
  useEffect(() => { load(); }, [load]);

  const anySent = (submissions || []).some((s) => s.status === 'sent');
  if (!anySent || !data) return null;

  async function act(fn) {
    setBusy(true); setError(null); setNote(null);
    try { await fn(); await load(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const checkInbox = () => act(async () => {
    const r = await api('POST', '/outlook/sync', {});
    setNote(r.skipped === 'no_mailbox'
      ? 'No Outlook mailbox is connected — connect one on the Admin page, or log a reply by hand.'
      : `Inbox read: ${r.checked} message${r.checked === 1 ? '' : 's'} checked, ${r.recorded} new repl${r.recorded === 1 ? 'y' : 'ies'} recorded.`);
  });
  const connect = () => act(async () => {
    const r = await api('POST', '/outlook/connect', {});
    window.location.href = r.url;
  });
  // Demo: the AI plays every underwriter still awaited and replies.
  const simulate = () => act(async () => {
    const r = await api('POST', `/placements/${placementId}/negotiation/replies/simulate`, {});
    setNote(r.replies.length
      ? `Demo: ${r.replies.length} underwriter${r.replies.length === 1 ? '' : 's'} replied — ${r.replies.map((x) => `${x.market_name || x.from_name || x.from_email}: ${x.scenario}`).join('; ')}${r.replies.some((x) => x.generated_by === 'ai') ? ' (written by the AI)' : ' (written from the template — no AI key configured)'}.`
      : 'Demo: nobody is awaiting a reply — send the pack to more underwriters first.');
  });
  const logReply = (input) => act(async () => {
    const { submissionId, ...body } = input;
    await api('POST', `/negotiation-submissions/${submissionId}/replies`, body);
    setLogging(false);
  });

  const { summary, recipients, replies } = data;
  const connected = !!mailbox?.connected;

  return (
    <StructCard
      title="Responses"
      hint={connected
        ? `Replies are read from ${mailbox.account.address}${mailbox.account.last_sync_at ? ` — inbox last read ${when(mailbox.account.last_sync_at)}` : ''}; the AI reads each one and says what it carries.`
        : 'No Outlook mailbox is connected yet — replies can be logged by hand, and read by the AI just the same.'}
      actions={(
        <span className="toolbar">
          <span className="np-layer-count">Replied<b>{summary.replied}/{summary.sent_to}</b></span>
          {summary.quotes > 0 && <span className="np-layer-count">Quotes<b>{summary.quotes}</b></span>}
          {summary.declines > 0 && <span className="np-layer-count">Declined<b>{summary.declines}</b></span>}
          {summary.questions > 0 && <span className="np-layer-count">Questions<b>{summary.questions}</b></span>}
        </span>
      )}
    >
      {error && <div className="err banner">{error.message}</div>}
      {note && <div className="np-struct-notice">{note}</div>}
      {mailbox?.account?.last_sync_error && <div className="err banner">Last inbox read failed: {mailbox.account.last_sync_error}</div>}

      {canEdit && (
        <div className="toolbar neg-replies-actions">
          {connected
            ? <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy} onClick={checkInbox} data-testid="check-inbox">↻ Check inbox now</button>
            : mailbox?.configured
              ? <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy} onClick={connect}>Connect Outlook</button>
              : <span className="muted small">Outlook is not configured on this server (MS_CLIENT_ID / MS_CLIENT_SECRET).</span>}
          <button type="button" className="np-struct-btn" disabled={busy} onClick={() => setLogging((l) => !l)} data-testid="log-reply-toggle">
            {logging ? 'Close' : '＋ Log a reply'}
          </button>
          {summary.awaiting > 0 && (
            <button type="button" className="np-struct-btn" disabled={busy} onClick={simulate} data-testid="simulate-replies"
              title="Demo: the AI plays each underwriter still awaited and writes their reply — a quote, a question, a decline, an acknowledgement — recorded and read like a real one.">
              ✦ Simulate replies (demo)
            </button>
          )}
        </div>
      )}
      {logging && <LogReply recipients={recipients} busy={busy} onLog={logReply} onCancel={() => setLogging(false)} />}

      <div className="np-table-wrap">
        <table className="np-struct-table neg-standings" data-testid="reply-standings">
          <thead><tr><th>Reinsurer</th><th>Underwriter</th><th>Sent</th><th>Standing</th><th>Last reply</th></tr></thead>
          <tbody>
            {recipients.map((r) => (
              <tr key={r.recipient_id}>
                <td className="neg-sub-market">{r.market_name}</td>
                <td>{r.name || '—'}<span className="neg-sub-contact">{r.email}</span></td>
                <td className="small">{r.delivery === 'sent' ? `${when(r.sent_at)} · pack v${r.pack_version}` : r.delivery}</td>
                <td>
                  {r.reply_status === 'replied'
                    ? <><KindPill kind={r.last_kind || 'other'} /> <span className="small muted">{r.reply_count}× · {when(r.replied_at)}</span></>
                    : <span className="neg-standing neg-standing--sent">awaiting reply</span>}
                </td>
                <td className="small">{r.last_summary || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {replies.length > 0 && (
        <div className="neg-replies" data-testid="replies">
          {replies.map((r) => (
            <div key={r.id} className={`neg-reply${r.handled ? ' is-handled' : ''}`} data-testid="reply">
              <div className="neg-reply-head">
                <div>
                  <b>{r.market_name || r.from_name || r.from_email}</b>
                  <span className="neg-sub-contact">{r.from_name ? `${r.from_name} · ` : ''}{r.from_email} · {when(r.received_at)} · {r.source === 'outlook' ? 'from the inbox' : r.source === 'demo' ? 'simulated for the demo' : 'logged by hand'}</span>
                </div>
                <span className="toolbar">
                  {r.source === 'demo' && <span className="td-card-tag">DEMO</span>}
                  <KindPill kind={r.kind} />
                  {r.handled && <span className="neg-standing neg-standing--sent" title={`by ${r.handled_by_name || ''}`}>handled</span>}
                </span>
              </div>
              <Reading read={r.ai_read} />
              <div className="toolbar neg-reply-actions">
                <button type="button" className="np-struct-btn" onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}>
                  {open[r.id] ? 'Hide email' : 'Show email'}
                </button>
                {canEdit && !r.handled && (
                  <button type="button" className="np-struct-btn" disabled={busy}
                    onClick={() => act(() => api('POST', `/negotiation-replies/${r.id}/handled`, {}))}>Mark handled</button>
                )}
                {canEdit && (
                  <button type="button" className="np-struct-btn" disabled={busy} title="Read it again with the AI"
                    onClick={() => act(() => api('POST', `/negotiation-replies/${r.id}/reread`, {}))}>↻ Re-read</button>
                )}
              </div>
              {open[r.id] && <pre className="neg-mail-preview">{r.subject ? `${r.subject}\n\n` : ''}{r.body}</pre>}
            </div>
          ))}
        </div>
      )}
    </StructCard>
  );
}
