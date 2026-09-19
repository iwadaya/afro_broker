import React, { useState } from 'react';
import { api } from '../../api.js';
import { useFetch, ErrorBanner, fmtStamp } from '../../components.jsx';
import { useHasRole, useAuth } from '../../auth.jsx';

/**
 * D7 — the four-eyes cycle in front of an outbound action.
 *
 * One person proposes, a different underwriter or admin authorises, and the
 * send consumes the grant (one approval, one send — the server enforces all
 * three rules; this widget only walks the cycle and shows where it stands).
 * Break-glass is offered to admins because D7 makes the escape hatch
 * mandatory: a control nobody can override at 11pm on 31 December gets
 * bypassed with a shared login instead.
 */
export default function FourEyes({
  actionType, entityType, entityId,
  sendLabel = 'Send', onSend, sent = false, sentAt = null,
}) {
  const approvals = useFetch(
    'GET',
    `/approvals?entity_type=${entityType}&entity_id=${entityId}`,
    [entityType, entityId],
  );
  const { user } = useAuth();
  const canPropose = useHasRole('broker', 'admin');
  const canAuthorise = useHasRole('underwriter', 'admin');
  const isAdmin = useHasRole('admin');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [glass, setGlass] = useState(false);
  const [reason, setReason] = useState('');

  const rows = (approvals.data || []).filter((a) => a.action_type === actionType);
  const pending = rows.find((a) => a.status === 'pending');
  const ready = rows.find(
    (a) => (a.status === 'approved' || a.status === 'overridden') && !a.consumed_at,
  );
  const used = rows.find((a) => a.consumed_at);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      approvals.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const propose = () => run(() => api('POST', '/approvals', {
    action_type: actionType, entity_type: entityType, entity_id: entityId,
  }));
  const authorise = () => run(() => api('POST', `/approvals/${pending.id}/approve`));
  const breakGlass = () => run(async () => {
    await api('POST', '/approvals/break-glass', {
      action_type: actionType, entity_type: entityType, entity_id: entityId, reason,
    });
    setGlass(false);
    setReason('');
  });
  const send = () => run(async () => { await onSend(); });

  if (sent) {
    return (
      <div className="foureyes">
        <span className="status tone-green">Sent{sentAt ? ` · ${fmtStamp(sentAt)}` : ''}</span>
        {used && (
          <span className="muted small">
            {used.status === 'overridden'
              ? ` break-glass by ${used.overridden_by_name}: "${used.override_reason}"`
              : ` approved by ${used.approved_by_name}`}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="foureyes">
      {!pending && !ready && (
        <>
          <span className="muted small">Four-eyes: not yet proposed.</span>
          {canPropose && (
            <button className="small" disabled={busy} onClick={propose}>Request approval</button>
          )}
        </>
      )}

      {pending && (
        <>
          <span className="status tone-amber">
            Awaiting authorisation · proposed by {pending.proposed_by_name}
          </span>
          {canAuthorise && pending.proposed_by_name !== user?.name && (
            <button className="small" disabled={busy} onClick={authorise}>Authorise</button>
          )}
        </>
      )}

      {ready && (
        <>
          <span className="status tone-green">
            {ready.status === 'overridden'
              ? `Break-glass by ${ready.overridden_by_name}`
              : `Approved by ${ready.approved_by_name}`}
          </span>
          <button className="small" disabled={busy} onClick={send}>{sendLabel}</button>
        </>
      )}

      {isAdmin && !ready && (
        glass ? (
          <span className="foureyes-glass">
            <input
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Stated reason (min 10 chars) — this is reported"
            />
            <button className="small" disabled={busy || reason.trim().length < 10} onClick={breakGlass}>
              Override
            </button>
            <button className="small ghost" onClick={() => setGlass(false)}>Cancel</button>
          </span>
        ) : (
          <button className="small ghost" onClick={() => setGlass(true)}>Break glass…</button>
        )
      )}

      <ErrorBanner error={error || approvals.error} />
    </div>
  );
}
