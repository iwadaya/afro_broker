import React, { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Card, useFetch, ErrorBanner, StatusPill, fmtStamp } from '../../components.jsx';
import { versionTag, useAllVersions } from './spine.js';
import FourEyes from './FourEyes.jsx';

/**
 * M8 — the client side of the cycle.
 *
 * Negotiation itself needs no machinery: a counter is a new version through
 * the ordinary endpoint (Structures tab). What lives here is the conversation
 * around a version — internal notes kept distinct from what was said to the
 * client — and the quotes sent to the cedant, each D7-gated, with taken up or
 * not-taken-up-and-why recorded when the answer comes.
 */
export default function ClientTab({ shared }) {
  const { versions, loading } = useAllVersions(shared.structures);
  return (
    <>
      <CedantSends shared={shared} versions={versions} />
      <Comments shared={shared} versions={versions} loading={loading} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Quotes to the cedant
// ---------------------------------------------------------------------------
function CedantSends({ shared, versions }) {
  const sends = useFetch('GET', `/contract-years/${shared.yearId}/cedant-sends`, [shared.yearId]);
  const [picked, setPicked] = useState(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reasonFor, setReasonFor] = useState(null);
  const [reason, setReason] = useState('');

  function toggle(id) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  async function run(fn) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      sends.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const create = () => run(async () => {
    await api('POST', `/contract-years/${shared.yearId}/cedant-sends`, {
      structure_version_ids: [...picked],
    });
    setCreating(false);
    setPicked(new Set());
  });

  const outcome = (id, takenUp) => run(async () => {
    await api('POST', `/cedant-sends/${id}/outcome`, takenUp
      ? { taken_up: true }
      : { taken_up: false, not_taken_up_reason: reason });
    setReasonFor(null);
    setReason('');
  });

  return (
    <Card
      title="Quotes to the cedant"
      actions={shared.canEdit && (
        <button className="small ghost" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancel' : 'New quote to cedant'}
        </button>
      )}
    >
      <ErrorBanner error={error || sends.error} />

      {creating && (
        <div className="spine-compose">
          <h4>Versions to show the cedant</h4>
          {versions.map((v) => (
            <label key={v.id} className="spine-pick">
              <input type="checkbox" checked={picked.has(v.id)} onChange={() => toggle(v.id)} />
              {versionTag(v)}
            </label>
          ))}
          {versions.length === 0 && <p className="muted">No versions on this year yet.</p>}
          <button className="small" disabled={busy || picked.size === 0} onClick={create}>
            {busy ? '…' : 'Create draft send'}
          </button>
        </div>
      )}

      <table>
        <thead>
          <tr><th>Raised</th><th>By</th><th>Versions</th><th>Status</th><th>Four-eyes / outcome</th></tr>
        </thead>
        <tbody>
          {sends.data?.map((s) => (
            <tr key={s.id}>
              <td className="mono" style={{ fontSize: 12.5 }}>{fmtStamp(s.created_at)}</td>
              <td>{s.created_by_name || '—'}</td>
              <td>{s.version_count}</td>
              <td>
                <StatusPill value={s.status} />
                {s.not_taken_up_reason && <div className="muted small">{s.not_taken_up_reason}</div>}
              </td>
              <td>
                {s.status === 'DRAFT' && (
                  <FourEyes
                    actionType="quote_to_cedant"
                    entityType="cedant_quote_send"
                    entityId={s.id}
                    sendLabel="Send to cedant"
                    sent={false}
                    onSend={async () => { await api('POST', `/cedant-sends/${s.id}/send`); sends.reload(); }}
                  />
                )}
                {s.status === 'SENT' && shared.canEdit && (
                  reasonFor === s.id ? (
                    <span className="foureyes-glass">
                      <input
                        className="input"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why was it not taken up?"
                      />
                      <button className="small" disabled={busy || !reason.trim()} onClick={() => outcome(s.id, false)}>
                        Record
                      </button>
                      <button className="small ghost" onClick={() => setReasonFor(null)}>Cancel</button>
                    </span>
                  ) : (
                    <>
                      <button className="small" disabled={busy} onClick={() => outcome(s.id, true)}>Taken up</button>
                      <button className="small ghost" disabled={busy} onClick={() => setReasonFor(s.id)}>
                        Not taken up…
                      </button>
                    </>
                  )
                )}
                {(s.status === 'TAKEN_UP' || s.status === 'NOT_TAKEN_UP') && (
                  <span className="muted small">{fmtStamp(s.outcome_at)}</span>
                )}
              </td>
            </tr>
          ))}
          {sends.data?.length === 0 && (
            <tr><td colSpan="5" className="muted">Nothing has gone to the cedant on this year yet.</td></tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The conversation around a version
// ---------------------------------------------------------------------------
function Comments({ shared, versions, loading }) {
  const [versionId, setVersionId] = useState('');

  useEffect(() => {
    if (versionId || !versions.length) return;
    setVersionId(versions[versions.length - 1].id);
  }, [versions, versionId]);

  return (
    <Card title="Negotiation notes">
      <label className="field" style={{ maxWidth: 420 }}>
        <span>Version</span>
        <select className="input" value={versionId} onChange={(e) => setVersionId(e.target.value)}>
          {!versionId && <option value="">{loading ? 'Loading…' : '—'}</option>}
          {versions.map((v) => <option key={v.id} value={v.id}>{versionTag(v)}</option>)}
        </select>
      </label>
      {versionId && <Thread versionId={versionId} canEdit={shared.canEdit} />}
    </Card>
  );
}

function Thread({ versionId, canEdit }) {
  const comments = useFetch('GET', `/structure-versions/${versionId}/comments`, [versionId]);
  const [replyTo, setReplyTo] = useState(null);

  return (
    <>
      <ErrorBanner error={comments.error} />
      {comments.data?.length === 0 && <p className="muted">No notes against this version.</p>}
      {comments.data?.map((c) => (
        <CommentNode key={c.id} comment={c} depth={0} canEdit={canEdit} replyTo={replyTo} setReplyTo={setReplyTo} onPosted={comments.reload} versionId={versionId} />
      ))}
      {canEdit && replyTo === null && (
        <CommentForm versionId={versionId} onPosted={comments.reload} />
      )}
    </>
  );
}

function CommentNode({ comment, depth, canEdit, replyTo, setReplyTo, onPosted, versionId }) {
  return (
    <div className="spine-comment" style={{ marginLeft: depth * 22 }}>
      <div>
        <strong>{comment.author_name || '—'}</strong>{' '}
        <StatusPill
          value={comment.audience}
          tone={comment.audience === 'CEDANT' ? 'gold' : 'grey'}
          label={comment.audience === 'CEDANT' ? 'Said to cedant' : 'Internal'}
        />{' '}
        <span className="muted small mono">{fmtStamp(comment.created_at)}</span>
        {canEdit && (
          <button className="small ghost" onClick={() => setReplyTo(replyTo === comment.id ? null : comment.id)}>
            {replyTo === comment.id ? 'Cancel' : 'Reply'}
          </button>
        )}
      </div>
      <p style={{ margin: '4px 0 8px' }}>{comment.body}</p>
      {replyTo === comment.id && (
        <CommentForm
          versionId={versionId}
          parentId={comment.id}
          onPosted={() => { setReplyTo(null); onPosted(); }}
        />
      )}
      {comment.replies?.map((r) => (
        <CommentNode key={r.id} comment={r} depth={depth + 1} canEdit={canEdit} replyTo={replyTo} setReplyTo={setReplyTo} onPosted={onPosted} versionId={versionId} />
      ))}
    </div>
  );
}

function CommentForm({ versionId, parentId = null, onPosted }) {
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState('INTERNAL');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('POST', `/structure-versions/${versionId}/comments`, {
        body, audience, parent_comment_id: parentId,
      });
      setBody('');
      onPosted();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="inline-form">
      <ErrorBanner error={error} />
      <input
        className="input"
        style={{ flex: 1, minWidth: 260 }}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={parentId ? 'Reply…' : 'Add a note…'}
        required
      />
      <select className="input" value={audience} onChange={(e) => setAudience(e.target.value)}>
        <option value="INTERNAL">Internal</option>
        <option value="CEDANT">Said to cedant</option>
      </select>
      <button type="submit" disabled={busy}>{busy ? '…' : 'Post'}</button>
    </form>
  );
}
