import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  useFetch, Blueprint, SectionLabel, StatusPill, Pill, ErrorBanner, Tabs, SearchInput,
  TRACKER_STAGES, fmtCompact, fmtDate, fmtPct,
} from '../components.jsx';
import { useScreenHead } from '../shell.jsx';
import { ALL_YEARS, useTreatyYear, yearLabel } from '../treatyYear.js';

/**
 * Portfolio intelligence — the renewal calendar's neighbour in the top bar:
 * the book read by who leads it, who places it and who writes it.
 *
 * Every figure comes from /dashboards/portfolio, computed from the placement
 * book on each call. The treaty year in the top bar scopes it, as it scopes
 * Placements; "All treaty years" reads the whole book. The reading of each
 * account is the calendar's: we lead when the full order runs through this
 * desk and follow when we hold a share of it, unless Final Placement has
 * recorded who leads — then that record stands.
 */

/** "USD 1.2m · EUR 300k" — the book holds no FX rates, so a mixed figure shows its parts. */
export function currencyNote(money, empty = '—') {
  const entries = Object.entries(money?.by_currency || {});
  if (!entries.length) return empty;
  if (entries.length === 1) return `${entries[0][0]} ${fmtCompact(entries[0][1])}`;
  return `mixed — ${entries.map(([ccy, amt]) => `${ccy} ${fmtCompact(amt)}`).join(' · ')}`;
}

/** A money figure in a cell: one currency reads "USD 27.5m"; a mixed one shows its split on hover. */
export function MoneyCell({ money }) {
  const entries = Object.entries(money?.by_currency || {});
  if (!entries.length) return <span className="muted">—</span>;
  if (entries.length === 1) return <span className="num">{entries[0][0]} {fmtCompact(entries[0][1])}</span>;
  return (
    <span className="num" title={currencyNote(money)}>
      {fmtCompact(money.total)} <span className="muted small">mixed</span>
    </span>
  );
}

const share = (n, of) => (of > 0 ? Math.round((n / of) * 100) : 0);
const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Kpi({ label, value, sub }) {
  return (
    <Blueprint className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </Blueprint>
  );
}

/** A count beside a bar scaled to the largest row — the number is the reading, the bar the glance. */
function CountBar({ value, max }) {
  const width = max > 0 ? Math.max(3, Math.round((value / max) * 100)) : 0;
  return (
    <span className="pi-bar">
      <span className="minibar" aria-hidden="true"><i style={{ width: `${width}%` }} /></span>
      <span className="num">{value}</span>
    </span>
  );
}

/** Account references as chips, each opening its placement. */
function AccountChips({ accounts, onOpen, meta }) {
  return (
    <div className="pi-chips">
      {accounts.map((a) => (
        <button
          key={a.id}
          type="button"
          className="pi-chip"
          title={`${a.cedant_name} · ${a.class}`}
          onClick={() => onOpen(a)}
        >
          {a.reference}
          {meta && <span className="pi-chip-meta">{meta(a)}</span>}
        </button>
      ))}
    </div>
  );
}

/** How far a lead has come, in the words the book uses. */
const STAGE = {
  SIGNED: 'signed', WRITTEN: 'written', AGREED: 'agreed', QUOTED: 'quoted', APPROACHED: 'approached',
  SENT: 'pack sent', confirmed: 'confirmed', fot_sent: 'FOT sent', draft: 'recorded',
};
const stageOf = (source, status) => (source === 'final' ? (STAGE[status] || 'recorded') : (STAGE[status] || String(status || '').toLowerCase()));

const SOURCE_NOTE = {
  final: 'recorded at Final Placement',
  approach: 'the lead furthest along in the marketing on the layers',
  negotiation: 'the pack went to them as lead',
};

const ROLE_TABS = [
  { value: 'all', label: 'All accounts' },
  { value: 'Lead', label: 'We lead' },
  { value: 'Follow', label: 'We follow' },
  { value: 'unplaced', label: 'Not yet placed' },
];

