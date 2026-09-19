import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useFetch, ErrorBanner, Pill, fmtStamp } from '../../components.jsx';
import { useAuth, useHasRole } from '../../auth.jsx';
import { StageEmpty, fmtSize } from './panels.jsx';
import { useToast } from '../../toast.jsx';
import { stageOf } from './stages.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'Friday 20 November 2026' — the deadline as the email names it (the server renders it the same way). */
function longDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

const pct = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}%`);

/** Where the submission stands, above the composer. */
function SubmissionState({ submission: s, user, canRelease, busy, onRelease, onSendBack, onWithdraw }) {
  if (!s) return null;
  const mine = user?.id === s.created_by;
  if (s.status === 'pending_approval') {
    return (
      <div className="rpa-mail-state is-pending">
        <Pill tone="gold">Awaiting release</Pill>
        <div className="rpa-mail-state-text">
          <div className="rpa-mail-state-title">Sent for release by a second pair of eyes</div>
          <div className="rpa-mail-state-sub">
            {s.created_by_name} sent it to {s.recipients.length} underwriter{s.recipients.length === 1 ? '' : 's'} {fmtStamp(s.created_at)}.
            {' '}An underwriter or admin who is not the drafter releases it; each underwriter is then emailed individually.
          </div>
        </div>
        <div className="rpa-mail-state-actions">
          {canRelease && !mine && (
            <>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={onRelease}>Release to market</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={onSendBack}>Send back</button>
            </>
          )}
          {(mine || user?.role === 'admin') && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onWithdraw}>Withdraw</button>
          )}
        </div>
      </div>
    );
  }
  if (s.status === 'sent') {
    return (
      <div className="rpa-mail-state is-sent">
        <Pill tone="green">Sent</Pill>
        <div className="rpa-mail-state-text">
          <div className="rpa-mail-state-title">
            Sent to {s.delivered} of {s.recipients.length} underwriter{s.recipients.length === 1 ? '' : 's'} · {fmtStamp(s.sent_at)}
          </div>
          <div className="rpa-mail-state-sub">
            Released by {s.approved_by_name || 'a second pair of eyes'}.
            {s.response_deadline && ` Terms requested by ${longDate(String(s.response_deadline).slice(0, 10))}; reminders go out three days before.`}
            {' '}Responses land on the next tab. Send again below only to widen the panel.
          </div>
        </div>
      </div>
    );
  }
  if (s.status === 'draft') {
    return (
      <div className="rpa-mail-state is-back">
        <Pill tone="red">Sent back</Pill>
        <div className="rpa-mail-state-text">
          <div className="rpa-mail-state-title">The second pair of eyes sent it back</div>
          <div className="rpa-mail-state-sub">{s.reject_reason || 'No reason was given.'} Edit the email and send it again.</div>
        </div>
        {(mine || user?.role === 'admin') && (
          <div className="rpa-mail-state-actions">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onWithdraw}>Withdraw</button>
          </div>
        )}
      </div>
    );
  }
  return null;
}

/**
 * The composer: the standard email seeded from the verified summary, the
 * attachments the send carries, and the panel by reinsurer — pre-populated
 * from last year's signed lines — every one sent individually.
 */
function Composer({ shared }) {
  const { analysis: a, setTab, reload } = shared;
  const { user } = useAuth();
  const canSend = useHasRole('broker', 'admin');
  const canRelease = useHasRole('underwriter', 'admin');
  const toast = useToast();
  const ctx = useFetch('GET', `/renewal-analyses/${a.id}/submission`, [a.id, a.verified_at, a.placement_id]);
  const c = ctx.data;

  const [seededFor, setSeededFor] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [deadline, setDeadline] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Seed the draft once the context lands: the template, or the submission
  // sent back for another go — and the default panel, every market that
  // wrote last year and is not withdrawn.
  useEffect(() => {
    if (!c?.template || seededFor === a.id) return;
    const back = c.submission?.status === 'draft' ? c.submission : null;
    setSubject(back ? back.subject.replace(/\s*\[BIQ-[0-9A-F]+\]$/, '') : c.template.subject);
    setBody(back ? back.body : c.template.body);
    setDeadline(back?.response_deadline ? String(back.response_deadline).slice(0, 10) : c.template.response_deadline);
    setSelected(new Set(back
      ? back.recipients.map((r) => r.market_id)
      : c.panel.filter((m) => m.default_selected).map((m) => m.market_id)));
    setSeededFor(a.id);
  }, [c, a.id, seededFor]);

  if (ctx.error) return <ErrorBanner error={ctx.error} />;
  if (!c) return <p className="muted">Drafting the market email…</p>;

  const s = c.submission;
  const frozen = s?.status === 'pending_approval';
  const selectable = c.panel.filter((m) => m.selectable);
  const chosen = selectable.filter((m) => selected.has(m.market_id));
  const allOn = selectable.length > 0 && chosen.length === selectable.length;

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allOn ? new Set() : new Set(selectable.map((m) => m.market_id)));
  }
  // The deadline sentence in the body follows the date control while the
  // broker has not rewritten it.
  function changeDeadline(next) {
    setBody((b) => (deadline && next ? b.replace(longDate(deadline), longDate(next)) : b));
    setDeadline(next);
  }

  async function act(fn, { then, done } = {}) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      ctx.reload();
      reload();
      if (then) then();
      if (done) toast(done);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const recipients = () => chosen.map((m) => ({ market_id: m.market_id, contact_id: m.contact.id }));

  function send() {
    const payload = { subject, body, recipients: recipients(), ...(deadline ? { response_deadline: deadline } : {}) };
    if (s?.status === 'draft') {
      // The one sent back: edit it and ask again, through the submission's own routes.
      return act(async () => {
        await api('PATCH', `/negotiation-submissions/${s.id}`, {
          subject: `${subject} [${/\[(BIQ-[0-9A-F]+)\]$/.exec(s.subject)?.[1] || 'BIQ'}]`,
          body, recipients: recipients(), broker_reviewed: true,
        });
        await api('POST', `/negotiation-submissions/${s.id}/request-approval`, {});
      }, { then: () => setTab('responses'), done: `Sent again for release to ${chosen.length} underwriter${chosen.length === 1 ? '' : 's'} — held until an underwriter releases it.` });
    }
    return act(() => api('POST', `/renewal-analyses/${a.id}/submission`, payload), {
      then: () => setTab('responses'),
      done: `Submitted to ${chosen.length} underwriter${chosen.length === 1 ? '' : 's'} — held for an underwriter's release under four-eyes.`,
    });
  }

  const sendLabel = s?.status === 'sent'
    ? `Re-send to ${chosen.length} underwriter${chosen.length === 1 ? '' : 's'}`
    : `Send to ${chosen.length} underwriter${chosen.length === 1 ? '' : 's'}`;

  return (
    <div className="rpa-mail-grid">
      <section className="blueprint rpa-mail">
        <div className="sechead">
          <h3 className="seclabel">Market submission</h3>
          <span className="kicker accent spacer">Standard template · editable</span>
        </div>

        <SubmissionState
          submission={s}
          user={user}
          canRelease={canRelease}
          busy={busy}
          onRelease={() => act(() => api('POST', `/negotiation-submissions/${s.id}/approve`, {}), { then: () => setTab('responses'), done: 'Released to the market — the responses stage is open.' })}
          onSendBack={() => {
            const reason = window.prompt('Why is it going back to the broker?') ?? null;
            if (reason === null) return;
            act(() => api('POST', `/negotiation-submissions/${s.id}/reject`, { reason }), { done: 'Sent back to the broker with your reason.' });
          }}
          onWithdraw={() => {
            if (!window.confirm('Withdraw this submission? Nothing will be sent.')) return;
            act(() => api('POST', `/negotiation-submissions/${s.id}/cancel`, {}), { done: 'Submission withdrawn — nothing was sent.' });
          }}
        />
        {c.blockers.map((b) => <div key={b} className="err banner">{b}</div>)}
        {c.warnings.map((w) => <div key={w} className="warn banner">{w}</div>)}

        <div className="rpa-mail-row">
          <span className="rpa-mail-k">To</span>
          <Pill tone="accent">{chosen.length} underwriter{chosen.length === 1 ? '' : 's'} selected</Pill>
          <span className="muted small">Sent individually — no reinsurer sees the panel</span>
          {c.mail_from && (
            <span className="muted small rpa-mail-from">
              from {c.mail_from}{c.mail_transport === 'stub' ? ' (recorded only)' : ''}
            </span>
          )}
        </div>
        <div className="rpa-mail-row">
          <label className="rpa-mail-k" htmlFor="rpa-mail-subject">Subject</label>
          <input
            id="rpa-mail-subject"
            className="rpa-mail-subject"
            value={subject}
            disabled={frozen}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <textarea
          className="input rpa-mail-body"
          aria-label="Email body"
          value={body}
          disabled={frozen}
          onChange={(e) => setBody(e.target.value)}
        />

        <div className="rpa-mail-attachments">
          {c.attachments.map((att) => (
            <span key={`${att.kind}-${att.filename}`} className="rpa-attachment" title={att.kind === 'source' ? 'Uploaded pack' : att.kind === 'summary' ? 'Broker-verified summary' : 'Layer schedule and loss experience'}>
              <span className="rpa-attachment-icon" aria-hidden="true" />
              {att.filename}
              <span className="muted">{fmtSize(att.size_bytes)}</span>
            </span>
          ))}
        </div>

        <div className="rpa-mail-actions">
          <button
            type="button"
            className="btn btn-primary rpa-mail-send"
            disabled={!canSend || busy || frozen || chosen.length === 0 || !c.ready}
            onClick={send}
          >
            {busy ? 'Sending…' : sendLabel}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setTab('summary')}>Back to summary</button>
          <span className="rpa-mail-deadline">
            <label htmlFor="rpa-mail-deadline">Response deadline</label>
            <input
              id="rpa-mail-deadline"
              type="date"
              className="input"
              value={deadline}
              disabled={frozen}
              onChange={(e) => changeDeadline(e.target.value)}
            />
            <span className="muted small">reminders auto-send at T-3 days</span>
          </span>
        </div>
        <ErrorBanner error={error} />
      </section>

      <section className="blueprint rpa-panel">
        <div className="sechead">
          <h3 className="seclabel">Panel by reinsurer</h3>
          <span className="sechead-actions">
            <button type="button" className="btn btn-ghost btn-sm" disabled={frozen || !selectable.length} onClick={toggleAll}>
              {allOn ? 'Clear all' : 'Select all'}
            </button>
          </span>
        </div>
        <p className="muted small rpa-panel-lede">
          {c.prior_year?.lines
            ? `Pre-populated from the ${c.prior_year.year} signed panel (${c.prior_year.reference}) and each reinsurer's standing line across the book. Underwriter contacts are held per reinsurer, not per placement.`
            : c.prior_year
              ? `No lines are recorded on the ${c.prior_year.year} placement (${c.prior_year.reference}), so every reinsurer on the register is offered; each row carries its standing line across the book.`
              : 'No prior year is linked to this placement, so every reinsurer on the register is offered; each row carries its standing line across the book.'}
        </p>
        {c.panel.length === 0 && <p className="muted small">No reinsurers on the register yet.</p>}
        <div className="rpa-panel-list">
          {c.panel.map((m) => {
            const on = selected.has(m.market_id) && m.selectable;
            return (
              <label key={m.market_id} className={`rpa-panel-row${on ? ' is-on' : ''}${m.selectable ? '' : ' is-off'}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={frozen || !m.selectable}
                  onChange={() => toggle(m.market_id)}
                  aria-label={`${m.name}${m.contact ? `, ${m.contact.name}` : ''}`}
                />
                <span className="rpa-panel-main">
                  <span className="rpa-panel-head">
                    <span className="rpa-panel-name">{m.name}</span>
                    {m.rating && <Pill tone="neutral">{m.rating}</Pill>}
                    {m.wrote_last_year && <Pill tone="accent">Wrote {c.prior_year?.year}</Pill>}
                    {m.domicile && <span className="rpa-panel-dom">{m.domicile}</span>}
                  </span>
                  <span className="rpa-panel-uw">
                    {m.contact
                      ? <>{m.contact.name} · <span className="rpa-panel-email">{m.contact.email}</span></>
                      : <span className="rpa-missing">No underwriter on file</span>}
                  </span>
                  <span className="rpa-panel-lines num">
                    Standard line {pct(m.standard_line)}
                    {c.prior_year && ` · ${c.prior_year.year} signed ${m.prior_declined ? 'declined' : pct(m.prior_line)}`}
                    {m.withdrawn && ' · withdrawn — declined security'}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/**
 * 03 Market email — the submission draft and the panel it goes to. The gate
 * is the verified summary: before it, the tab says what is missing. From
 * there the send rides the existing submission machinery, so the register,
 * the audit trail and the mailbox behave as they do for any submission.
 */
export default function MarketEmailTab({ shared }) {
  const { analysis: a, result, verified, setTab } = shared;
  const stage = stageOf('email');
  const placement = a.placement;

  if (!result) {
    return (
      <StageEmpty
        stage={stage}
        title="No summary to send"
        note="The market email is drafted from the reviewed summary. Upload the packs and run the AI analysis first."
      >
        <button type="button" className="btn btn-secondary" onClick={() => setTab('pack')}>Open the renewal pack</button>
      </StageEmpty>
    );
  }
  if (!verified) {
    return (
      <StageEmpty
        stage={stage}
        title="The summary has not been verified"
        note="Nothing leaves the desk until a broker has read the AI draft against the packs and signed it off. Verify it on the AI summary tab."
      >
        <button type="button" className="btn btn-secondary" onClick={() => setTab('summary')}>Open the AI summary</button>
      </StageEmpty>
    );
  }
  if (!placement) {
    return (
      <StageEmpty
        stage={stage}
        title="Not linked to a placement"
        note="The submission goes out from the placement it belongs to — its register, its replies, its layers. Link this pack to its placement on the Renewal pack tab."
      >
        <button type="button" className="btn btn-secondary" onClick={() => setTab('pack')}>Link a placement</button>
      </StageEmpty>
    );
  }
  return <Composer shared={shared} />;
}
