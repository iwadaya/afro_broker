import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Card, useFetch, Form, ErrorBanner } from '../components.jsx';
import { useScreenHead } from '../shell.jsx';
import { useHasRole } from '../auth.jsx';

/**
 * Contracts — the treaty programmes a cedant renews each year (§1.1).
 *
 * A contract is the programme ("Property Surplus"); a contract year is one
 * renewal of it. Renewing links the new year to the expiring one rather than
 * copying it forward, and that link is what lets the expiring year be read
 * alongside the one being placed.
 */
export default function Contracts() {
  const contracts = useFetch('GET', '/contracts?limit=200');
  const cedants = useFetch('GET', '/cedants?limit=200');
  const canEdit = useHasRole('broker', 'admin');
  const [open, setOpen] = useState(null);
  useScreenHead('Placements', 'Contracts');

  return (
    <>
      <Card title="Treaty programmes">
        {canEdit && (
          <Form
            submitLabel="Add contract"
            fields={[
              {
                name: 'cedant_id',
                label: 'Cedant',
                type: 'select',
                required: true,
                options: (cedants.data || []).map((c) => ({ value: c.id, label: c.name })),
              },
              { name: 'name', label: 'Programme', required: true, placeholder: 'Property Surplus' },
              { name: 'cob', label: 'Class of business', required: true, placeholder: 'Property' },
              { name: 'territory', label: 'Territory' },
            ]}
            onSubmit={async (v) => {
              await api('POST', '/contracts', {
                cedant_id: v.cedant_id,
                name: v.name,
                cob: v.cob,
                territory: v.territory || undefined,
              });
              contracts.reload();
            }}
          />
        )}
        <ErrorBanner error={contracts.error} />
        <table>
          <thead>
            <tr><th>Cedant</th><th>Programme</th><th>Class</th><th>Territory</th><th>Years</th><th /></tr>
          </thead>
          <tbody>
            {contracts.data?.map((c) => (
              <tr key={c.id}>
                <td>{c.cedant_name}</td>
                <td><strong>{c.name}</strong></td>
                <td>{c.cob}</td>
                <td>{c.territory || '—'}</td>
                <td>{c.year_count}</td>
                <td>
                  <button className="small ghost" onClick={() => setOpen(open === c.id ? null : c.id)}>
                    {open === c.id ? 'Close' : 'Open'}
                  </button>
                </td>
              </tr>
            ))}
            {contracts.data?.length === 0 && (
              <tr><td colSpan="6" className="muted">No contracts yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {open && <ContractDetail id={open} canEdit={canEdit} onChange={contracts.reload} />}
    </>
  );
}

function ContractDetail({ id, canEdit, onChange }) {
  const detail = useFetch('GET', `/contracts/${id}`, [id]);
  const navigate = useNavigate();
  const [chainOf, setChainOf] = useState(null);
  const [structuresOf, setStructuresOf] = useState(null);

  if (detail.loading) return <p className="muted">Loading…</p>;
  if (detail.error) return <ErrorBanner error={detail.error} />;
  const c = detail.data;
  const reload = () => { detail.reload(); onChange?.(); };

  return (
    <Card title={`${c.cedant_name} — ${c.name}`}>
      {canEdit && (
        <Form
          submitLabel="Add year"
          fields={[
            { name: 'year_label', label: 'Year', required: true, placeholder: '2026' },
            { name: 'inception', label: 'Inception', type: 'date', required: true },
            { name: 'expiry', label: 'Expiry', type: 'date', required: true },
            { name: 'currency', label: 'Currency', required: true, placeholder: 'USD' },
          ]}
          onSubmit={async (v) => {
            await api('POST', `/contracts/${id}/years`, {
              year_label: v.year_label,
              inception: v.inception,
              expiry: v.expiry,
              currency: v.currency,
            });
            reload();
          }}
        />
      )}

      <table>
        <thead>
          <tr><th>Year</th><th>Inception</th><th>Expiry</th><th>Ccy</th><th>Renews from</th><th>Placement</th><th /></tr>
        </thead>
        <tbody>
          {c.years.map((y) => (
            <tr key={y.id}>
              <td><strong>{y.year_label}</strong></td>
              <td>{String(y.inception).slice(0, 10)}</td>
              <td>{String(y.expiry).slice(0, 10)}</td>
              <td>{y.currency}</td>
              <td className="muted">
                {y.prior_contract_year_id
                  ? c.years.find((p) => p.id === y.prior_contract_year_id)?.year_label || 'linked'
                  : '—'}
              </td>
              <td className="muted">{y.placement_reference || '—'}</td>
              <td>
                <button className="small" onClick={() => navigate(`/contract-years/${y.id}`)}>
                  Workspace
                </button>
                <button className="small ghost" onClick={() => setChainOf(chainOf === y.id ? null : y.id)}>
                  Chain
                </button>
                <button className="small ghost" onClick={() => setStructuresOf(structuresOf === y.id ? null : y.id)}>
                  Structures
                </button>
                {canEdit && <RenewButton year={y} onDone={reload} />}
              </td>
            </tr>
          ))}
          {c.years.length === 0 && <tr><td colSpan="7" className="muted">No years yet.</td></tr>}
        </tbody>
      </table>

      {chainOf && <Chain id={chainOf} />}
      {structuresOf && <Structures yearId={structuresOf} canEdit={canEdit} />}
    </Card>
  );
}

function RenewButton({ year, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function renew() {
    const next = Number(year.year_label);
    const label = window.prompt(
      `Renew ${year.year_label} into which year?`,
      Number.isFinite(next) ? String(next + 1) : '',
    );
    if (!label) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/contract-years/${year.id}/renew`, { year_label: label });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="small" disabled={busy} onClick={renew}>{busy ? '…' : 'Renew'}</button>
      <ErrorBanner error={error} />
    </>
  );
}

/** The renewal chain — the link the expiring year is read through. */
function Chain({ id }) {
  const chain = useFetch('GET', `/contract-years/${id}/chain`, [id]);
  if (chain.loading) return <p className="muted">Loading chain…</p>;
  if (chain.error) return <ErrorBanner error={chain.error} />;
  return (
    <p className="muted">
      Renewal chain:{' '}
      {chain.data.chain.map((y, i) => (
        <span key={y.id}>
          {i > 0 && ' → '}
          {y.is_current ? <strong>{y.year_label}</strong> : y.year_label}
        </span>
      ))}
    </p>
  );
}

/**
 * §1.2 / M5 — the structures on a year, with the expiring ones alongside.
 *
 * The expiring column is read through `prior_contract_year_id`, not copied
 * forward: that link is what §1.1 buys, and a copy would let the two drift.
 */
function Structures({ yearId, canEdit }) {
  const view = useFetch('GET', `/contract-years/${yearId}/structures?include_expiring=1`, [yearId]);
  const schemas = useFetch('GET', '/term-schemas');
  const [adding, setAdding] = useState(false);

  if (view.loading) return <p className="muted">Loading structures…</p>;
  if (view.error) return <ErrorBanner error={view.error} />;

  const expiring = view.data.expiring;
  const expiringFor = (label) =>
    expiring?.structures?.find((e) => e.label === label)?.latest_version ?? null;

  return (
    <div>
      <h4>Structures</h4>
      {/* One banner per warning: `.warn.banner` lays its children out in a
          row, so stacking messages inside a single banner would run them
          together. */}
      {view.data.warnings?.map((w) => (
        <div className="warn banner" key={w.structures.join('-')}>{w.message}</div>
      ))}

      {expiring?.source === 'UNLINKED' && (
        <p className="muted">
          No linked prior year, so there is nothing to show as expiring. Link the renewal
          chain, or enter the expiring structure on this year.
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>Structure</th><th>Basis</th><th>Treaty type</th>
            <th>Current terms</th><th>Expiring</th><th>Versions</th>
          </tr>
        </thead>
        <tbody>
          {view.data.structures.map((s) => {
            const now = s.latest_version;
            const was = expiringFor(s.label);
            return (
              <tr key={s.id}>
                <td><strong>{s.label}</strong></td>
                <td>{s.basis}</td>
                <td className="muted">{s.treaty_type}</td>
                <td>{summariseTerms(s.basis, now)}</td>
                <td className="muted">{was ? summariseTerms(s.basis, was) : '—'}</td>
                <td>{s.version_count}{now ? ` · ${now.status}` : ''}</td>
              </tr>
            );
          })}
          {view.data.structures.length === 0 && (
            <tr><td colSpan="6" className="muted">No structures on this year yet.</td></tr>
          )}

          {/* Expiring structures with no counterpart being quoted this year. */}
          {expiring?.structures
            ?.filter((e) => !view.data.structures.some((s) => s.label === e.label))
            .map((e) => (
              <tr key={`expiring-${e.id}`} className="muted">
                <td>{e.label}</td>
                <td>{e.basis}</td>
                <td>{e.treaty_type}</td>
                <td>— not being quoted —</td>
                <td>{summariseTerms(e.basis, e.latest_version)}</td>
                <td>expiring only</td>
              </tr>
            ))}
        </tbody>
      </table>

      {canEdit && (
        <>
          <button className="small ghost" onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add structure'}
          </button>
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
                    value: t.treaty_type,
                    label: `${t.treaty_type} (${t.basis})`,
                  })),
                },
                { name: 'cob', label: 'Class of business', required: true, placeholder: 'Property' },
                { name: 'currency', label: 'Currency', required: true, placeholder: 'USD' },
                { name: 'terms', label: 'Terms (JSON)', required: true, placeholder: '{"deductible":"5000000", …}' },
              ]}
              onSubmit={async (v) => {
                let terms;
                try {
                  terms = JSON.parse(v.terms);
                } catch {
                  throw new Error('Terms must be valid JSON');
                }
                await api('POST', `/contract-years/${yearId}/structures`, {
                  label: v.label,
                  treaty_type: v.treaty_type,
                  cob: v.cob,
                  terms: { ...terms, currency: v.currency },
                });
                setAdding(false);
                view.reload();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * A one-line read of what a structure currently says, in the terms that matter
 * for its basis. Amounts come back from the API as decimal strings alongside
 * the stored minor units, so nothing is re-derived in the browser.
 */
function summariseTerms(basis, version) {
  if (!version) return '—';
  const t = version.terms_display || version.terms || {};
  const ccy = t.currency || '';
  if (basis === 'NP') {
    const parts = [`${ccy} ${t.limit ?? '?'} xs ${t.deductible ?? '?'}`];
    if (t.rate_pct != null) parts.push(`@ ${t.rate_pct}%`);
    return parts.join(' ');
  }
  const cession = t.lines_ceded != null ? `${t.lines_ceded} lines` : `${t.cession_pct ?? '?'}%`;
  const parts = [cession];
  if (t.retention != null) parts.push(`retention ${ccy} ${t.retention}`);
  if (t.commission_pct != null) parts.push(`comm ${t.commission_pct}%`);
  else if (t.sliding_scale) parts.push('sliding scale');
  return parts.join(' · ');
}