/** Accounts rolled up by a key: how many, how many we lead or follow, and their premium. */
function breakdown(accounts, keyOf, order) {
  const m = new Map();
  for (const a of accounts) {
    const k = keyOf(a) || '—';
    const cur = m.get(k) || { key: k, accounts: 0, lead: 0, follow: 0, premium: { total: 0, by_currency: {} } };
    cur.accounts += 1;
    if (a.broker_role === 'Lead') cur.lead += 1;
    if (a.broker_role === 'Follow') cur.follow += 1;
    if (a.total_premium100) {
      cur.premium.total += a.total_premium100;
      cur.premium.by_currency[a.currency] = (cur.premium.by_currency[a.currency] || 0) + a.total_premium100;
    }
    m.set(k, cur);
  }
  const rows = [...m.values()];
  if (order) {
    const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
    return rows.sort((x, y) => rank(x.key) - rank(y.key) || x.key.localeCompare(y.key));
  }
  return rows.sort((x, y) => y.accounts - x.accounts || x.key.localeCompare(y.key));
}

function Breakdown({ title, hint, rows, status, loading }) {
  return (
    <section>
      <div className="sechead">
        <SectionLabel>{title}</SectionLabel>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
        <table className="table pi-table pi-breakdown">
          {/* One column layout for all three, so they line up side by side. */}
          <colgroup>
            <col style={{ width: '36%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '26%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>{status ? 'Stage' : title.replace(/^By /, '')}</th>
              <th className="r">Accounts</th>
              <th className="r" title="accounts we lead · accounts we follow">Lead · follow</th>
              <th className="r">Premium (100%)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{status ? <StatusPill value={r.key} /> : r.key}</td>
                <td className="r">{r.accounts}</td>
                <td className="r">{r.lead || r.follow ? `${r.lead} · ${r.follow}` : <span className="muted">—</span>}</td>
                <td className="r pi-nowrap"><MoneyCell money={r.premium} /></td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan="4" className="muted">{loading ? 'Loading…' : 'Nothing on the book in this scope.'}</td></tr>
            )}
          </tbody>
        </table>
      </Blueprint>
    </section>
  );
}

