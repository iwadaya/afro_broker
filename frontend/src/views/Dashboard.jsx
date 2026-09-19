import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  useFetch, Blueprint, SectionLabel, StatusPill, ErrorBanner,
  fmtCompact, fmtDate, fmtMoney,
} from '../components.jsx';
import { useScreenHead } from '../shell.jsx';
import { useAuth } from '../auth.jsx';
import { parseClass } from './treatyDetail.jsx';
import { countryOfDomicile, regionOfDomicile } from '../refData.js';

/**
 * "USD 1.2m · EUR 300k" — the book holds no FX rates, so a cross-currency
 * headline always shows what it is made of rather than passing itself off as
 * a single figure.
 */
function currencyNote(money, empty = 'nothing recorded') {
  const entries = Object.entries(money?.by_currency || {});
  if (!entries.length) return empty;
  if (entries.length === 1) return `${entries[0][0]} ${fmtCompact(entries[0][1])}`;
  return `mixed — ${entries.map(([ccy, amt]) => `${ccy} ${fmtCompact(amt)}`).join(' · ')}`;
}

export default function Dashboard() {
  useScreenHead('Book overview', 'Treaty renewal book');
  const navigate = useNavigate();
  const { user } = useAuth();

  const metrics = useFetch('GET', '/dashboards/metrics');
  const calendar = useFetch('GET', '/dashboards/renewal-calendar?days=225');
  const packs = useFetch('GET', '/packs/by-cedant');
  const spine = useFetch('GET', '/dashboards/spine');
  const brokerage = useFetch('GET', '/dashboards/brokerage');

  const bk = brokerage.data?.by_currency || {};
  const bkMoney = { by_currency: Object.fromEntries(Object.entries(bk).map(([c, b]) => [c, b.brokerage])) };
  const bkTotal = Object.values(bk).reduce((a, b) => a + b.brokerage, 0);

  const m = metrics.data;

  // Open a renewal: the contract, on its basis page (proportional treaty
  // detail or non-proportional contract details).
  function openContract(row) {
    navigate(`/contracts/${row.id}`);
  }

  return (
    <div className="screen">
      <ErrorBanner error={metrics.error || calendar.error || packs.error} />

      {/* Welcome hero — the hub. The workspace's destinations sit under the
          welcome as two rows of four pills. */}
      <section className="hero">
        <div className="welcome-row">
          <span className="welcome-pill">WELCOME</span>
          <h1 className="welcome-title">{user?.name || 'Broker'}</h1>
        </div>
        <div className="welcome-sub">
          This is your placement workspace hub. Build or upload the renewal pack, take placements
          to market and drive layers through firm order, signing and binding.
        </div>
        <Launcher />
      </section>

      <div className="kpis">
        <Kpi label="Quoted premium" value={m ? fmtCompact(m.quoted_premium.total) : '—'}
          sub={m ? (m.quotes_without_premium
            ? `${m.quotes_without_premium} of ${m.quotes_total} live quotes priced on rate only`
            : currencyNote(m.quoted_premium, 'no live quotes')) : ''} />
        <Kpi label="Lead quotes" value={m ? String(m.lead_quotes) : '—'}
          sub={m ? `${m.quotes_total} live quotes, ${m.follow_quotes} on follow` : ''} />
        <Kpi label="Lead markets won" value={m ? String(m.lead_markets_won) : '—'}
          sub={m ? `${m.lead_markets_won_distinct} distinct ${m.lead_markets_won_distinct === 1 ? 'market' : 'markets'}` : ''} />
        <Kpi label="Follow markets won" value={m ? String(m.follow_markets_won) : '—'}
          sub={m ? `${m.follow_markets_won_distinct} distinct ${m.follow_markets_won_distinct === 1 ? 'market' : 'markets'}` : ''} />
        <Kpi label="Cedants" value={m ? String(m.cedants) : '—'}
          sub={m ? `${m.cedants_with_placements} with a placement` : ''} />
        <Kpi label="Total premium seen" value={m ? fmtCompact(m.total_premium_seen.total) : '—'}
          sub={m ? currencyNote(m.total_premium_seen, 'no premium recorded') : ''} />
        <Kpi label="Total premium placed" value={m ? fmtCompact(m.total_premium_placed.total) : '—'}
          sub={m ? (m.placed_ratio_pct != null ? `${m.placed_ratio_pct}% of premium seen` : currencyNote(m.total_premium_placed, 'nothing placed yet')) : ''} />
        <Kpi label="Brokerage earned" value={brokerage.data ? fmtCompact(bkTotal) : '—'}
          sub={brokerage.data ? currencyNote(bkMoney, 'accrues once layers are signed') : ''} />
      </div>

      <SpineOverview spine={spine} />

      {/* The store, shelved into a 2×2 grid: drafts, completed, approved and
          the renewal calendar. */}
      <div className="dash-quad">
        <PackStore
          packs={packs}
          bucket="draft"
          title="Renewal packs by cedant — Drafts"
          hint="with the broker, not yet submitted"
          emptyText="No draft packs in the store."
        />
        <PackStore
          packs={packs}
          bucket="completed"
          title="Renewal packs by cedant — Awaiting approval"
          hint="submitted, for a Senior Broker to approve"
          emptyText="No packs awaiting approval."
        />
        <PackStore
          packs={packs}
          bucket="approved"
          title="Approved renewal packs"
          hint="approved by a Senior Broker — cleared for market"
          emptyText="No approved packs yet."
        />
        <CalendarStore calendar={calendar} onOpen={openContract} />
      </div>

    </div>
  );
}

