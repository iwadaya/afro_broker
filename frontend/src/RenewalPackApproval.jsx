import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { StructCard } from './StructureSections.jsx';

/*
 * The Pack Approval screen — the stage after the Renewal Pack.
 *
 * Where each version of the pack stands and how it got there: the broker
 * submits a version, a Senior Broker approves it or returns it with a note,
 * and every step is on the audit trail with who took it and when. The
 * thread under it holds the reviewers' comments — versioned, so a revised
 * comment keeps every wording it has had — and the record of what changed
 * between versions. An approved version opens the Quoting Stage.
 */

const day = (d) => (d ? String(d).slice(0, 10) : '');
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const ACTION_LABEL = {
  build: 'Version created',
  submit: 'Submitted for approval',
  approve: 'Approved for market',
  reject: 'Returned with a note',
  update: 'Metadata amended',
  comment: 'Comment',
  'comment.revise': 'Comment revised',
  export: 'Exported',
};

/** Draft → submitted → approved (or returned), as the version stands. */
function Stepper({ v }) {
  const returned = v.status === 'draft' && v.rejection_note;
  const steps = [
    { key: 'created', label: 'Created', done: true, text: `${v.created_by_name || 'the broker'} · ${when(v.created_at)}` },
    { key: 'submitted', label: 'Submitted', done: !!v.submitted_at || v.status === 'approved', active: v.status === 'draft' && !returned,
      text: v.submitted_at ? `${v.submitted_by_name || 'the broker'} · ${when(v.submitted_at)}` : (returned ? 'to submit again' : 'awaiting submission') },
    { key: 'approval', label: v.status === 'approved' ? 'Approved' : returned ? 'Returned' : 'Approval', done: v.status === 'approved', active: v.status === 'submitted', returned: !!returned,
      text: v.status === 'approved' ? `${v.approved_by_name || 'a Senior Broker'} · ${when(v.approved_at)}`
        : returned ? `${v.rejected_by_name || 'a Senior Broker'} · ${when(v.rejected_at)}`
          : v.status === 'submitted' ? 'awaiting a Senior Broker' : 'not yet' },
  ];
  return (
    <div className="pa-stepper" data-testid="pack-stepper">
      {steps.map((s) => (
        <div key={s.key} className={`pa-step${s.done ? ' pa-step--done' : ''}${s.active ? ' pa-step--active' : ''}${s.returned ? ' pa-step--returned' : ''}`}>
          <div className="pa-step-k">{s.label}</div>
          <div className="pa-step-v">{s.text}</div>
        </div>
      ))}
    </div>
  );
}

function Comment({ c, canRevise, onRevise, busy }) {
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  return (
    <div className="pa-comment" data-testid="pack-comment">
      <div className="pa-comment-head">
        <b>{c.created_by_name || 'Someone'}</b>
        {c.created_by_role && <span className="pill-mini">{String(c.created_by_role).replace('_', ' ').toUpperCase()}</span>}
        <span>{when(c.first_at)}</span>
        {c.edits > 0 && (
          <button type="button" className="np-struct-btn" onClick={() => setShowHistory((h) => !h)}>
            revised {c.edits}× — {showHistory ? 'hide' : 'show'} earlier wordings
          </button>
        )}
        {canRevise && !editing && (
          <button type="button" className="np-struct-btn" disabled={busy} onClick={() => setEditing(true)}>Revise</button>
        )}
      </div>
      {editing ? (
        <div className="pa-comment-form">
          <textarea className="fi" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
          <button type="button" className="np-green-pill" disabled={busy || !body.trim() || body.trim() === c.body}
            onClick={async () => { await onRevise(c.id, body.trim()); setEditing(false); }}>Save revision</button>
          <button type="button" className="np-struct-btn" onClick={() => { setEditing(false); setBody(c.body); }}>Cancel</button>
        </div>
      ) : <div className="pa-comment-body">{c.body}</div>}
      {showHistory && c.history?.length > 0 && (
        <div className="pa-comment-history">
          {c.history.map((h) => (
            <div key={h.id}><span>{when(h.created_at)}:</span> {h.body}</div>
          ))}
          <div><span>{when(c.created_at)}:</span> {c.body} <i>(current)</i></div>
        </div>
      )}
    </div>
  );
}

