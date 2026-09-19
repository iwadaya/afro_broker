import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Card, useFetch, StatusPill, ErrorBanner, SearchInput,
  Avatar, Person, ProgressBar, fmtCompact, fmtDate,
} from '../components.jsx';
import { api } from '../api.js';
import { useAuth, useHasRole } from '../auth.jsx';
import { useScreenHead } from '../shell.jsx';
import { ALL_YEARS, inTreatyYear, useTreatyYear, yearLabel } from '../treatyYear.js';
import {
  ACTIVE_STATUSES, ALL_STATUSES, lifecycleProgress, monthsBetween, progressTone,
} from '../lifecycle.js';

const PAGE_SIZE = 10;

/**
 * The placement book: find a placement, understand its stage and identify the
 * next action quickly.
 *
 * Query state (search, filters, page) lives in the URL so a filtered view is
 * linkable and survives a refresh, and the top bar's global search hands off
 * here through `?q=`. The search runs on the server — country, cedant,
 * treaty type, class of business, status and free text — as the modelling
 * tool's does; only the treaty-year lens is applied here.
 */

/** The server-side search, as the URL states it. */
function searchQuery(params) {
  const qs = new URLSearchParams({ limit: '200' });
  for (const key of ['q', 'status', 'country', 'cedant_id', 'treaty_type', 'class']) {
    const v = params.get(key);
    if (v) qs.set(key, v);
  }
  return `/placements?${qs.toString()}`;
}
export default function Placements() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const canEdit = useHasRole('broker', 'admin');
  const { user } = useAuth();
  const [year, setYear] = useTreatyYear();
  const [renewing, setRenewing] = useState(false);

  useScreenHead('Operations', 'Placements');

  const q = params.get('q') || '';
  const status = params.get('status') || '';
  const country = params.get('country') || '';
  const cedantId = params.get('cedant_id') || '';
  const treatyType = params.get('treaty_type') || '';
  const klass = params.get('class') || '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const query = searchQuery(params);
  const placements = useFetch('GET', query, [query]);
  const cedants = useFetch('GET', '/cedants?limit=200');
  // The book's countries, cedants, treaty types and classes — the filter options.
  const facets = useFetch('GET', '/placements/facets', []);

  // The typed value is local so it survives a background refresh; the URL
  // catches up after a short debounce.
  const [term, setTerm] = useState(q);
  useEffect(() => { setTerm(q); }, [q]);
  const debounce = useRef();
  useEffect(() => () => clearTimeout(debounce.current), []);

  function setParam(key, value) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  }

  function onSearch(value) {
    setTerm(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParam('q', value), 300);
  }

  function clearAll() {
    setParams(new URLSearchParams(), { replace: true });
    setTerm('');
  }

  const cedantById = useMemo(
    () => new Map((cedants.data || []).map((c) => [c.id, c])),
    [cedants.data],
  );
  const nameOf = (id) => cedantById.get(id)?.name || 'Unknown cedant';
  const cedantName = (p) => p.cedant_name || nameOf(p.cedant_id);

  // The server has searched; the treaty-year lens is the one filter kept here.
  const scoped = useMemo(
    () => (placements.data || []).filter((p) => inTreatyYear(p.inception, year)),
    [placements.data, year],
  );
  const filtered = scoped;

  const activeFilters = [status, country, cedantId, treatyType, klass].filter(Boolean).length + (q ? 1 : 0);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const summary = useMemo(() => summarise(scoped), [scoped]);
  const loading = placements.loading && !placements.data;

  return (
    <div className="screen">
      <div className="sechead">
        <div>
          <div className="kicker">Placement management</div>
          <p className="muted small" style={{ marginTop: 6 }}>
            Manage the complete placement book from submission to closing.
          </p>
        </div>
        <div className="sechead-actions">
          <Link className="btn btn-secondary" to="/markets">Register</Link>
          {canEdit && (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setRenewing(true)}>
                ⟳ Renew placement
              </button>
              <button type="button" className="btn btn-primary" onClick={() => navigate('/placements/new')}>
                + New placement
              </button>
            </>
          )}
        </div>
      </div>

      {renewing && canEdit && <RenewModal onClose={() => setRenewing(false)} />}

      <div className="summary">
        <SummaryCell label="Total placements" value={summary.total} note="in scope" loading={loading} />
        <SummaryCell label="Active" value={summary.active} note={share(summary.active, summary.total)} loading={loading} />
        <SummaryCell label="Quoted" value={summary.quoted} note="terms received" loading={loading} />
        <SummaryCell label="Bound" value={summary.bound} note="placed" loading={loading} />
        <SummaryCell
          label="Conversion"
          value={summary.conversion == null ? '—' : `${summary.conversion}%`}
          note="bound of closed"
          accent
          loading={loading}
        />
      </div>

      <Card title="All placements">
        <ErrorBanner error={placements.error} />
        <div className="filterbar">
          <div className="filterbar-search">
            <SearchInput
              value={term}
              onChange={onSearch}
              placeholder="Search by reference, cedant or class"
              label="Search placements by reference, cedant or class"
            />
          </div>
          <FilterSelect label="Country" value={country} onChange={(v) => setParam('country', v)}
            options={(facets.data?.countries || []).map((c) => ({ value: c.name, label: c.name }))} />
          <FilterSelect label="Cedant" value={cedantId} onChange={(v) => setParam('cedant_id', v)}
            options={(facets.data?.cedants || []).map((c) => ({ value: c.id, label: c.name }))} />
          <FilterSelect label="Treaty type" value={treatyType} onChange={(v) => setParam('treaty_type', v)}
            options={(facets.data?.treaty_types || []).map((t) => ({ value: t.name, label: t.name }))} />
          <FilterSelect label="Class" value={klass} onChange={(v) => setParam('class', v)}
            options={(facets.data?.classes || []).map((c) => ({ value: c.name, label: c.name }))} />
          <FilterSelect label="Status" value={status} onChange={(v) => setParam('status', v)}
            options={ALL_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase() }))} />
          <div className="filterbar-meta">
            <span className="muted small" aria-live="polite">
              {loading ? 'Loading…' : `${filtered.length} placement${filtered.length === 1 ? '' : 's'}`}
              {activeFilters > 0 && ` · ${activeFilters} filter${activeFilters === 1 ? '' : 's'}`}
            </span>
            {activeFilters > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={clearAll}>Clear all</button>
            )}
          </div>
        </div>

        {/* Wide content scrolls inside its own container so the page body
            never scrolls sideways. */}
        <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Cedant / Class</th>
              <th>Period</th>
              <th className="r">Premium 100%</th>
              <th>Stage</th>
              <th>Progress</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const months = monthsBetween(p.inception, p.expiry);
              return (
                <tr key={p.id}>
                  <td><Link to={`/placements/${p.id}`} className="reflink">{p.reference}</Link></td>
                  <td>
                    <span className="person">
                      <Avatar name={cedantName(p)} />
                      <span className="person-text">
                        <span className="person-name" title={cedantName(p)}>{cedantName(p)}</span>
                        <span style={{ display: 'block', marginTop: 4 }}>
                          <span className="classtag">{p.class}</span>
                          {p.renewal_of && (
                            <span className="person-meta" style={{ marginLeft: 6 }} title="Renews a placement in the book">
                              ⟳ renewal of {p.renewal_of_reference || 'prior year'}
                            </span>
                          )}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className="person-name" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDate(p.inception, { shortYear: true })}
                    </span>
                    <span className="person-meta">{months != null ? `${months} months` : '—'}</span>
                  </td>
                  <td className="r num">
                    {p.est_gwp ? `${p.currency} ${fmtCompact(p.est_gwp)}` : <span className="muted">—</span>}
                  </td>
                  <td><StatusPill value={p.status} /></td>
                  <td style={{ minWidth: 116 }}>
                    <ProgressBar
                      value={lifecycleProgress(p.status)}
                      tone={progressTone(p.status)}
                      label={`Lifecycle progress for ${p.reference}`}
                    />
                  </td>
                  <td><Person name={user?.name} tone="mint" size="sm" /></td>
                </tr>
              );
            })}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan="7">{renderEmpty()}</td>
              </tr>
            )}
          </tbody>
        </table>
        </div>

        {filtered.length > 0 && (
          <div className="tablefoot">
            <span>
              Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
            {pageCount > 1 && (
              <nav className="pageblock" aria-label="Pagination">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={safePage === 1}
                  onClick={() => setParam('page', String(safePage - 1))}
                  aria-label="Previous page"
                >‹</button>
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`btn btn-sm ${n === safePage ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setParam('page', String(n))}
                    aria-current={n === safePage ? 'page' : undefined}
                    aria-label={`Page ${n}`}
                  >{n}</button>
                ))}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={safePage === pageCount}
                  onClick={() => setParam('page', String(safePage + 1))}
                  aria-label="Next page"
                >›</button>
              </nav>
            )}
          </div>
        )}
      </Card>
    </div>
  );

  function renderEmpty() {
    if (activeFilters > 0) {
      return (
        <div className="emptystate">
          <div className="emptystate-title">No placements match these filters</div>
          <div>{q ? `Nothing matches “${q}”.` : 'No placement matches the selected filters.'}</div>
          <div className="emptystate-action">
            <button type="button" className="btn btn-secondary btn-sm" onClick={clearAll}>Clear all filters</button>
          </div>
        </div>
      );
    }
    if (year !== ALL_YEARS && (placements.data || []).length > 0) {
      return (
        <div className="emptystate">
          <div className="emptystate-title">Nothing incepting {yearLabel(year)}</div>
          <div>The book has placements in other treaty years.</div>
          <div className="emptystate-action">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setYear(ALL_YEARS)}>
              Show all treaty years
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="emptystate">
        <div className="emptystate-title">No placements yet</div>
        <div>Placements you create appear here from submission through to closing.</div>
      </div>
    );
  }
}

/**
 * Renew Placement — the modelling tool's Renew Treaty wizard, adapted to the
 * placement register: pick country → cedant → treaty type → class →
 * placement, each step served by the register's search so the lists narrow
 * as they cascade, then continue into the new placement page in renewal
 * mode, which auto-populates the treaty detail and expiring structure from —
 * and links the new draft back to — the expiring placement, so the two years
 * compare side by side.
 */
function RenewModal({ onClose }) {
  const navigate = useNavigate();
  const [country, setCountry] = useState('');
  const [cedantId, setCedantId] = useState('');
  const [treatyType, setTreatyType] = useState('');
  const [klass, setKlass] = useState('');
  const [placementId, setPlacementId] = useState('');
  const [facets, setFacets] = useState(null);
  const [candidates, setCandidates] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The options at every level follow the picks above it.
  const qs = (withKeys) => {
    const p = new URLSearchParams();
    if (withKeys.includes('country') && country) p.set('country', country);
    if (withKeys.includes('cedant_id') && cedantId) p.set('cedant_id', cedantId);
    if (withKeys.includes('treaty_type') && treatyType) p.set('treaty_type', treatyType);
    if (withKeys.includes('class') && klass) p.set('class', klass);
    return p.toString();
  };
  useEffect(() => {
    let alive = true;
    api('GET', `/placements/facets?${qs(['country', 'cedant_id', 'treaty_type', 'class'])}`)
      .then((f) => { if (alive) setFacets(f); })
      .catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, cedantId, treatyType, klass]);
  useEffect(() => {
    if (!cedantId) { setCandidates(null); return undefined; }
    let alive = true;
    api('GET', `/placements?limit=200&${qs(['country', 'cedant_id', 'treaty_type', 'class'])}`)
      .then((rows) => { if (alive) setCandidates(rows.sort((a, b) => String(b.inception).localeCompare(String(a.inception)))); })
      .catch((e) => { if (alive) setError(e); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, cedantId, treatyType, klass]);

  const countries = facets?.countries || [];
  const cedants = facets?.cedants || [];
  const treatyTypes = facets?.treaty_types || [];
  const classes = facets?.classes || [];
  const steps = [
    ['Country', !!country], ['Cedant', !!cedantId], ['Treaty type', !!treatyType || !!placementId],
    ['Class', !!klass || !!placementId], ['Placement', !!placementId],
  ];
  const firstOpen = steps.findIndex(([, done]) => !done);

  return (
    <div className="renew-modal">
      <div className="renew-backdrop" role="presentation" onClick={onClose} />
      <div className="renew-panel" role="dialog" aria-modal="true" aria-label="Renew placement">
        <div className="renew-head">
          <div>
            <div className="renew-kicker">RENEWAL WIZARD</div>
            <div className="renew-title">Renew Placement</div>
          </div>
          <button type="button" className="renew-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="renew-steps">
          {steps.map(([label, done], i) => (
            <div key={label} className={`renew-step ${done ? 'done' : i === firstOpen ? 'active' : ''}`}><span className="dot" /><span>{label}</span></div>
          ))}
        </div>
        <div className="renew-body">
          <ErrorBanner error={error} />
          <div className="renew-field">
            <label className="renew-label" htmlFor="renew-country">1) Select Country</label>
            <select
              id="renew-country" className="input" value={country}
              onChange={(e) => { setCountry(e.target.value); setCedantId(''); setTreatyType(''); setKlass(''); setPlacementId(''); }}
            >
              <option value="">{facets ? 'Select country…' : 'Loading…'}</option>
              {countries.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
            </select>
          </div>
          <div className="renew-field">
            <label className="renew-label" htmlFor="renew-cedant">2) Select Cedant</label>
            <select
              id="renew-cedant" className="input" value={cedantId} disabled={!country}
              onChange={(e) => { setCedantId(e.target.value); setTreatyType(''); setKlass(''); setPlacementId(''); }}
            >
              <option value="">{country ? 'Select cedant…' : 'Select country first…'}</option>
              {cedants.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}
            </select>
          </div>
          <div className="renew-field">
            <label className="renew-label" htmlFor="renew-treaty-type">3) Select Treaty Type</label>
            <select
              id="renew-treaty-type" className="input" value={treatyType} disabled={!cedantId}
              onChange={(e) => { setTreatyType(e.target.value); setKlass(''); setPlacementId(''); }}
            >
              <option value="">{cedantId ? 'Any treaty type' : 'Select cedant first…'}</option>
              {treatyTypes.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
            </select>
          </div>
          <div className="renew-field">
            <label className="renew-label" htmlFor="renew-class">4) Select Class of Business</label>
            <select
              id="renew-class" className="input" value={klass} disabled={!cedantId}
              onChange={(e) => { setKlass(e.target.value); setPlacementId(''); }}
            >
              <option value="">{cedantId ? 'Any class' : 'Select cedant first…'}</option>
              {classes.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
            </select>
          </div>
          <div className="renew-field">
            <label className="renew-label" htmlFor="renew-placement">5) Select Placement</label>
            <select
              id="renew-placement" className="input" value={placementId} disabled={!cedantId}
              onChange={(e) => setPlacementId(e.target.value)}
            >
              <option value="">
                {!cedantId ? 'Select cedant first…'
                  : !candidates ? 'Loading…'
                    : candidates.length ? 'Select placement to renew…' : 'No placements match'}
              </option>
              {(candidates || []).map((p) => (
                <option key={p.id} value={p.id}>
                  {String(p.inception).slice(0, 4)} · {p.reference} · {p.treaty_type || '—'} · {p.class_of_business || p.class} · {p.status.replace(/_/g, ' ').toLowerCase()}{p.renewed_by_count ? ' · already renewed' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="renew-note">
            <div className="renew-note-title">What happens next?</div>
            <div className="renew-note-text">
              The new placement opens with the treaty detail and expiring structure
              auto-populated from this placement. Creating it makes a new <b>DRAFT</b> linked
              back to the expiring year — the link shows on both years — so the renewal and
              the expiring terms compare in real time. Market data, quotes and lines start fresh.
            </div>
          </div>
          <div className="renew-actions">
            <button type="button" className="renew-btn renew-btn--ghost" onClick={onClose}>Cancel</button>
            <button
              type="button" className="renew-btn renew-btn--primary" disabled={!placementId}
              onClick={() => navigate(`/placements/new?source=${placementId}`)}
            >
              Continue to Renewal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCell({ label, value, note, accent = false, loading }) {
  return (
    <div className="summary-cell">
      <div className="summary-label">{label}</div>
      <div className={`summary-value${accent ? ' accent' : ''}`}>
        {loading ? '—' : value}
        {note && !loading && <span className="summary-note">{note}</span>}
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <>
      <span className="sr-only" id={`filter-${label}`}>{label}</span>
      <select
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-labelledby={`filter-${label}`}
      >
        <option value="">{label}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </>
  );
}

function summarise(rows) {
  const total = rows.length;
  const active = rows.filter((p) => ACTIVE_STATUSES.includes(p.status)).length;
  const quoted = rows.filter((p) => ['QUOTED', 'FOT_AGREED'].includes(p.status)).length;
  const bound = rows.filter((p) => p.status === 'BOUND').length;
  const closed = rows.filter((p) => ['BOUND', 'DECLINED', 'NTU', 'LAPSED'].includes(p.status)).length;
  return { total, active, quoted, bound, conversion: closed ? Math.round((bound / closed) * 100) : null };
}

function share(part, whole) {
  return whole ? `${Math.round((part / whole) * 100)}%` : 'none';
}
