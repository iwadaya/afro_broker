import React, { useState } from 'react';
import { api } from '../api.js';
import { Card, useFetch, Form, StatusPill, ErrorBanner } from '../components.jsx';
import { useHasRole } from '../auth.jsx';

const ROLES = ['broker', 'senior_broker', 'underwriter', 'admin'];

/** Admin-only user provisioning: list users, add new ones, change a role. */
function UsersCard() {
  const users = useFetch('GET', '/auth/users');
  const [error, setError] = useState(null);
  const setRole = async (u, role) => {
    setError(null);
    try { await api('PATCH', `/auth/users/${u.id}`, { role }); users.reload(); } catch (e) { setError(e); }
  };
  const setActive = async (u, active) => {
    setError(null);
    try { await api('PATCH', `/auth/users/${u.id}`, { active }); users.reload(); } catch (e) { setError(e); }
  };
  return (
    <Card title="Users" actions={<button className="small ghost" onClick={users.reload}>Refresh</button>}>
      <Form
        submitLabel="Add user"
        initial={{ role: 'broker' }}
        fields={[
          { name: 'name', label: 'Name', required: true, placeholder: 'Jane Broker' },
          { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'jane@broking.local' },
          { name: 'password', label: 'Password (min 8 chars)', type: 'password', required: true },
          { name: 'role', label: 'Role', type: 'select', required: true, options: ROLES },
        ]}
        onSubmit={async (v) => { await api('POST', '/auth/register', v); users.reload(); }}
      />
      <ErrorBanner error={users.error || error} />
      <p className="muted small">A Senior Broker is a broker who also approves renewal packs — change a user's role here to let them approve.</p>
      <div className="table-scroll">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
        <tbody>
          {users.data?.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>
                <select className="fi" value={u.role} onChange={(e) => setRole(u, e.target.value)} data-testid={`role-${u.email}`} style={{ width: 150 }}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </td>
              <td><span className={`status tone-${u.active ? 'green' : 'grey'}`}>{u.active ? 'active' : 'inactive'}</span></td>
              <td>
                <button type="button" className="small ghost" onClick={() => setActive(u, !u.active)}>{u.active ? 'Deactivate' : 'Reactivate'}</button>
              </td>
            </tr>
          ))}
          {users.data?.length === 0 && <tr><td colSpan="5" className="muted">No users.</td></tr>}
        </tbody>
      </table>
      </div>
    </Card>
  );
}

/** The Outlook mailbox submissions go out from and replies come back into. */
function OutlookCard() {
  const status = useFetch('GET', '/outlook/status');
  const canManage = useHasRole('broker', 'admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('outlook');
  const detail = params.get('detail');
  const s = status.data;
  const when = (d) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  async function act(fn) {
    setBusy(true); setError(null);
    try { await fn(); status.reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <Card title="Outlook mailbox" actions={<button className="small ghost" onClick={status.reload}>Refresh</button>}>
      <ErrorBanner error={status.error || error} />
      {outcome === 'connected' && <div className="np-struct-notice">Outlook is connected — submissions now go out from this mailbox and its inbox is read for replies.</div>}
      {outcome === 'error' && <div className="err banner">Connecting Outlook failed: {detail || 'unknown error'}</div>}
      {s && (
        <dl className="kv">
          <dt>Status</dt>
          <dd>{s.connected ? <span className="status tone-green">connected</span> : <span className="status tone-grey">not connected</span>}</dd>
          {s.connected && (
            <>
              <dt>Mailbox</dt><dd>{s.account.display_name ? `${s.account.display_name} · ` : ''}{s.account.address}</dd>
              <dt>Connected</dt><dd>{when(s.account.connected_at)}</dd>
              <dt>Inbox last read</dt>
              <dd>{when(s.account.last_sync_at)}{s.account.last_sync_error ? <span className="fr-label--missing"> — {s.account.last_sync_error}</span> : ''} · every {Math.round(s.sync_interval_ms / 60000)} min</dd>
            </>
          )}
          <dt>App registration</dt>
          <dd>{s.configured ? `configured (tenant ${s.tenant})` : 'not configured — set MS_CLIENT_ID and MS_CLIENT_SECRET'}</dd>
          <dt>Redirect URI</dt><dd><code>{s.redirect_uri}</code></dd>
        </dl>
      )}
      {s && canManage && (
        <div className="toolbar" style={{ marginTop: 10 }}>
          {!s.connected && (
            <button type="button" className="np-green-pill" disabled={busy || !s.configured}
              title={s.configured ? 'Sign in with Microsoft to connect the mailbox' : 'Configure the app registration first'}
              onClick={() => act(async () => { const r = await api('POST', '/outlook/connect', {}); window.location.href = r.url; })}>
              Connect Outlook
            </button>
          )}
          {s.connected && (
            <>
              <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy}
                onClick={() => act(() => api('POST', '/outlook/sync', {}))}>↻ Read inbox now</button>
              <button type="button" className="np-struct-btn" disabled={busy}
                onClick={() => act(() => api('POST', '/outlook/disconnect', {}))}>Disconnect</button>
            </>
          )}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        Submissions are sent as this mailbox (they land in its Sent Items) and its inbox is read for the underwriters' replies,
        which the AI reads on the Negotiation tab. One mailbox at a time; connecting another replaces it.
      </p>
    </Card>
  );
}

export default function Admin() {
  const isAdmin = useHasRole('admin');
  const audit = useFetch('GET', '/admin/audit?limit=100');
  const approvals = useFetch('GET', '/admin/approvals');

  return (
    <>
      <h1>Admin</h1>

      {isAdmin && <UsersCard />}

      <OutlookCard />

      <Card title="Pending approvals (four-eyes)">
        <ErrorBanner error={approvals.error} />
        <div className="table-scroll">
      <table>
          <thead><tr><th>Action</th><th>Entity</th><th>Proposed by</th><th>When</th></tr></thead>
          <tbody>
            {approvals.data?.map((a) => (
              <tr key={a.id}>
                <td><StatusPill value={a.action_type === 'fot_authorise' ? 'proposed' : a.action_type} /> {a.action_type}</td>
                <td className="small">{a.entity_type}:{a.entity_id?.slice(0, 8)}</td>
                <td>{a.proposed_by_name || '—'}</td>
                <td className="small">{a.created_at?.replace('T', ' ').slice(0, 16)}</td>
              </tr>
            ))}
            {approvals.data?.length === 0 && <tr><td colSpan="4" className="muted">Nothing awaiting authorisation.</td></tr>}
          </tbody>
        </table>
      </div>
      </Card>

      <Card title="Audit trail" actions={<button className="small ghost" onClick={audit.reload}>Refresh</button>}>
        <ErrorBanner error={audit.error} />
        <div className="table-scroll">
      <table>
          <thead><tr><th>When</th><th>Actor</th><th>Entity</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>
            {audit.data?.map((e) => (
              <tr key={e.id}>
                <td className="small">{e.created_at?.replace('T', ' ').slice(0, 19)}</td>
                <td>{e.user_name || '—'} {e.user_role && <span className="role">{e.user_role}</span>}</td>
                <td className="small">{e.entity_type}:{String(e.entity_id || '').slice(0, 8)}</td>
                <td><code>{e.action}</code></td>
                <td className="small muted">{Object.keys(e.detail || {}).length ? JSON.stringify(e.detail) : '—'}</td>
              </tr>
            ))}
            {audit.data?.length === 0 && <tr><td colSpan="5" className="muted">No events.</td></tr>}
          </tbody>
        </table>
      </div>
      </Card>
    </>
  );
}