export default function RenewalPackApproval({ placementId, canEdit, canApprove = false, user, onPacksChange, onOpenScreen }) {
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [returning, setReturning] = useState(false);
  const [returnNote, setReturnNote] = useState('');
  const [comment, setComment] = useState('');

  const load = () => api('GET', `/placements/${placementId}/pack-approval`)
    .then((d) => {
      setData(d);
      setSelectedId((cur) => (cur && d.versions.some((v) => v.id === cur) ? cur : d.versions[0]?.id || null));
    })
    .catch(setError);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [placementId]);

  const act = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const step = (packId, action, body = {}) => act(async () => {
    await api('POST', `/packs/${packId}/${action}`, body);
    setReturning(false); setReturnNote('');
    if (onPacksChange) onPacksChange();
  });
  const addComment = () => act(async () => {
    await api('POST', `/packs/${selectedId}/comments`, { body: comment.trim() });
    setComment('');
  });
  const revise = (id, body) => act(() => api('POST', `/packs/${selectedId}/comments`, { body, replaces_id: id }));

  const selected = useMemo(() => data?.versions.find((v) => v.id === selectedId) || null, [data, selectedId]);
  const timeline = useMemo(() => {
    if (!selected) return [];
    const events = (selected.trail || []).map((e) => ({
      id: e.id, at: e.created_at, action: e.action, who: e.user_name, role: e.user_role,
      note: e.detail?.note || (e.action === 'comment' || e.action === 'comment.revise' ? e.detail?.body : null),
      detail: e.detail || {},
    }));
    return events.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }, [selected]);

  if (!data) return <div className="muted" style={{ padding: 12 }}>{error ? error.message : 'Loading…'}</div>;

  if (!data.versions.length) {
    return (
      <section className="np-struct-card rp" data-testid="pack-approval-empty">
        <div className="np-struct-card-header">
          <div>
            <div className="np-struct-card-h2">Pack Approval</div>
            <div className="np-struct-card-hint">No renewal pack version exists yet. Create one on the Renewal Pack tab; it comes here for the Senior Broker's approval.</div>
          </div>
          <div className="np-struct-card-actions">
            {onOpenScreen && <button type="button" className="np-struct-btn np-struct-btn--accent" onClick={() => onOpenScreen('pack')}>Open the Renewal Pack tab</button>}
          </div>
        </div>
      </section>
    );
  }

  const v = selected;
  const blockedBy = v?.required_missing || [];
  const blockedTitle = blockedBy.length
    ? `Every required screen needs data before the pack goes for approval — this version was created without: ${blockedBy.join(', ')}. Fill them and create a new version.`
    : 'Send this version to a Senior Broker for approval.';
  const approved = data.versions.find((x) => x.status === 'approved');

  return (
    <section className="np-struct-card rp" data-testid="pack-approval-screen">
      <div className="np-struct-card-header">
        <div>
          <div className="np-struct-card-h2">Pack Approval</div>
          <div className="np-struct-card-hint">
            Where each version stands — draft, submitted, approved or returned — who took each step and when, the reviewers' comments (every wording kept) and what changed between versions.
            {approved ? ` v${approved.version} is approved: the Quoting Stage is open.` : ' The Quoting Stage opens once a version is approved.'}
          </div>
        </div>
        <div className="np-struct-card-actions">
          <select className="np-mini-input" style={{ width: 200 }} value={selectedId || ''} onChange={(e) => setSelectedId(e.target.value)} data-testid="approval-version">
            {data.versions.map((x) => (
              <option key={x.id} value={x.id}>v{x.version} · {x.status === 'submitted' ? 'awaiting approval' : x.status} · {day(x.created_at)}</option>
            ))}
          </select>
          {canEdit && v?.status === 'draft' && (
            <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy || blockedBy.length > 0} data-testid="submit-pack"
              title={blockedTitle} onClick={() => step(v.id, 'submit')}>
              Submit v{v.version} for approval
            </button>
          )}
          {canApprove && v?.status === 'submitted' && (
            <>
              <button type="button" className="np-green-pill" disabled={busy} data-testid="approve-pack"
                title="Approve this version for market — it opens the Quoting Stage." onClick={() => step(v.id, 'approve')}>
                Approve v{v.version}
              </button>
              <button type="button" className="np-struct-btn" disabled={busy} data-testid="return-pack" onClick={() => setReturning((r) => !r)}>
                Return with note
              </button>
            </>
          )}
        </div>
      </div>
      {error && <div className="ing-error">{error.message || 'Failed'}</div>}

      {v && (
        <>
          <Stepper v={v} />
          <div className={`rp-approval rp-approval--${v.status}`} data-testid="pack-approval">
            <span className={`rp-status rp-status--${v.status}`}>{v.status === 'submitted' ? 'awaiting approval' : v.status}</span>
            <span className="rp-approval-text">
              {v.status === 'approved' && (
                <>Approved by <b>{v.approved_by_name || 'a Senior Broker'}</b> on {day(v.approved_at)} — cleared for market; the Quoting Stage is open and works from this version (its Excel and PDF go with every email).</>
              )}
              {v.status === 'submitted' && (
                <>Submitted by <b>{v.submitted_by_name || 'the broker'}</b> on {day(v.submitted_at)} — awaiting a Senior Broker's approval before it can go to market.</>
              )}
              {v.status === 'draft' && v.rejection_note && (
                <>Returned by <b>{v.rejected_by_name || 'a Senior Broker'}</b> on {day(v.rejected_at)}: <i>{v.rejection_note}</i> — address it and submit again, or create a new version on the Renewal Pack tab.</>
              )}
              {v.status === 'draft' && !v.rejection_note && blockedBy.length === 0 && (
                <>Draft — submit it for a Senior Broker's approval. The Quoting Stage opens once a version is approved.</>
              )}
              {blockedBy.length > 0 && (
                <span className="rp-approval-required" data-testid="approval-required-missing">
                  {v.status === 'draft' ? 'Submit is held — r' : 'R'}equired screens without data when this version was created: <b>{blockedBy.join(', ')}</b>.
                  {v.status === 'draft' ? ' Fill them on the screens and create a new version.' : ''}
                </span>
              )}
            </span>
            {returning && canApprove && v.status === 'submitted' && (
              <div className="rp-return">
                <textarea className="rp-return-note" placeholder="What needs to change before this pack can go to market?"
                  value={returnNote} onChange={(e) => setReturnNote(e.target.value)} maxLength={2000} data-testid="return-note" />
                <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy || !returnNote.trim()}
                  data-testid="return-confirm" onClick={() => step(v.id, 'reject', { note: returnNote.trim() })}>
                  Return v{v.version} to the broker
                </button>
              </div>
            )}
          </div>

          {v.changes?.length > 0 && (
            <div className="rp-changes" data-testid="approval-changes">
              <b>Changed since v{v.version - 1}:</b>{' '}
              {v.changes.map((c) => (
                <span key={c.key} className={`rp-change rp-change--${c.change}`}>{c.title} {c.change}</span>
              ))}
            </div>
          )}

          <StructCard
            title={`Comments on v${v.version}`}
            hint="The reviewers' thread on this version. A comment is revised, never overwritten — every wording it has had stays readable."
            actions={<span className="np-layer-count">Comments<b>{v.comments?.length || '—'}</b></span>}
          >
            <div className="pa-comments" data-testid="pack-comments">
              {(v.comments || []).map((c) => (
                <Comment key={c.id} c={c} busy={busy} onRevise={revise}
                  canRevise={!!user && (c.created_by === user.id || user.role === 'admin')} />
              ))}
              {!v.comments?.length && <div className="muted small">No comments on this version yet.</div>}
            </div>
            <div className="pa-comment-form">
              <textarea className="fi" placeholder={`A comment on v${v.version} — a question for the broker, a point for the Senior Broker, a note for the file…`}
                value={comment} maxLength={4000} onChange={(e) => setComment(e.target.value)} data-testid="comment-body" />
              <button type="button" className="np-green-pill" disabled={busy || !comment.trim()} data-testid="add-comment" onClick={addComment}>
                Add comment
              </button>
            </div>
          </StructCard>

          <StructCard title={`Audit trail of v${v.version}`} hint="Every step this version has taken, newest first: created, submitted, approved or returned, commented — with who took it and when.">
            <ul className="pa-timeline" data-testid="pack-trail">
              {timeline.map((e) => (
                <li key={e.id} className={`pa-event pa-event--${e.action.split('.')[0]}`}>
                  <span className="pa-event-when">{when(e.at)}</span>
                  <span>
                    <b>{ACTION_LABEL[e.action] || e.action}</b>{e.who ? ` — ${e.who}` : ''}{e.role ? ` (${String(e.role).replace('_', ' ')})` : ''}
                    {e.note && <span className="pa-event-note">{e.note}</span>}
                    {e.action === 'build' && e.detail.sections_filled != null && (
                      <span className="pa-event-note muted">{e.detail.sections_filled} sections filled{e.detail.files ? ` · Excel ${Math.round((e.detail.files.xlsx || 0) / 1024)} KB · PDF ${Math.round((e.detail.files.pdf || 0) / 1024)} KB` : ''}</span>
                    )}
                  </span>
                </li>
              ))}
              {!timeline.length && <li className="muted small">Nothing on the trail yet.</li>}
            </ul>
          </StructCard>
        </>
      )}
    </section>
  );
}
