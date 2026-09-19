import React, { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import {
  Card, useFetch, Form, ErrorBanner, StatusPill, Tabs, fmtDate, fmtStamp,
} from '../../components.jsx';
import { useScreenHead } from '../../shell.jsx';
import { useHasRole } from '../../auth.jsx';
import { summariseTerms, parseJson } from './spine.js';
import MarketingTab from './MarketingTab.jsx';
import ResponsesTab from './ResponsesTab.jsx';
import ClientTab from './ClientTab.jsx';
import LinesTab from './LinesTab.jsx';

/**
 * The placement workspace for one contract year — the spine's working screen.
 *
 * Everything M3–M9 does happens to this year's structures and their versions:
 * terms are versioned and diffed here, packs go to quoting markets, responses
 * and the silences are recorded, quotes go to the cedant, a version is
 * promoted to FOT, and lines are written and signed against it. One screen,
 * because it is one placement.
 */
export default function YearWorkspace() {
  const { id } = useParams();
  const year = useFetch('GET', `/contract-years/${id}`, [id]);
  const structuresView = useFetch('GET', `/contract-years/${id}/structures?include_expiring=1`, [id]);
  const completion = useFetch('GET', `/contract-years/${id}/completion`, [id]);
  const reinsurers = useFetch('GET', '/markets?type=reinsurer&limit=200');
  const canEdit = useHasRole('broker', 'admin');
  const [tab, setTab] = useState('structures');

  const y = year.data;
  useScreenHead(
    y ? `Placements · ${y.cedant_name}` : 'Placements',
    y ? `${y.contract_name} — ${y.year_label}` : 'Placement workspace',
    y ? `${fmtDate(y.inception, { shortYear: true })} → ${fmtDate(y.expiry, { shortYear: true })} · ${y.currency}` : null,
  );

  const shared = useMemo(() => ({
    yearId: id,
    year: y,
    structures: structuresView.data?.structures || [],
    completion: completion.data || [],
    reinsurers: reinsurers.data || [],
    canEdit,
    reloadStructures: structuresView.reload,
    reloadCompletion: completion.reload,
  }), [id, y, structuresView.data, completion.data, reinsurers.data, canEdit,
    structuresView.reload, completion.reload]);

  if (year.error) return <ErrorBanner error={year.error} />;

  return (
    <>
      <ErrorBanner error={structuresView.error || reinsurers.error} />

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'structures', label: 'Structures', hint: shared.structures.length || null },
          { value: 'marketing', label: 'Marketing' },
          { value: 'responses', label: 'Responses' },
          { value: 'client', label: 'Client' },
          { value: 'lines', label: 'Lines & signing' },
        ]}
      />

      {tab === 'structures' && <StructuresTab shared={shared} view={structuresView} />}
      {tab === 'marketing' && <MarketingTab shared={shared} />}
      {tab === 'responses' && <ResponsesTab shared={shared} />}
      {tab === 'client' && <ClientTab shared={shared} />}
      {tab === 'lines' && <LinesTab shared={shared} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Structures — the version chains, and what changed between any two states
// ---------------------------------------------------------------------------
function StructuresTab({ shared, view }) {
  const schemas = useFetch('GET', '/term-schemas');
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);

  const expiring = view.data?.expiring;
  const expiringFor = (label) =>
    expiring?.structures?.find((e) => e.label === label)?.latest_version ?? null;

  return (
    <>
      {view.data?.warnings?.map((w) => (
        <div className="warn banner" key={w.structures.join('-')}>{w.message}</div>
      ))}
      {expiring?.source === 'UNLINKED' && (
        <p className="muted">
          No linked prior year, so nothing shows as expiring. Link the renewal chain on the
          Contracts screen, or enter the expiring structure on this year.
        </p>
      )}

      <Card
        title="Structures on this year"
        actions={shared.canEdit && (
          <button className="small ghost" onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add structure'}
          </button>
        )}
      >
        {adding && (
          <Form
            submitLabel="Add structure"
            fields={[
              { name: 'label', label: 'Label', required: true, placeholder: 'Cat XL Layer 1' },
              {
                name: 'treaty_type',
                label: 'Treaty type',
                type: 'select',
                required: true,
                options: (schemas.data || []).map((t) => ({
                  value: t.treaty_type, label: `${t.treaty_type} (${t.basis})`,
                })),
              },
              { name: 'cob', label: 'Class of business', required: true, placeholder: 'Property' },
              { name: 'terms', label: 'Terms (JSON)', required: true, type: 'textarea', rows: 5, placeholder: '{"currency":"USD","deductible":"5000000", …}' },
            ]}
            onSubmit={async (v) => {
              await api('POST', `/contract-years/${shared.yearId}/structures`, {
                label: v.label,
                treaty_type: v.treaty_type,
                cob: v.cob,
                terms: parseJson(v.terms),
              });
              setAdding(false);
              view.reload();
              shared.reloadCompletion();
            }}
          />
        )}

        <table>
          <thead>
            <tr>
              <th>Structure</th><th>Basis</th><th>Current terms</th><th>Expiring</th>
              <th>Versions</th><th />
            </tr>
          </thead>
          <tbody>
            {shared.structures.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.label}</strong> <span className="muted">{s.treaty_type}</span></td>
                <td>{s.basis}</td>
                <td>{summariseTerms(s.basis, s.latest_version)}</td>
                <td className="muted">{summariseTerms(s.basis, expiringFor(s.label))}</td>
                <td>
                  {s.version_count}
                  {s.latest_version && <> · <StatusPill value={s.latest_version.status} /></>}
                </td>
                <td>
                  <button className="small ghost" onClick={() => setOpen(open === s.id ? null : s.id)}>
                    {open === s.id ? 'Close' : 'History'}
                  </button>
                </td>
              </tr>
            ))}
            {shared.structures.length === 0 && (
              <tr><td colSpan="6" className="muted">No structures on this year yet.</td></tr>
            )}
            {expiring?.structures
              ?.filter((e) => !shared.structures.some((s) => s.label === e.label))
              .map((e) => (
                <tr key={`expiring-${e.id}`} className="muted">
                  <td>{e.label}</td>
                  <td>{e.basis}</td>
                  <td>— not being quoted —</td>
                  <td>{summariseTerms(e.basis, e.latest_version)}</td>
                  <td>expiring only</td>
                  <td />
                </tr>
              ))}
          </tbody>
        </table>
      </Card>

      {open && (
        <VersionHistory
          structureId={open}
          canEdit={shared.canEdit}
          reinsurers={shared.reinsurers}
          onChange={() => { view.reload(); shared.reloadCompletion(); }}
        />
      )}
    </>
  );
}

