import React, { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Card, useFetch, Form, StatusPill, TonePill, ErrorBanner, Pct, Tabs, Filter } from '../components.jsx';
import { useScreenHead } from '../shell.jsx';
import { useHasRole } from '../auth.jsx';

/**
 * The market register, split by counterparty type. Reinsurers carry the
 * business we have placed with them (lead and follow shares off the line
 * ledger); insurers are the cedant side; brokers are the intermediaries we
 * work alongside. Filters live in the URL so a filtered view can be shared.
 */
const TABS = [
  { value: 'reinsurer', label: 'Reinsurers' },
  { value: 'insurer', label: 'Insurers' },
  { value: 'broker', label: 'Brokers' },
];

const SORTS = [
  { value: 'name', label: 'Name' },
  { value: 'share', label: 'Total share' },
  { value: 'lead_share', label: 'Lead share' },
  { value: 'follow_share', label: 'Follow share' },
  { value: 'lines', label: 'Lines written' },
  { value: 'recent', label: 'Most recent' },
];

const NOUN = { reinsurer: 'reinsurer', insurer: 'insurer', broker: 'broker' };
const ARTICLE = { reinsurer: 'a', insurer: 'an', broker: 'a' };

export default function Markets() {
  const [params, setParams] = useSearchParams();
  const canEdit = useHasRole('broker', 'admin');

  const type = TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'reinsurer';
  const isReinsurer = type === 'reinsurer';
  useScreenHead('Counterparties', 'Market register', TABS.find((t) => t.value === type).label);

  // Only reinsurers hold lines, so the business filters are theirs alone.
  const filters = {
    q: params.get('q') || '',
    region: params.get('region') || '',
    country: params.get('country') || '',
    rating: params.get('rating') || '',
    security_status: params.get('security_status') || '',
    kyc_status: params.get('kyc_status') || '',
    has_business: isReinsurer ? params.get('has_business') || '' : '',
    role: isReinsurer ? params.get('role') || '' : '',
    min_share: isReinsurer ? params.get('min_share') || '' : '',
    sort: params.get('sort') || 'name',
  };

  const qs = useMemo(() => {
    const s = new URLSearchParams({ type, limit: '200' });
    for (const [k, v] of Object.entries(filters)) if (v !== '') s.set(k, v);
    return s.toString();
  }, [type, JSON.stringify(filters)]);

  const markets = useFetch('GET', `/markets?${qs}`, [qs]);
  const facets = useFetch('GET', `/markets/facets?type=${type}`, [type]);

  function setFilter(key, value) {
    const next = new URLSearchParams(params);
    if (value === '' || value == null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  }

  function setTab(value) {
    // Filters are per-tab; switching tabs starts clean rather than carrying a
    // region or rating that may not exist on the other side of the register.
    setParams(value === 'reinsurer' ? {} : { tab: value });
  }

  const activeFilters = Object.entries(filters).filter(([k, v]) => v !== '' && k !== 'sort');
  const rows = markets.data || [];

  return (
    <>
      <Tabs tabs={TABS} value={type} onChange={setTab} />

      <Card
        title={`${TABS.find((t) => t.value === type).label}${rows.length ? ` (${rows.length})` : ''}`}
        actions={activeFilters.length > 0 && (
          <button className="ghost small" onClick={() => setTab(type)}>
            Clear {activeFilters.length} filter{activeFilters.length > 1 ? 's' : ''}
          </button>
        )}
      >
        <div className="filters">
          <Filter label="Search" type="search" placeholder="Name or group" value={filters.q} onChange={(v) => setFilter('q', v)} />
          <Filter label="Region" value={filters.region} options={facets.data?.regions || []} onChange={(v) => setFilter('region', v)} />
          <Filter label="Country" value={filters.country} options={facets.data?.countries || []} onChange={(v) => setFilter('country', v)} />
          <Filter label="Rating" value={filters.rating} options={facets.data?.ratings || []} onChange={(v) => setFilter('rating', v)} />
          <Filter
            label="KYC"
            value={filters.kyc_status}
            options={['not_started', 'in_progress', 'approved', 'expired', 'rejected']}
            onChange={(v) => setFilter('kyc_status', v)}
          />
          <Filter
            label="Security"
            value={filters.security_status}
            options={['approved', 'watch', 'declined']}
            onChange={(v) => setFilter('security_status', v)}
          />
          {isReinsurer && (
            <>
              <Filter
                label="Relationship"
                placeholder="All markets"
                value={filters.has_business}
                options={[
                  { value: 'true', label: 'We have business with' },
                  { value: 'false', label: 'No business yet' },
                ]}
                onChange={(v) => setFilter('has_business', v)}
              />
              <Filter
                label="Acts as"
                placeholder="Lead or follow"
                value={filters.role}
                options={[{ value: 'lead', label: 'Lead' }, { value: 'follow', label: 'Follow' }]}
                onChange={(v) => setFilter('role', v)}
              />
              <Filter
                label="Min share %"
                type="number"
                placeholder="0"
                value={filters.min_share}
                onChange={(v) => setFilter('min_share', v)}
              />
            </>
          )}
          <Filter label="Sort by" placeholder="Name" value={filters.sort} options={SORTS} onChange={(v) => setFilter('sort', v)} />
        </div>

        <ErrorBanner error={markets.error} />
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Country</th><th>Region</th><th>Rating</th>
                <th>KYC</th><th>Security</th>
                {isReinsurer && <><th className="right">Lead</th><th className="right">Follow</th><th className="right">Total share</th><th className="right">Lines</th></>}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link to={`/markets/${m.id}`}>{m.name}</Link>
                    {m.group_name && <div className="muted small">{m.group_name}</div>}
                  </td>
                  <td>{m.domicile || '—'}</td>
                  <td>{m.region || '—'}</td>
                  <td>
                    {m.rating || '—'}
                    {m.rating_agency && <div className="muted small">{m.rating_agency}</div>}
                  </td>
                  <td><StatusPill value={m.kyc_status} /></td>
                  <td><StatusPill value={m.security_status} /></td>
                  {isReinsurer && (
                    <>
                      <td className="right">{m.business.lead_lines ? <Pct value={m.business.lead_share} /> : '—'}</td>
                      <td className="right">{m.business.follow_lines ? <Pct value={m.business.follow_share} /> : '—'}</td>
                      <td className="right">{m.business.has_business ? <Pct value={m.business.total_share} /> : '—'}</td>
                      <td className="right">{m.business.lines_count || '—'}</td>
                    </>
                  )}
                  <td><TonePill tone={m.compliance.overall}>{m.compliance.overall}</TonePill></td>
                </tr>
              ))}
              {rows.length === 0 && !markets.loading && (
                <tr>
                  <td colSpan={isReinsurer ? 11 : 7} className="muted">
                    No {NOUN[type]}s match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {canEdit && (
        <Card title={`Add ${ARTICLE[type]} ${NOUN[type]}`}>
          <Form
            submitLabel={`Add ${NOUN[type]}`}
            fields={[
              { name: 'name', label: 'Name', required: true },
              { name: 'group_name', label: 'Group' },
              { name: 'domicile', label: 'Country' },
              { name: 'region', label: 'Region' },
              { name: 'rating', label: 'Rating' },
              { name: 'rating_agency', label: 'Agency' },
              { name: 'security_status', label: 'Security', type: 'select', options: ['approved', 'watch', 'declined'] },
            ]}
            onSubmit={async (v) => {
              await api('POST', '/markets', { ...v, type });
              markets.reload();
              facets.reload();
            }}
          />
          <p className="muted small">
            Compliance (KYC and rating sign-off) and the group profile are set on the counterparty itself.
          </p>
        </Card>
      )}
    </>
  );
}