/**
 * One shelf of the renewal-pack store: every version held for every cedant,
 * flattened to a newest-first table that reads cedant, class of business and
 * treaty type at a glance, five rows a page. Filterable by cedant, country
 * and region — the country is the register domicile, the region the
 * placement-territory grouping in refData. Versions are never replaced — a
 * restatement is a new version — and any row can be opened to what it holds.
 */
const PACK_PAGE_SIZE = 5;

/** Which shelf a version sits on: draft (with the broker), completed
    (submitted, awaiting the Senior Broker's approval) or approved. */
function packBucket(pk) {
  const status = String(pk.status).toLowerCase();
  if (status === 'approved') return 'approved';
  return status === 'submitted' ? 'completed' : 'draft';
}

function PackStore({ packs, bucket, title, hint, emptyText }) {
  const [cedantFilter, setCedantFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);

  const all = packs.data?.cedants || [];

  // One row per stored version on this shelf, with its cedant + placement.
  const rows = useMemo(() => {
    const out = [];
    for (const c of all) {
      const country = countryOfDomicile(c.domicile)?.name || c.domicile || null;
      const region = regionOfDomicile(c.domicile);
      for (const p of c.placements) {
        const { cobs, treatyType } = parseClass(p.class);
        for (const pk of p.packs) {
          if (packBucket(pk) !== bucket) continue;
          out.push({
            cedant: c,
            country,
            region,
            placement: p,
            cob: cobs.join(' / ') || p.class || '—',
            treatyType,
            pack: pk,
          });
        }
      }
    }
    return out.sort((a, b) => (a.pack.created_at < b.pack.created_at ? 1 : -1));
  }, [all, bucket]);

  const cedantOptions = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const cur = m.get(r.cedant.cedant_id) || { name: r.cedant.cedant_name, n: 0 };
      cur.n += 1;
      m.set(r.cedant.cedant_id, cur);
    }
    return [...m.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);
  const countries = useMemo(
    () => [...new Set(rows.map((r) => r.country).filter(Boolean))].sort(),
    [rows],
  );
  const regions = useMemo(
    () => [...new Set(rows.map((r) => r.region).filter(Boolean))].sort(),
    [rows],
  );

  const filtered = rows.filter((r) => (
    (!cedantFilter || r.cedant.cedant_id === cedantFilter)
    && (!countryFilter || r.country === countryFilter)
    && (!regionFilter || r.region === regionFilter)
  ));

  const pageCount = Math.max(1, Math.ceil(filtered.length / PACK_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * PACK_PAGE_SIZE, safePage * PACK_PAGE_SIZE);

  const onFilter = (setter) => (e) => { setter(e.target.value); setPage(1); };

  return (
    <section>
      <div className="sechead">
        <SectionLabel>{title}</SectionLabel>
        <span className="hint">{hint}</span>
      </div>

      <Blueprint className="packstore" style={{ marginTop: 10 }}>
        {!packs.data && <div className="muted small">Loading…</div>}
        {packs.data && rows.length === 0 && (
          <div className="muted small">{emptyText}</div>
        )}

        {packs.data && rows.length > 0 && (
          <>
            <div className="filterbar">
              <select className="input" value={cedantFilter} onChange={onFilter(setCedantFilter)} aria-label="Filter by cedant">
                <option value="">All cedants</option>
                {cedantOptions.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.n})</option>
                ))}
              </select>
              <select className="input" value={countryFilter} onChange={onFilter(setCountryFilter)} aria-label="Filter by country">
                <option value="">All countries</option>
                {countries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="input" value={regionFilter} onChange={onFilter(setRegionFilter)} aria-label="Filter by region">
                <option value="">All regions</option>
                {regions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="cell-cedant">Cedant</th><th>Class</th><th>Treaty type</th>
                    <th>Ver</th><th>State</th><th>Built</th><th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.pack.id}>
                      <td className="cell-cedant" title={`${r.cedant.cedant_name} — ${r.placement.reference}${r.country ? ` · ${r.country}` : ''}`}>
                        <span className="person-name">{r.cedant.cedant_name}</span>
                        <span className="person-meta">
                          <span className="mono">{r.placement.reference}</span>
                          {r.country ? ` · ${r.country}` : ''}
                        </span>
                      </td>
                      <td>{r.cob}</td>
                      <td>{r.treatyType ? <span className="classtag">{r.treatyType}</span> : <span className="muted">—</span>}</td>
                      <td className="mono">v{r.pack.version}</td>
                      <td><StatusPill value={r.pack.status} /></td>
                      <td className="mono" style={{ fontSize: 12.5 }}>
                        {fmtDate(r.pack.created_at, { shortYear: true })}
                      </td>
                      <td className="r">
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setOpen(open === r.pack.id ? null : r.pack.id)}
                        >
                          {open === r.pack.id ? 'Close' : 'Open'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan="7" className="muted">No packs match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {visible.some((r) => r.pack.id === open) && <PackVersion id={open} />}

            <TableFoot
              page={safePage}
              pageCount={pageCount}
              total={filtered.length}
              noun="version"
              onPage={setPage}
              label="Renewal pack pagination"
            />
          </>
        )}
      </Blueprint>
    </section>
  );
}