/** One structure's chain: every state it has passed through, and the diffs. */
function VersionHistory({ structureId, canEdit, reinsurers, onChange }) {
  const detail = useFetch('GET', `/structures/${structureId}`, [structureId]);
  const [adding, setAdding] = useState(false);
  const [diff, setDiff] = useState({ from: '', to: '' });
  const [changes, setChanges] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  if (detail.loading) return <p className="muted">Loading versions…</p>;
  if (detail.error) return <ErrorBanner error={detail.error} />;
  const s = detail.data;
  const versions = s.versions || [];
  const liveFot = [...versions].reverse().find((v) => v.status === 'FOT');

  async function promote(v) {
    setBusy(v.id);
    setError(null);
    try {
      await api('POST', `/structure-versions/${v.id}/promote-fot`);
      detail.reload();
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function runDiff() {
    setError(null);
    try {
      const d = await api('GET', `/structure-versions/${diff.from}/diff/${diff.to}`);
      setChanges(d);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Card title={`${s.label} — version history`}>
      <ErrorBanner error={error} />
      <table>
        <thead>
          <tr>
            <th>v</th><th>Status</th><th>Origin</th><th>Terms</th><th>Parent</th><th>Created</th><th />
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id}>
              <td className="mono">v{v.version_no}</td>
              <td>
                <StatusPill value={v.status} />
                {liveFot?.id === v.id && <span className="muted small"> live</span>}
              </td>
              <td>
                {v.origin}
                {v.origin_party_name && <span className="muted"> · {v.origin_party_name}</span>}
              </td>
              <td>{summariseTerms(s.basis, v)}</td>
              <td className="muted">
                {v.parent_version_id
                  ? `v${versions.find((p) => p.id === v.parent_version_id)?.version_no ?? '?'}`
                  : '—'}
              </td>
              <td className="mono" style={{ fontSize: 12.5 }}>{fmtStamp(v.created_at)}</td>
              <td>
                {canEdit && v.status !== 'FOT' && v.status !== 'BOUND' && (
                  <button className="small" disabled={busy === v.id} onClick={() => promote(v)}>
                    {busy === v.id ? '…' : 'Promote to FOT'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="inline-form" style={{ marginTop: 10 }}>
        <label className="field">
          <span>Diff from</span>
          <select className="input" value={diff.from} onChange={(e) => setDiff({ ...diff, from: e.target.value })}>
            <option value="">—</option>
            {versions.map((v) => <option key={v.id} value={v.id}>v{v.version_no} {v.status}</option>)}
          </select>
        </label>
        <label className="field">
          <span>to</span>
          <select className="input" value={diff.to} onChange={(e) => setDiff({ ...diff, to: e.target.value })}>
            <option value="">—</option>
            {versions.map((v) => <option key={v.id} value={v.id}>v{v.version_no} {v.status}</option>)}
          </select>
        </label>
        <button className="small" disabled={!diff.from || !diff.to || diff.from === diff.to} onClick={runDiff}>
          Diff
        </button>
        {canEdit && (
          <button className="small ghost" onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add version'}
          </button>
        )}
      </div>

      {changes && (
        <div style={{ marginTop: 8 }}>
          <h4>
            v{changes.from.version_no} {changes.from.status} → v{changes.to.version_no} {changes.to.status}
          </h4>
          {changes.changes.length === 0 && <p className="muted">No differences in terms.</p>}
          {changes.changes.length > 0 && (
            <table>
              <thead><tr><th>Term</th><th>From</th><th>To</th></tr></thead>
              <tbody>
                {changes.changes.map((c) => (
                  <tr key={c.path}>
                    <td className="mono">{c.path}</td>
                    <td>{showValue(c.from)}</td>
                    <td>{showValue(c.to)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {adding && (
        <Form
          submitLabel="Add version"
          initial={{ status: 'NEGOTIATED', origin: 'BROKER', terms: JSON.stringify(versions.at(-1)?.terms_display ?? {}, null, 2) }}
          fields={[
            {
              name: 'status',
              label: 'Status',
              type: 'select',
              required: true,
              options: ['SUBMITTED', 'QUOTED', 'ALTERNATIVE', 'NEGOTIATED', 'EXPIRING'],
            },
            {
              name: 'origin',
              label: 'Origin',
              type: 'select',
              required: true,
              options: ['BROKER', 'CEDANT', 'REINSURER'],
            },
            {
              name: 'origin_party_id',
              label: 'Reinsurer (REINSURER origin only)',
              type: 'select',
              options: reinsurers.map((m) => ({ value: m.id, label: m.name })),
            },
            {
              name: 'parent_version_id',
              label: 'Derived from',
              type: 'select',
              options: versions.map((v) => ({ value: v.id, label: `v${v.version_no} ${v.status}` })),
            },
            { name: 'terms', label: 'Terms (JSON)', required: true, type: 'textarea', rows: 8 },
          ]}
          onSubmit={async (v) => {
            await api('POST', `/structures/${structureId}/versions`, {
              status: v.status,
              origin: v.origin,
              origin_party_id: v.origin === 'REINSURER' ? v.origin_party_id || null : null,
              parent_version_id: v.parent_version_id || null,
              terms: parseJson(v.terms),
            });
            setAdding(false);
            detail.reload();
            onChange();
          }}
        />
      )}
    </Card>
  );
}

function showValue(v) {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
