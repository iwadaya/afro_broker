import React, { useMemo, useState } from 'react';
import { api } from '../../api.js';
import { Card, useFetch, ErrorBanner, StatusPill, fmtStamp } from '../../components.jsx';
import { summariseTerms, versionTag, useAllVersions } from './spine.js';
import FourEyes from './FourEyes.jsx';

/**
 * M3 — distribution and market approach.
 *
 * Two stages, one engine: the pack to quoting markets for terms, and — once a
 * version is promoted — the firm order terms to follow markets for shares.
 * Every approach names the exact versions sent, which is what lets a response
 * attach to the terms a market actually saw, and each stage consumes its own
 * D7 approval so an authorisation to canvass terms cannot be spent releasing
 * firm order terms.
 */
export default function MarketingTab({ shared }) {
  const distributions = useFetch('GET', `/contract-years/${shared.yearId}/distributions`, [shared.yearId]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);

  return (
    <>
      <Card
        title="Approaches to market"
        actions={shared.canEdit && (
          <button className="small ghost" onClick={() => setCreating(!creating)}>
            {creating ? 'Cancel' : 'New approach'}
          </button>
        )}
      >
        <ErrorBanner error={distributions.error} />
        {creating && (
          <NewDistribution
            shared={shared}
            onDone={() => { setCreating(false); distributions.reload(); }}
          />
        )}
        <table>
          <thead>
            <tr>
              <th>Stage</th><th>Subject</th><th>Versions</th><th>Recipients</th>
              <th>Status</th><th>Sent</th><th /></tr>
          </thead>
          <tbody>
            {distributions.data?.map((d) => (
              <tr key={d.id}>
                <td><StatusPill value={d.stage} /></td>
                <td>{d.subject}</td>
                <td>{d.version_count}</td>
                <td>{d.recipient_count}</td>
                <td><StatusPill value={d.status} /></td>
                <td className="mono" style={{ fontSize: 12.5 }}>{d.sent_at ? fmtStamp(d.sent_at) : '—'}</td>
                <td>
                  <button className="small ghost" onClick={() => setOpen(open === d.id ? null : d.id)}>
                    {open === d.id ? 'Close' : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
            {distributions.data?.length === 0 && (
              <tr><td colSpan="7" className="muted">Nothing has gone to market on this year yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {open && (
        <DistributionDetail id={open} canEdit={shared.canEdit} onChange={distributions.reload} />
      )}
    </>
  );
}

/** One approach: what went out, to whom, and what each message did. */
function DistributionDetail({ id, canEdit, onChange }) {
  const detail = useFetch('GET', `/distributions/${id}`, [id]);
  const [error, setError] = useState(null);

  if (detail.loading) return <p className="muted">Loading…</p>;
  if (detail.error) return <ErrorBanner error={detail.error} />;
  const d = detail.data;
  const reload = () => { detail.reload(); onChange(); };

  async function recordEvent(recipientId, event) {
    setError(null);
    try {
      await api('POST', `/distribution-recipients/${recipientId}/event`, { event });
      detail.reload();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Card title={`${d.stage === 'FOLLOW' ? 'Follow release' : 'Quoting approach'} — ${d.subject}`}>
      <ErrorBanner error={error} />
      <p className="muted small">
        Versions sent: {d.versions.map((v) => `${v.label} v${v.version_no} ${v.status}`).join(' · ')}
        {d.reply_to && <> · replies to <code>{d.reply_to}</code></>}
        {!d.reply_to && <> · no reply-to domain configured (D5), replies untracked</>}
      </p>

      <FourEyes
        actionType={d.stage === 'FOLLOW' ? 'fot_send' : 'submission_send'}
        entityType="distribution"
        entityId={d.id}
        sendLabel={d.stage === 'FOLLOW' ? 'Release FOT to follow markets' : 'Send to quoting markets'}
        sent={d.status !== 'DRAFT'}
        sentAt={d.sent_at}
        onSend={async () => { await api('POST', `/distributions/${d.id}/send`); reload(); }}
      />

      <table style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Reinsurer</th><th>Recipient</th><th>Status</th>
            <th>Sent</th><th>Delivered</th><th>Opened</th><th>Responded</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {d.recipients.map((r) => (
            <tr key={r.id}>
              <td><strong>{r.reinsurer_name}</strong></td>
              <td>{r.name || '—'} <span className="muted">{r.email}</span></td>
              <td><StatusPill value={r.status} />{r.error && <span className="muted small"> {r.error}</span>}</td>
              <td className="mono" style={{ fontSize: 12 }}>{r.sent_at ? fmtStamp(r.sent_at) : '—'}</td>
              <td className="mono" style={{ fontSize: 12 }}>{r.delivered_at ? fmtStamp(r.delivered_at) : '—'}</td>
              <td className="mono" style={{ fontSize: 12 }}>{r.opened_at ? fmtStamp(r.opened_at) : '—'}</td>
              <td className="mono" style={{ fontSize: 12 }}>{r.responded_at ? fmtStamp(r.responded_at) : '—'}</td>
              {canEdit && (
                <td>
                  {r.status !== 'PENDING' && ['DELIVERED', 'OPENED', 'RESPONDED', 'BOUNCED'].map((ev) => (
                    <button key={ev} className="small ghost" onClick={() => recordEvent(r.id, ev)}>
                      {ev.toLowerCase()}
                    </button>
                  ))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Compose an approach: stage, versions, and who receives it. */
function NewDistribution({ shared, onDone }) {
  const candidates = useFetch('GET', `/contract-years/${shared.yearId}/distribution-candidates`, [shared.yearId]);
  const { versions } = useAllVersions(shared.structures);
  const [stage, setStage] = useState('QUOTING');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [recipients, setRecipients] = useState(new Set());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // A follow release carries firm order terms and nothing else (M3).
  const sendable = useMemo(
    () => (stage === 'FOLLOW' ? versions.filter((v) => v.status === 'FOT') : versions),
    [stage, versions],
  );

  const toggle = (set, setter) => (id) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };
  const toggleVersion = toggle(picked, setPicked);
  const toggleRecipient = toggle(recipients, setRecipients);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const rows = (candidates.data?.candidates || []).filter((c) => recipients.has(c.contact_id));
      await api('POST', `/contract-years/${shared.yearId}/distributions`, {
        stage,
        subject,
        body,
        structure_version_ids: [...picked],
        recipients: rows.map((c) => ({
          reinsurer_id: c.reinsurer_id,
          contact_id: c.contact_id,
          name: c.contact_name,
          email: c.email,
        })),
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="spine-compose">
      <ErrorBanner error={error || candidates.error} />
      <div className="inline-form">
        <label className="field">
          <span>Stage</span>
          <select className="input" value={stage} onChange={(e) => { setStage(e.target.value); setPicked(new Set()); }}>
            <option value="QUOTING">Quoting — pack for terms</option>
            <option value="FOLLOW">Follow — FOT for shares</option>
          </select>
        </label>
        <label className="field">
          <span>Subject *</span>
          <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} required />
        </label>
      </div>
      <label className="field">
        <span>Message *</span>
        <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} required />
      </label>

      <h4>Versions to send</h4>
      {sendable.length === 0 && (
        <p className="muted">
          {stage === 'FOLLOW'
            ? 'No FOT versions on this year — promote one first; a follow market is asked for a share of agreed terms.'
            : 'No versions on this year yet.'}
        </p>
      )}
      {sendable.map((v) => (
        <label key={v.id} className="spine-pick">
          <input type="checkbox" checked={picked.has(v.id)} onChange={() => toggleVersion(v.id)} />
          {versionTag(v)} <span className="muted">{summariseTerms(v.basis, v)}</span>
        </label>
      ))}

      <h4>Recipients (from the register — security-declined markets are excluded)</h4>
      {candidates.data?.candidates?.map((c) => (
        <label key={c.contact_id} className="spine-pick">
          <input
            type="checkbox"
            checked={recipients.has(c.contact_id)}
            onChange={() => toggleRecipient(c.contact_id)}
          />
          <strong>{c.reinsurer_name}</strong> · {c.contact_name} <span className="muted">{c.email}</span>
          {c.rating && <span className="muted"> · {c.rating} {c.rating_agency}</span>}
        </label>
      ))}
      {candidates.data?.candidates?.length === 0 && (
        <p className="muted">No sendable contacts on the register — add reinsurer contacts with emails.</p>
      )}

      <button type="submit" disabled={busy || picked.size === 0 || recipients.size === 0}>
        {busy ? '…' : 'Create draft approach'}
      </button>
    </form>
  );
}
