import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { StructCard } from './StructureSections.jsx';
import { providerLabel } from './components.jsx';

/*
 * Taking the pack to market.
 *
 * The broker picks the underwriters — named people with addresses, held on the
 * market register — and the covering email is drafted for them with AI market
 * commentary. Nothing goes anywhere until the broker confirms they have read
 * that draft, and then only when a *second* person releases it: the release is
 * what emails the underwriters and puts their markets on the board.
 */

const day = (d) => (d ? String(d).slice(0, 10) : '—');
const when = (d) => (d ? String(d).replace('T', ' ').slice(0, 16) : '—');

const STATUS_LABEL = {
  draft: 'draft',
  pending_approval: 'awaiting release',
  sent: 'sent',
  cancelled: 'withdrawn',
};

/** Where a submission stands, in the board's pill language. */
export function SubmissionPill({ status }) {
  const tone = { draft: 'sent', pending_approval: 'quoted', sent: 'quoted', cancelled: 'withdrawn' }[status] || 'sent';
  return <span className={`neg-standing neg-standing--${tone}`}>{STATUS_LABEL[status] || status}</span>;
}

/** Every submission on this placement, whatever became of it. */
export function SubmissionsCard({ submissions, onOpen, canRelease }) {
  if (!submissions?.length) return null;
  return (
    <StructCard
      title="Submissions"
      hint="Each covering email that has gone to market, or is waiting on a second pair of eyes."
      actions={<span className="np-layer-count">Sent<b>{submissions.filter((s) => s.status === 'sent').length || '—'}</b></span>}
    >
      <div className="np-table-wrap">
        <table className="np-struct-table">
          <thead>
            <tr>
              <th className="neg-sub-subject">Subject</th>
              <th>Pack</th><th>Wording</th><th>Drafted by</th>
              <th>Underwriters</th><th>Standing</th><th />
            </tr>
          </thead>
          <tbody>
            {submissions.map((s) => (
              <tr key={s.id}>
                <td className="neg-sub-subject" title={s.subject}>{s.subject}</td>
                <td>v{s.pack_version ?? '—'}</td>
                <td>{s.wording_title || '—'}</td>
                <td>{s.created_by_name}</td>
                <td>{s.status === 'sent' ? `${s.delivered}/${s.recipients} emailed` : s.recipients}</td>
                <td><SubmissionPill status={s.status} /></td>
                <td>
                  <button type="button" className="np-struct-btn" onClick={() => onOpen(s.id)}>
                    {s.status === 'pending_approval' && canRelease ? 'Review' : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </StructCard>
  );
}

/**
 * Step one: who the pack goes to — the reinsurers to approach for quotation
 * first, then, under each one chosen, which of its underwriters. Ticking a
 * reinsurer picks its primary underwriter; more can be added underneath.
 * Every one of them is approached for a lead quote, so none is singled out.
 */
export function Underwriters({ context, underwriters, selected, setSelected }) {
  const withEmail = underwriters.filter((m) => m.contacts.length);
  const withoutEmail = underwriters.filter((m) => !m.contacts.length);

  const chosenAt = (m) => m.contacts.filter((c) => selected[c.id]);
  const toggleMarket = (market) => setSelected((s) => {
    const next = { ...s };
    if (chosenAt(market).some((c) => next[c.id])) {
      for (const c of market.contacts) delete next[c.id];
    } else {
      const first = market.contacts.find((c) => c.is_primary) || market.contacts[0];
      next[first.id] = { market_id: market.market_id, contact_id: first.id };
    }
    return next;
  });
  const toggleContact = (market, contact) => setSelected((s) => {
    const next = { ...s };
    if (next[contact.id]) delete next[contact.id];
    else next[contact.id] = { market_id: market.market_id, contact_id: contact.id };
    return next;
  });

  return (
    <>
      {(context.blockers || []).map((b) => <div key={b} className="err banner">{b}</div>)}
      {(context.warnings || []).map((w) => <div key={w} className="np-struct-notice">{w}</div>)}

      <div className="neg-pick-steps">
        <span className="neg-pick-step"><b>1</b> Reinsurers to approach for quotation</span>
        <span className="neg-pick-step"><b>2</b> The underwriter(s) at each</span>
        {context.mail_from && <span className="muted small">Sent from {context.mail_from}{context.mail_transport === 'stub' ? ' (recorded only — no mailbox connected)' : ''}</span>}
      </div>

      <div className="neg-market-list" data-testid="reinsurer-picker">
        {withEmail.map((m) => {
          const blocked = m.security_status === 'declined';
          const chosen = chosenAt(m);
          const on = chosen.length > 0;
          return (
            <div key={m.market_id} className={`neg-reinsurer${on ? ' is-on' : ''}`}>
              <label className={`neg-market${on ? ' is-on' : ''}${blocked ? ' is-off' : ''}`}>
                <input type="checkbox" disabled={blocked} checked={on} onChange={() => toggleMarket(m)} />
                <span>
                  {m.market_name}
                  <span className="neg-sub-contact">
                    {m.contacts.length} underwriter{m.contacts.length === 1 ? '' : 's'} on file
                    {on ? ` · sending to ${chosen.map((c) => c.name).join(', ')}` : ''}
                  </span>
                </span>
                {m.rating && <span className="np-layer-count">{m.rating}</span>}
                {m.security_status !== 'approved' && <span className="td-card-tag">{m.security_status}</span>}
              </label>
              {on && (
                <div className="neg-underwriters" data-testid="underwriter-picker">
                  {m.contacts.map((c) => (
                    <label key={c.id} className={`neg-underwriter${selected[c.id] ? ' is-on' : ''}`}>
                      <input type="checkbox" checked={!!selected[c.id]} onChange={() => toggleContact(m, c)} />
                      <span>
                        {c.name}{c.is_primary ? ' ★' : ''}{c.role ? ` · ${c.role}` : ''}
                        <span className="neg-sub-contact">{c.email}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!withEmail.length && (
          <div className="muted">No underwriter addresses on file — add them on the Markets register.</div>
        )}
        {withoutEmail.length > 0 && (
          <div className="muted small">
            {withoutEmail.length} other market{withoutEmail.length > 1 ? 's have' : ' has'} no underwriter email
            {' '}({withoutEmail.slice(0, 3).map((m) => m.market_name).join(', ')}{withoutEmail.length > 3 ? ', …' : ''})
            {' '}— add one on the Markets register to approach them.
          </div>
        )}
      </div>
    </>
  );
}

/** Step two: the covering email itself, and what may be done to it. */
function CoveringEmail({ submission, draft, setDraft, canEdit, canRelease, user, busy, act, onClose, reload }) {
  const isDraft = submission.status === 'draft';
  const mine = submission.created_by === user?.id;
  const meta = submission.ai_meta || {};
  const editable = isDraft && canEdit;

  return (
    <>
      {submission.reject_reason && isDraft && (
        <div className="err banner">Sent back: {submission.reject_reason}</div>
      )}
      <div className="np-struct-card-hint">
        Commentary drafted by {meta.source === 'ai' ? `${providerLabel(meta.provider)} (${meta.model})`
          : meta.source === 'broker' ? 'the broker' : 'the offline drafter'}
        {meta.source === 'fallback' && meta.reason ? ` — ${meta.reason}` : ''}.
        {' '}Read it, correct anything it has wrong, and fill in the [bracketed] judgement calls.
        {' '}<code>{'{{contact_name}}'}</code> is replaced with each underwriter&rsquo;s name when it is sent.
      </div>

      {editable ? (
        <>
          <label className="fr">
            <div className="fr-label">Subject</div>
            <input className="fi" value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value, reviewed: false })} />
          </label>
          <label className="fr">
            <div className="fr-label">Covering email</div>
            <textarea className="fi neg-mail" value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value, reviewed: false })} />
          </label>
          <label className="neg-confirm">
            <input type="checkbox" checked={draft.reviewed}
              onChange={(e) => setDraft({ ...draft, reviewed: e.target.checked })} />
            <span>I have read this draft in full and edited it as required.</span>
          </label>
        </>
      ) : (
        <>
          <div className="fr"><div className="fr-label">Subject</div><div>{submission.subject}</div></div>
          <pre className="neg-mail-preview">{submission.preview || submission.body}</pre>
        </>
      )}

      <div className="np-table-wrap">
        <table className="np-struct-table">
          <thead>
            <tr><th>Market</th><th>Underwriter</th><th>Email</th><th>Delivery</th><th>Reply</th></tr>
          </thead>
          <tbody>
            {submission.recipients?.map((r) => (
              <tr key={r.id}>
                <td className="neg-sub-market">{r.market_name}</td>
                <td>{r.name || '—'}</td>
                <td className="neg-sub-contact">{r.email}</td>
                <td>
                  {r.status === 'sent' ? `sent ${when(r.sent_at)}` : r.status}
                  {r.error && <div className="fr-label--missing">{r.error}</div>}
                </td>
                <td className="small">
                  {r.reply_status === 'replied' ? `replied ${r.reply_count}× · ${when(r.replied_at)}` : r.status === 'sent' ? 'awaiting' : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {submission.status === 'sent' && (
        <div className="np-struct-notice">
          Released {when(submission.sent_at)} after four-eyes approval — the markets now hold pack v{submission.pack_version}.
        </div>
      )}
      {submission.status === 'pending_approval' && !(canRelease && !mine) && (
        <div className="np-struct-notice">
          {mine
            ? 'Four-eyes: you drafted this, so another underwriter or admin has to release it.'
            : 'Waiting on an underwriter or admin to release it.'}
        </div>
      )}

      <div className="neg-editor-actions neg-sub-actions">
        <button type="button" className="np-struct-btn" disabled={busy} onClick={onClose}>Close</button>
        <div className="toolbar">
          {editable && (
            <>
              <button type="button" className="np-struct-btn" disabled={busy}
                title="Draft the commentary again — this discards your edits"
                onClick={() => act(async () => { await api('POST', `/negotiation-submissions/${submission.id}/redraft`, {}); reload(); })}>
                Redraft commentary
              </button>
              <button type="button" className="np-struct-btn" disabled={busy}
                onClick={() => act(async () => {
                  await api('PATCH', `/negotiation-submissions/${submission.id}`, {
                    subject: draft.subject, body: draft.body, broker_reviewed: draft.reviewed,
                  });
                  reload();
                })}>
                Save draft
              </button>
              <button type="button" className="np-green-pill" disabled={busy || !draft.reviewed}
                title={draft.reviewed ? '' : 'Confirm you have read the draft first'}
                onClick={() => act(async () => {
                  await api('PATCH', `/negotiation-submissions/${submission.id}`, {
                    subject: draft.subject, body: draft.body, broker_reviewed: true,
                  });
                  await api('POST', `/negotiation-submissions/${submission.id}/request-approval`, {});
                  reload();
                })}>
                Send for approval (4-eyes)
              </button>
            </>
          )}
          {submission.status === 'pending_approval' && canRelease && !mine && (
            <>
              <button type="button" className="np-struct-btn" disabled={busy}
                onClick={() => act(async () => {
                  const reason = window.prompt('Send it back to the broker — why?');
                  if (reason === null) return;
                  await api('POST', `/negotiation-submissions/${submission.id}/reject`, { reason });
                  reload();
                })}>
                Send back
              </button>
              <button type="button" className="np-green-pill" disabled={busy}
                onClick={() => act(async () => {
                  await api('POST', `/negotiation-submissions/${submission.id}/approve`, {});
                  reload();
                })}>
                Approve &amp; send
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The whole send: pick underwriters, read the drafted email, ask for the
 * second pair of eyes — or, for that second person, release it.
 */
export default function SubmissionComposer({
  open, placementId, submissionId, canEdit, canRelease, user, onClose, onChanged,
}) {
  const [context, setContext] = useState(null);
  const [underwriters, setUnderwriters] = useState([]);
  const [submission, setSubmission] = useState(null);
  const [selected, setSelected] = useState({});
  const [draft, setDraft] = useState({ subject: '', body: '', reviewed: false });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const show = (s) => {
    setSubmission(s);
    setDraft({ subject: s.subject, body: s.body, reviewed: s.broker_reviewed });
  };

  const loadSubmission = useCallback(async (id) => {
    show(await api('GET', `/negotiation-submissions/${id}`));
  }, []);

  useEffect(() => {
    if (!open) { setSubmission(null); setSelected({}); setError(null); return; }
    if (submissionId) { loadSubmission(submissionId).catch(setError); return; }
    setSubmission(null);
    Promise.all([
      api('GET', `/placements/${placementId}/negotiation/submission-context`),
      api('GET', '/underwriters'),
    ]).then(([ctx, list]) => { setContext(ctx); setUnderwriters(list); }).catch(setError);
  }, [open, submissionId, placementId, loadSubmission]);

  if (!open) return null;

  async function act(fn) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const reload = async () => {
    if (submission) await loadSubmission(submission.id);
    onChanged?.();
  };

  const chosen = Object.values(selected);

  return (
    <div className="neg-editor-backdrop" role="dialog" aria-label="Send the pack to market">
      <div className="neg-editor neg-editor--wide">
        <div className="neg-editor-head">
          <div>
            <div className="np-struct-card-h2">
              {submission ? `Covering email — ${STATUS_LABEL[submission.status]}` : 'Send the pack to market'}
            </div>
            <div className="np-struct-card-hint">
              {submission
                ? `Renewal pack v${submission.pack_version} (Excel + PDF attached) · drafted ${day(submission.created_at)}`
                : 'Choose the underwriters, then read and edit the covering email before it goes for approval.'}
            </div>
          </div>
          <button type="button" className="renew-x" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <div className="neg-editor-body">
          {error && <div className="err banner">{error.message}</div>}

          {!submission && context && (
            <Underwriters
              context={context}
              underwriters={underwriters}
              selected={selected}
              setSelected={setSelected}
            />
          )}

          {submission && (
            <CoveringEmail
              submission={submission}
              draft={draft}
              setDraft={setDraft}
              canEdit={canEdit}
              canRelease={canRelease}
              user={user}
              busy={busy}
              act={act}
              onClose={onClose}
              reload={reload}
            />
          )}
        </div>

        {!submission && (
          <div className="neg-editor-actions">
            <span className="np-layer-count">Selected<b>{chosen.length || '—'}</b></span>
            <div className="toolbar">
              <button type="button" className="np-struct-btn" disabled={busy} onClick={onClose}>Cancel</button>
              <button type="button" className="np-green-pill"
                disabled={busy || !chosen.length || !context?.ready}
                title={context?.ready ? '' : (context?.blockers || []).join('; ')}
                onClick={() => act(async () => {
                  const created = await api('POST', `/placements/${placementId}/negotiation/submissions`, {
                    recipients: chosen,
                  });
                  show(created);
                  onChanged?.();
                })}>
                {busy ? 'Drafting…' : 'Draft covering email'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