/**
 * The foot of a shelf: what is showing, and the pager. Always rendered — a
 * single page shows "1" with the arrows disabled — so the four blocks of the
 * grid keep one shape whatever they hold.
 */
function TableFoot({ page, pageCount, total, noun, onPage, label }) {
  const from = total ? (page - 1) * PACK_PAGE_SIZE + 1 : 0;
  const to = Math.min(page * PACK_PAGE_SIZE, total);
  return (
    <div className="tablefoot">
      <span>
        {total
          ? `Showing ${from}–${to} of ${total} ${total === 1 ? noun : `${noun}s`}`
          : `No ${noun}s to show`}
      </span>
      <nav className="pageblock" aria-label={label}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >‹</button>
        {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            className={`btn btn-sm ${n === page ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => onPage(n)}
            aria-current={n === page ? 'page' : undefined}
            aria-label={`Page ${n}`}
          >{n}</button>
        ))}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >›</button>
      </nav>
    </div>
  );
}

/**
 * The renewal-calendar shelf: every placement renewing in the window, in
 * the same shape as the pack stores beside it — the same filters, five rows
 * a page, the same foot — so the four blocks of the grid read as one set.
 * The country is the cedant's register domicile, the region its
 * placement-territory grouping in refData, as on the pack shelves.
 */
function CalendarStore({ calendar, onOpen }) {
  const [cedantFilter, setCedantFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState('');
  const [page, setPage] = useState(1);

  const rows = useMemo(() => (calendar.data?.renewals || []).map((r) => {
    const { cobs, treatyType } = parseClass(r.class);
    return {
      ...r,
      country: countryOfDomicile(r.cedant_country)?.name || r.cedant_country || null,
      region: regionOfDomicile(r.cedant_country),
      cob: cobs.join(' / ') || r.class || '—',
      treatyType,
    };
  }), [calendar.data]);

  const cedantOptions = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const cur = m.get(r.cedant_name) || { name: r.cedant_name, n: 0 };
      cur.n += 1;
      m.set(r.cedant_name, cur);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);
  const countries = useMemo(
    () => [...new Set(rows.map((r) => r.country).filter(Boolean))].sort(),
    [rows],
  );
  const regions = useMemo(
    () => [...new Set(rows.map((r) => r.region).filter(Boolean))].sort(),
    [rows],
  );

  const filtered = rows.filter((r) => (
    (!cedantFilter || r.cedant_name === cedantFilter)
    && (!countryFilter || r.country === countryFilter)
    && (!regionFilter || r.region === regionFilter)
  ));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PACK_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * PACK_PAGE_SIZE, safePage * PACK_PAGE_SIZE);
  const onFilter = (setter) => (e) => { setter(e.target.value); setPage(1); };

  return (
    <section>
      <div className="sechead">
        <SectionLabel>Renewal calendar — next {calendar.data?.window_days ?? 225} days</SectionLabel>
        <span className="hint">open a row to work the contract</span>
      </div>

      <Blueprint className="packstore" style={{ marginTop: 10 }}>
        {!calendar.data && !calendar.error && <div className="muted small">Loading…</div>}
        {calendar.data && rows.length === 0 && (
          <div className="muted small">Nothing renewing in the window.</div>
        )}

        {calendar.data && rows.length > 0 && (
          <>
            <div className="filterbar">
              <select className="input" value={cedantFilter} onChange={onFilter(setCedantFilter)} aria-label="Filter by cedant">
                <option value="">All cedants</option>
                {cedantOptions.map((c) => (
                  <option key={c.name} value={c.name}>{c.name} ({c.n})</option>
                ))}
              </select>
              <select className="input" value={countryFilter} onChange={onFilter(setCountryFilter)} aria-label="Filter by country">
                <option value="">All countries</option>
                {countries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="input" value={regionFilter} onChange={onFilter(setRegionFilter)} aria-label="Filter by region">
                <option value="">All regions</option>
                {regions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="cell-cedant">Cedant</th><th>Class</th><th>Treaty type</th>
                    <th className="r">Est. GWP</th><th>Renews</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id}>
                      <td className="cell-cedant" title={`${r.cedant_name} — ${r.reference}${r.country ? ` · ${r.country}` : ''}`}>
                        <span className="person-name">{r.cedant_name}</span>
                        <span className="person-meta">
                          <span className="mono">{r.reference}</span>
                          {r.country ? ` · ${r.country}` : ''}
                        </span>
                      </td>
                      <td>{r.cob}</td>
                      <td>{r.treatyType ? <span className="classtag">{r.treatyType}</span> : <span className="muted">—</span>}</td>
                      <td className="r">{r.est_gwp != null ? fmtCompact(r.est_gwp) : '—'}</td>
                      <td className="mono" style={{ fontSize: 12.5 }}>
                        {fmtDate(r.renews_on, { shortYear: true })}
                      </td>
                      <td><StatusPill value={r.status} /></td>
                      <td className="r">
                        <button className="btn btn-secondary btn-sm" onClick={() => onOpen(r)}>Open</button>
                      </td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan="7" className="muted">No placements match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <TableFoot
              page={safePage}
              pageCount={pageCount}
              total={filtered.length}
              noun="placement"
              onPage={setPage}
              label="Renewal calendar pagination"
            />
          </>
        )}
      </Blueprint>
    </section>
  );
}

/** One stored version, opened: what it holds and the bordereaux behind it. */
function PackVersion({ id }) {
  const pack = useFetch('GET', `/packs/${id}`, [id]);
  const p = pack.data;
  if (pack.error) return <ErrorBanner error={pack.error} />;
  if (!p) return <div className="muted small" style={{ padding: 12 }}>Loading version…</div>;

  const snap = p.snapshot || {};
  const bdx = snap.bordereaux || [];
  const attachments = p.attachments || [];
  const extra = p.extra || {};

  return (
    <div className="packversion">
      <div className="packversion-head">
        <span className="mono">{p.reference} v{p.version}</span>
        <StatusPill value={p.status} />
        <span className="packcedant-meta">
          template v{p.template_version} · cut {fmtDate(p.created_at, { shortYear: true })}
          {p.created_by_name ? ` by ${p.created_by_name}` : ''}
        </span>
        <div className="sechead-actions">
          <a className="btn btn-secondary btn-sm" href={`/api/packs/${p.id}/export?format=xlsx`}>Export</a>
        </div>
      </div>

      {p.notes && <p className="packnote">{p.notes}</p>}

      <div className="packversion-label">Bordereaux held in this version</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th><th>Source</th><th>Period</th>
              <th className="r">Rows</th><th className="r">Premium</th><th className="r">Incurred</th>
            </tr>
          </thead>
          <tbody>
            {bdx.map((b) => (
              <tr key={b.id}>
                <td>{b.type}</td>
                <td>{b.source_file || <span className="muted">—</span>}</td>
                <td className="mono" style={{ fontSize: 12.5 }}>
                  {b.period_start ? fmtDate(b.period_start, { shortYear: true }) : '—'} →{' '}
                  {b.period_end ? fmtDate(b.period_end, { shortYear: true }) : '—'}
                </td>
                <td className="r">{(b.row_count || 0).toLocaleString('en-US')}</td>
                <td className="r">{b.summary?.premium != null ? fmtMoney(b.summary.premium) : '—'}</td>
                <td className="r">{b.summary?.incurred != null ? fmtMoney(b.summary.incurred) : '—'}</td>
              </tr>
            ))}
            {!bdx.length && (
              <tr><td colSpan="6" className="muted">No bordereaux were held when this version was cut.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {attachments.length > 0 && (
        <>
          <div className="packversion-label">Attachments</div>
          <ul className="packlist">
            {attachments.map((a, i) => (
              <li key={i}>
                {a.name}
                {a.kind && <span className="muted"> · {a.kind}</span>}
                {a.note && <span className="muted"> — {a.note}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {Object.keys(extra).length > 0 && (
        <>
          <div className="packversion-label">Other information</div>
          <ul className="packlist">
            {Object.entries(extra).map(([k, v]) => (
              <li key={k}>
                <span className="muted">{k}:</span>{' '}
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="packcedant-meta" style={{ marginTop: 12 }}>
        Also in this version: {snap.summary?.sections_filled ?? 0} of{' '}
        {snap.summary?.sections_total ?? 0} template sections ·{' '}
        {snap.summary?.layers ?? 0} {snap.summary?.layers === 1 ? 'layer' : 'layers'} ·
        loss ratio{' '}
        {snap.summary?.loss_ratio_pct != null ? `${snap.summary.loss_ratio_pct}%` : 'n/a'}
        {p.changes?.length ? ` · ${p.changes.length} changes vs the previous version` : ''}
      </div>
    </div>
  );
}

/**
 * M10 over the spine: quotes, FOTs, written and signed lines, brokerage, and
 * upcoming renewals with lead time to inception. Everything comes from
 * /dashboards/spine, which computes from queries — nothing here is a counter.
 */
function SpineOverview({ spine }) {
  const d = spine.data;
  if (spine.error) return null; // the book dashboard above still stands on its own
  if (!d) return null;

  const outcomes = Object.entries(d.responses.by_outcome);
  // The section always shows, so the spine workflow is discoverable from day
  // one; an untouched spine gets a pointer to Contracts instead of silence.
  const empty = d.responses.total === 0 && d.fot_structures === 0
    && d.lines.written === 0 && d.lines.signed === 0
    && d.upcoming_renewals.length === 0 && d.renewals_not_started.years.length === 0;

  // No FX rates exist, so brokerage is shown per currency, never as one number.
  const brokerage = d.brokerage.length
    ? d.brokerage.map((b) => `${b.currency} ${fmtCompact(Number(b.amount))}`).join(' · ')
    : '—';

  return (
    <>
      <div className="sechead">
        <SectionLabel>Placement spine</SectionLabel>
        {empty && <span className="hint">nothing on the spine yet — start from <Link to="/contracts">Contracts</Link></span>}
      </div>
      <div className="kpis">
        <Kpi label="Quote responses" value={String(d.responses.total)}
          sub={outcomes.length
            ? outcomes.map(([o, n]) => `${n} ${o.toLowerCase().replace(/_/g, ' ')}`).join(' · ')
            : 'no responses recorded'} />
        <Kpi label="Live firm orders" value={String(d.fot_structures)}
          sub="structures with FOT in force" />
        <Kpi label="Lines" value={`${d.lines.written + d.lines.signed}`}
          sub={`${d.lines.written} written · ${d.lines.signed} signed`} />
        <Kpi label="Brokerage" value={brokerage}
          sub={d.brokerage.length ? 'over signed lines (D2)' : 'no signed lines yet'} />
        <Kpi label="Incepting next" value={d.upcoming_renewals.length
          ? `${d.upcoming_renewals[0].days_to_inception}d`
          : '—'}
          sub={d.upcoming_renewals.length
            ? `${d.upcoming_renewals[0].cedant_name} · ${d.upcoming_renewals[0].contract_name}`
            : 'no upcoming inceptions'} />
        <Kpi label="Renewals not started" value={String(d.renewals_not_started.years.length)}
          sub={d.renewals_not_started.years.length
            ? `expiring within ${d.renewals_not_started.window_days}d with no successor year`
            : `nothing expiring unrenewed within ${d.renewals_not_started.window_days}d`} />
      </div>
    </>
  );
}

/**
 * The launcher: the tool's four functions as one row of pills under the
 * welcome, in the green the hero's actions have always worn — Contracts
 * (proportional or non-proportional, the Universe treaty detail), the
 * renewal calendar, portfolio intelligence and market intelligence. The
 * pills are links, not buttons: Home in the top bar brings the hub back from
 * any of them.
 */
function Launcher() {
  const pills = [
    { label: 'Contracts', to: '/contracts' },
    { label: 'Renewal calendar', to: '/renewals' },
    { label: 'Portfolio intelligence', to: '/portfolio' },
    { label: 'Market intelligence', to: '/portfolio/market-intelligence' },
  ];
  return (
    <nav className="launcher" aria-label="Workspace">
      {pills.map((p) => (
        <Link key={p.label} to={p.to} className="action-pill action-pill--primary">{p.label}</Link>
      ))}
    </nav>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <Blueprint className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </Blueprint>
  );
}