export default function PortfolioIntelligence() {
  const [year] = useTreatyYear();
  const scopeLabel = year === ALL_YEARS ? 'All treaty years' : `${yearLabel(year)} treaty year`;
  useScreenHead('Placement diary', 'Portfolio intelligence', scopeLabel);
  const navigate = useNavigate();

  const path = year === ALL_YEARS ? '/dashboards/portfolio' : `/dashboards/portfolio?year=${year}`;
  const port = useFetch('GET', path, [path]);
  const d = port.data;
  const s = d?.summary;
  const accounts = d?.accounts || [];
  const leaders = d?.lead_reinsurers || [];
  const panel = d?.reinsurers || [];
  const brokers = d?.brokers || [];
  const loading = !d && !port.error;

  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [klass, setKlass] = useState('');
  const [region, setRegion] = useState('');
  const [brokerFilter, setBrokerFilter] = useState('');
  const [leadFilter, setLeadFilter] = useState('');

  const openAccount = (a) => navigate(`/contracts/${a.id}`);

  const options = useMemo(() => ({
    classes: uniq(accounts.map((a) => a.class)),
    regions: uniq(accounts.map((a) => a.cedant_region)),
    brokers: uniq(accounts.map((a) => a.lead_broker)),
    leads: uniq(accounts.flatMap((a) => a.lead_reinsurers.map((l) => l.name))),
  }), [accounts]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return accounts.filter((a) => {
      if (tab === 'unplaced' ? a.broker_role : (tab !== 'all' && a.broker_role !== tab)) return false;
      if (klass && a.class !== klass) return false;
      if (region && a.cedant_region !== region) return false;
      if (brokerFilter && a.lead_broker !== brokerFilter) return false;
      if (leadFilter && !a.lead_reinsurers.some((l) => l.name === leadFilter)) return false;
      if (!needle) return true;
      return [a.reference, a.cedant_name, a.cedant_country, a.class, a.lead_broker, a.lead_reinsurer]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [accounts, tab, q, klass, region, brokerFilter, leadFilter]);

  const breakdowns = useMemo(() => ({
    klass: breakdown(accounts, (a) => a.class),
    region: breakdown(accounts, (a) => a.cedant_region || 'No region on the register'),
    stage: breakdown(accounts, (a) => a.status, TRACKER_STAGES),
  }), [accounts]);

  const counts = {
    all: d ? accounts.length : null,
    Lead: s?.accounts_led ?? null,
    Follow: s?.accounts_followed ?? null,
    unplaced: s?.accounts_unplaced ?? null,
  };
  const maxLed = Math.max(0, ...leaders.map((l) => l.accounts_led));
  const maxBroker = Math.max(0, ...brokers.map((b) => b.accounts_count));
  const maxPanel = Math.max(0, ...panel.map((r) => r.accounts));
  const panelLines = panel.reduce((n, r) => n + r.lines, 0);
  const panelSigned = panel.reduce((n, r) => n + r.signed_lines, 0);
  const otherHouses = brokers.filter((b) => b.name && !b.is_house).map((b) => b.name);

  return (
    <div className="screen">
      <ErrorBanner error={port.error} />

      <div className="sechead pi-scoperow">
        <span className="pi-scope">
          {scopeLabel} — set in the top bar. Lead and follow are read from each account&rsquo;s order
          (the full 100% through this desk, or a share of it); the lead reinsurer and the lead broker
          from Final Placement where recorded, else from the marketing on the layers.
        </span>
        <div className="sechead-actions">
          {/* The same book cut by broker and by reinsurer, drawn: which houses
              place the programmes, which reinsurers write them, and where the
              two meet. */}
          <Link className="btn btn-primary btn-sm" to="/portfolio/programmes" data-testid="pi-analyse-programmes">
            Analyse programmes →
          </Link>
          {/* A market by country or region: our book there, the AI's research
              of the internet, and the brokers' own visits and notes. */}
          <Link className="btn btn-primary btn-sm" to="/portfolio/market-intelligence" data-testid="pi-market-intelligence">
            Market intelligence →
          </Link>
          <Link className="btn btn-secondary btn-sm" to="/renewals">Renewal calendar →</Link>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Accounts on the book" value={s ? String(s.accounts) : '—'}
          sub={s ? [
            plural(s.cedants, 'cedant'),
            s.accounts_unplaced ? `${s.accounts_unplaced} not yet placed` : null,
            s.accounts_lost ? `${s.accounts_lost} lost or lapsed left out` : null,
          ].filter(Boolean).join(' · ') : ''} />
        <Kpi label="We lead" value={s ? String(s.accounts_led) : '—'}
          sub={s ? `${share(s.accounts_led, s.accounts)}% of the book — the full order through this desk` : ''} />
        <Kpi label="We follow" value={s ? String(s.accounts_followed) : '—'}
          sub={s ? (otherHouses.length
            ? `led by ${otherHouses.join(', ')}`
            : s.accounts_followed ? 'lead broker not yet named at Final Placement' : 'no account another house leads') : ''} />
        <Kpi label="Premium seen (100%)" value={s ? fmtCompact(s.premium_seen.total) : '—'}
          sub={s ? currencyNote(s.premium_seen, 'no layer premium recorded yet') : ''} />
        <Kpi label="Our order" value={s ? fmtCompact(s.premium_order.total) : '—'}
          sub={s ? (s.order_share_pct != null
            ? `${s.order_share_pct}% of premium seen is ours to place`
            : 'no order recorded on a layer yet') : ''} />
        <Kpi label="Brokerage expected" value={s ? fmtCompact(s.brokerage_expected.total) : '—'}
          sub={s ? (s.brokerage_expected.total
            ? `${currencyNote(s.brokerage_expected)} on our order at the layers' rates`
            : 'no brokerage rate on a layer yet') : ''} />
        <Kpi label="Lead reinsurers" value={s ? String(s.lead_reinsurers) : '—'}
          sub={s ? (leaders[0]
            ? `${leaders[0].name} leads most — ${plural(leaders[0].accounts_led, 'account')}`
            : 'no account has a lead reinsurer yet') : ''} />
        <Kpi label="Reinsurers on panel" value={s ? String(s.reinsurers_on_panel) : '—'}
          sub={s ? (panelLines ? `${plural(panelLines, 'line')} written · ${panelSigned} signed` : 'no written line yet') : ''} />
      </div>

      {/* Who is leading */}
      <section>
        <div className="sechead">
          <SectionLabel>Who is leading — lead reinsurers{d && leaders.length ? ` · ${leaders.length}` : ''}</SectionLabel>
          <span className="hint">
            recorded at Final Placement, else the lead furthest along in the marketing — co-leads both count, a declined lead never does
          </span>
        </div>
        <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table pi-table">
            <thead>
              <tr>
                <th>Reinsurer</th>
                <th>Rating</th>
                <th>Region</th>
                <th>Accounts led</th>
                <th className="r">Premium led (100%)</th>
                <th>Recorded</th>
                <th>Accounts</th>
              </tr>
            </thead>
            <tbody>
              {leaders.map((l) => (
                <tr key={l.market_id || `name:${l.name}`}>
                  <td>{l.name}</td>
                  <td>{l.rating || '—'}</td>
                  <td>{l.region || '—'}</td>
                  <td><CountBar value={l.accounts_led} max={maxLed} /></td>
                  <td className="r"><MoneyCell money={l.premium_led} /></td>
                  <td className="pi-cell-source">
                    {l.confirmed
                      ? `${l.confirmed} of ${l.accounts_led} at Final Placement`
                      : 'from the marketing'}
                  </td>
                  <td>
                    <AccountChips accounts={l.accounts} onOpen={openAccount} meta={(a) => stageOf(a.source, a.stage)} />
                  </td>
                </tr>
              ))}
              {d && !leaders.length && (
                <tr><td colSpan="7" className="muted">No account in this scope has a lead reinsurer yet.</td></tr>
              )}
              {loading && <tr><td colSpan="7" className="muted">Loading…</td></tr>}
            </tbody>
          </table>
        </Blueprint>
      </section>

      {/* Who is placing */}
      <section>
        <div className="sechead">
          <SectionLabel>Who is placing — brokers by account</SectionLabel>
          <span className="hint">
            this desk when the full order runs through it; the other house named at Final Placement when we follow
          </span>
        </div>
        <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table pi-table">
            <thead>
              <tr>
                <th>Broker</th>
                <th>Accounts</th>
                <th className="r">Premium (100%)</th>
                <th className="r">Our order</th>
                <th>Recorded</th>
                <th>Accounts</th>
              </tr>
            </thead>
            <tbody>
              {brokers.map((b) => (
                <tr key={b.name || 'unnamed'}>
                  <td>
                    {b.name || <span className="muted">Another house — not yet named</span>}
                    {b.is_house && <Pill tone="green" className="pi-inline">this desk</Pill>}
                  </td>
                  <td><CountBar value={b.accounts_count} max={maxBroker} /></td>
                  <td className="r"><MoneyCell money={b.premium} /></td>
                  <td className="r"><MoneyCell money={b.premium_order} /></td>
                  <td className="pi-cell-source">
                    {b.confirmed
                      ? `${b.confirmed} of ${b.accounts_count} at Final Placement`
                      : b.name ? 'from the order on the layers' : 'name the lead broker at Final Placement'}
                  </td>
                  <td>
                    <AccountChips
                      accounts={b.accounts}
                      onOpen={openAccount}
                      meta={(a) => (a.broker_role === 'Follow' ? `we hold ${fmtPct(a.order_share_pct, 0)}` : 'we lead')}
                    />
                  </td>
                </tr>
              ))}
              {d && !brokers.length && (
                <tr><td colSpan="6" className="muted">No account in this scope has an order to read a broker from yet.</td></tr>
              )}
              {loading && <tr><td colSpan="6" className="muted">Loading…</td></tr>}
            </tbody>
          </table>
        </Blueprint>
      </section>

      {/* Who is writing */}
      <section>
        <div className="sechead">
          <SectionLabel>Who is writing — the reinsurer panel{d && panel.length ? ` · ${panel.length}` : ''}</SectionLabel>
          <span className="hint">
            every reinsurer with a written or signed line, in the role it was approached in
          </span>
        </div>
        <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table pi-table">
            <thead>
              <tr>
                <th>Reinsurer</th>
                <th>Rating</th>
                <th>Region</th>
                <th>Accounts</th>
                <th className="r">Lines</th>
                <th className="r">Lead · follow</th>
                <th className="r">Avg line</th>
                <th className="r">Total share</th>
                <th className="r">Premium on lines</th>
                <th className="r">Premium signed</th>
                <th className="r">Leads</th>
              </tr>
            </thead>
            <tbody>
              {panel.map((r) => (
                <tr key={r.market_id}>
                  <td>{r.name}</td>
                  <td>{r.rating || '—'}</td>
                  <td>{r.region || '—'}</td>
                  <td><CountBar value={r.accounts} max={maxPanel} /></td>
                  <td className="r">{r.lines}<span className="muted small"> · {r.signed_lines} signed</span></td>
                  <td className="r">{r.lead_lines} · {r.follow_lines}</td>
                  <td className="r">{fmtPct(r.avg_line_pct, 1)}</td>
                  <td className="r">{fmtPct(r.share_total, 1)}</td>
                  <td className="r"><MoneyCell money={r.premium_on_lines} /></td>
                  <td className="r"><MoneyCell money={r.premium_signed} /></td>
                  <td className="r">{r.accounts_led || <span className="muted">—</span>}</td>
                </tr>
              ))}
              {d && !panel.length && (
                <tr><td colSpan="11" className="muted">No written line in this scope yet.</td></tr>
              )}
              {loading && <tr><td colSpan="11" className="muted">Loading…</td></tr>}
            </tbody>
          </table>
        </Blueprint>
        <p className="muted small" style={{ marginTop: 10 }}>
          Total share is the sum of the reinsurer&rsquo;s signed lines across the book (written where signing
          has not run), as the market register reads it; premium on lines is the layers&rsquo; premium at 100%
          times those lines, and premium signed is what the signed lines actually carry. Lead · follow counts
          the lines by the role the market was approached in — a line written with no approach on record
          carries neither.
        </p>
      </section>

      {/* The accounts */}
      <section>
        <div className="sechead">
          <SectionLabel>Accounts — who leads each one</SectionLabel>
          <span className="hint">click a reference to open the placement</span>
        </div>
        <Blueprint style={{ marginTop: 10 }}>
          <div className="pi-tabs">
            <Tabs
              tabs={ROLE_TABS.map((t) => ({ ...t, hint: counts[t.value] }))}
              value={tab}
              onChange={setTab}
            />
          </div>
          <div className="filterbar">
            <span className="filterbar-search">
              <SearchInput value={q} onChange={setQ} placeholder="Reference, cedant, broker, reinsurer…" label="Search accounts" />
            </span>
            <select className="input" value={klass} onChange={(e) => setKlass(e.target.value)} aria-label="Filter by class">
              <option value="">All classes</option>
              {options.classes.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="input" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Filter by region">
              <option value="">All regions</option>
              {options.regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <select className="input" value={brokerFilter} onChange={(e) => setBrokerFilter(e.target.value)} aria-label="Filter by lead broker">
              <option value="">All brokers</option>
              {options.brokers.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <select className="input" value={leadFilter} onChange={(e) => setLeadFilter(e.target.value)} aria-label="Filter by lead reinsurer">
              <option value="">All lead reinsurers</option>
              {options.leads.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            <span className="filterbar-meta">
              {d ? `${filtered.length} of ${plural(accounts.length, 'account')}` : ''}
            </span>
          </div>
          <div className="table-wrap">
            <table className="table pi-table renewal-cal">
              <thead>
                <tr>
                  <th>Incepts</th>
                  <th>Reference</th>
                  <th>Cedant</th>
                  <th>Country</th>
                  <th>Class of business</th>
                  <th>Treaty type</th>
                  <th>Our role</th>
                  <th>Lead broker</th>
                  <th>Lead reinsurer</th>
                  <th className="r">Panel</th>
                  <th className="r">Our share</th>
                  <th className="r">Premium (100%)</th>
                  <th className="r">Brokerage</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id}>
                    <td className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                      {fmtDate(a.inception, { shortYear: true })}
                    </td>
                    <td>
                      <button className="refbtn" onClick={() => openAccount(a)}>{a.reference}</button>
                    </td>
                    <td>{a.cedant_name}</td>
                    <td>{a.cedant_country || '—'}</td>
                    <td style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>{a.class}</td>
                    <td>{a.treaty_types || '—'}</td>
                    <td>
                      {a.broker_role
                        ? <Pill tone={a.broker_role === 'Lead' ? 'green' : 'blue'}>{a.broker_role}</Pill>
                        : <span className="muted">—</span>}
                    </td>
                    <td>
                      {a.lead_broker
                        || (a.broker_role === 'Follow'
                          ? <span className="muted">not yet named</span>
                          : <span className="muted">—</span>)}
                    </td>
                    <td>
                      {a.lead_reinsurer
                        ? (
                          <span className="pi-lead" title={SOURCE_NOTE[a.lead_source]}>
                            {a.lead_reinsurer}
                            <span className="pi-stage">{stageOf(a.lead_source, a.lead_reinsurers[0]?.status)}</span>
                          </span>
                        )
                        : <span className="muted">not yet led</span>}
                    </td>
                    <td className="r" title={a.panel.map((p) => `${p.name} ${fmtPct(p.share, 1)}`).join(', ')}>
                      {a.panel_size || <span className="muted">—</span>}
                    </td>
                    <td className="r">{fmtPct(a.order_share_pct, 0)}</td>
                    <td className="r">
                      {a.total_premium100
                        ? `${a.currency} ${fmtCompact(a.total_premium100)}`
                        : a.est_gwp != null
                          ? <span className="muted">est. {a.currency} {fmtCompact(a.est_gwp)}</span>
                          : '—'}
                    </td>
                    <td className="r">{a.brokerage_pct ? fmtPct(a.brokerage_pct, 2) : '—'}</td>
                    <td><StatusPill value={a.status} /></td>
                  </tr>
                ))}
                {d && !filtered.length && (
                  <tr>
                    <td colSpan="14" className="muted">
                      {accounts.length ? 'No account matches these filters.' : 'Nothing on the book in this scope — try another treaty year.'}
                    </td>
                  </tr>
                )}
                {loading && <tr><td colSpan="14" className="muted">Loading…</td></tr>}
              </tbody>
            </table>
          </div>
        </Blueprint>
      </section>

      <div className="pi-trio">
        <Breakdown title="By class of business" rows={breakdowns.klass} loading={loading} />
        <Breakdown title="By cedant region" hint="the cedant's territory on the register" rows={breakdowns.region} loading={loading} />
        <Breakdown title="By stage" rows={breakdowns.stage} status loading={loading} />
      </div>
    </div>
  );
}
