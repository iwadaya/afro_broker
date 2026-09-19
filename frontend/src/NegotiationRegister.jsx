import React from 'react';
import { StructCard } from './StructureSections.jsx';
import { KindPill } from './NegotiationReplies.jsx';
import { SubmissionPill } from './NegotiationSubmission.jsx';

/*
 * Sent to reinsurers.
 *
 * The register of every reinsurer the pack has gone to: which underwriters
 * at each were emailed, when and at which version, whether the email got
 * through, what has come back from each, and where the market stands on the
 * board. A market put on the board without a covering email (the bare send)
 * is here too, with nobody named. Every one of them was approached for a
 * lead quote, so there is no role to show or to set.
 */

const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const day = (d) => (d ? String(d).slice(0, 10) : '—');

/** Where a market's reply stands, across its underwriters. */
function ReplyStanding({ underwriters }) {
  if (!underwriters.length) return <span className="muted">—</span>;
  return (
    <div className="neg-reg-stack">
      {underwriters.map((u) => (
        <div key={u.recipient_id} className="small">
          {u.reply_status === 'replied'
            ? <><KindPill kind={u.last_kind || 'other'} /> <span className="muted">{u.reply_count}× · {when(u.replied_at)}</span></>
            : u.delivery === 'sent'
              ? <span className="neg-standing neg-standing--sent">awaiting reply</span>
              : <span className="muted">not delivered</span>}
        </div>
      ))}
    </div>
  );
}

export default function NegotiationRegister({
  data, submissions, canEdit, busy, onWithdraw, onSend, onOpenSubmission,
}) {
  const markets = data.markets;
  const underwriters = markets.reduce((n, m) => n + (m.underwriters || []).length, 0);
  // Covering emails still on their way: drafted, or waiting on the second pair of eyes.
  const pending = (submissions || []).filter((s) => ['draft', 'pending_approval'].includes(s.status));

  return (
    <StructCard
      title="Sent to reinsurers"
      hint="Every reinsurer the pack has gone to for quotation — the underwriters it was emailed to, when, whether it got through, and what has come back."
      actions={(
        <div className="toolbar">
          <span className="np-layer-count">Reinsurers<b>{markets.length || '—'}</b></span>
          <span className="np-layer-count">Underwriters<b>{underwriters || '—'}</b></span>
          {canEdit && (
            <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy || !data.pack.approved}
              title={data.pack.approved ? 'Draft a covering email to more reinsurers' : 'An approved pack goes to market'}
              onClick={onSend}>
              ＋ Send to more reinsurers
            </button>
          )}
        </div>
      )}
      footnote="Standing is the market's on the board: SENT until it answers, QUOTED once it prices anything, DECLINED when it passes on everything it was given. Withdrawing a market takes its quotes with it."
    >
      {pending.length > 0 && (
        <div className="np-struct-notice neg-reg-pending">
          {pending.map((s) => (
            <div key={s.id} className="neg-reg-pending-row">
              <SubmissionPill status={s.status} />
              <span>
                Covering email to {s.recipients} underwriter{s.recipients === 1 ? '' : 's'} on pack v{s.pack_version ?? '—'}
                {s.status === 'pending_approval' ? ' is waiting on a second pair of eyes' : ' is still a draft'} — those reinsurers are not on the register until it is released.
              </span>
              <button type="button" className="np-struct-btn" onClick={() => onOpenSubmission(s.id)}>Open</button>
            </div>
          ))}
        </div>
      )}

      {markets.length === 0 ? (
        <div className="muted" data-testid="neg-register-empty">
          The pack has not gone to any reinsurer yet. Send it from the Email tab: pick the reinsurers to approach for quotation and the underwriters at each.
        </div>
      ) : (
        <div className="np-table-wrap">
          <table className="np-struct-table neg-register" data-testid="neg-register">
            <thead>
              <tr>
                <th className="np-table-sticky">Reinsurer</th>
                <th>Pack</th>
                <th>Underwriters emailed</th>
                <th>Sent</th>
                <th>Reply</th>
                <th>Standing</th>
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const uws = m.underwriters || [];
                const sentAt = uws.find((u) => u.sent_at)?.sent_at || m.sent_at;
                return (
                  <tr key={m.id}>
                    <th className="np-table-sticky neg-sub-market">
                      {m.market_name}
                      {m.rating && <span className="neg-sub-contact">rated {m.rating}</span>}
                    </th>
                    <td>v{m.pack_version ?? '—'}</td>
                    <td className="neg-reg-underwriters">
                      {uws.length === 0
                        ? <span className="muted small">no covering email — put on the board directly</span>
                        : (
                          <div className="neg-reg-stack">
                            {uws.map((u) => (
                              <div key={u.recipient_id} className="small">
                                <b>{u.name || u.email}</b>
                                <span className="neg-sub-contact">
                                  {u.email} · {u.delivery === 'sent' ? 'delivered' : u.delivery}{u.error ? ` — ${u.error}` : ''}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                    </td>
                    <td className="small">{uws.length ? when(sentAt) : day(m.sent_at)}</td>
                    <td><ReplyStanding underwriters={uws} /></td>
                    <td><span className={`neg-standing neg-standing--${m.status.toLowerCase()}`}>{m.status}</span></td>
                    {canEdit && (
                      <td>
                        <button type="button" className="renew-x" aria-label={`Withdraw ${m.market_name}`}
                          disabled={busy} onClick={() => onWithdraw(m)}>✕</button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </StructCard>
  );
}
