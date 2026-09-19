import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useScreenHead } from '../shell.jsx';
import { currenciesOf, selectTreaties, summarize, number } from './servicing/model.js';
import './servicing/servicing.css';

const BASE = '/claims-premiums';
const compact = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(number(n));
const date = value => value ? new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
function Icon({ name = 'grid', size = 20 }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    money: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 9h18M7 15h4" /></>,
    shield: <><path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="M15 15l6 6" /></>,
    layers: <><path d="M12 3l10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M18 18a8 8 0 0 1-13-3" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.grid}</svg>;
}
function Money({ values, empty = '—' }) {
  const entries = Object.entries(values || {});
  return entries.length ? <span className="sv-money">{entries.map(([ccy, amount]) => <span key={ccy} title={`${ccy} ${number(amount).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}><small>{ccy}</small> {compact(amount)}</span>)}</span> : empty;
}
function Back({ to = BASE, children = 'Treaty types' }) { return <Link className="sv-back" to={to}>← {children}</Link>; }

export function ServicingEntry() {
  useScreenHead('Treaty servicing', 'Claims & premium');
  return <div className="screen sv">
    <div className="sv-choices">
      <Link className="sv-choice sv-choice-active" to={`${BASE}/non-proportional`}><span className="sv-choice-top"><Icon name="layers" size={28} /><span className="sv-tag">READY TO EXPLORE</span></span><h2>Non-Proportional</h2><p>Your placed excess of loss treaties, premium accounts, reported claims and preliminary loss advices.</p><span className="sv-choice-foot">Open dashboard <Icon name="arrow" /></span></Link>
      <Link className="sv-choice" to={`${BASE}/proportional`}><span className="sv-choice-top"><Icon name="grid" size={28} /><span className="sv-tag sv-tag-neutral">COMING NEXT</span></span><h2>Proportional</h2><p>A dedicated workspace for quota share and surplus treaty premiums and claims.</p><span className="sv-choice-foot">View workspace <Icon name="arrow" /></span></Link>
    </div>
  </div>;
}
export function ProportionalServicing() {
  useScreenHead('Claims & premium', 'Proportional');
  return <div className="screen sv"><Back /><section className="sv-placeholder"><Icon name="grid" size={38} /><span className="sv-eyebrow">PROPORTIONAL</span><h1>A dedicated workspace.<br />Coming next.</h1><p>The proportional premium and claims workflow will be designed separately.</p><Link className="sv-button" to={`${BASE}/non-proportional`}>Explore Non-Proportional <Icon name="arrow" /></Link></section></div>;
}
export function ServicingWorkflow() {
  const { workflow } = useParams();
  const label = workflow === 'premium' ? 'Premium' : 'Claims';
  useScreenHead('Claims & premium / Non-Proportional', label);
  return <div className="screen sv"><Back to={`${BASE}/non-proportional`}>Non-Proportional dashboard</Back><section className="sv-placeholder"><Icon name={label === 'Premium' ? 'money' : 'shield'} size={38} /><span className="sv-eyebrow">NON-PROPORTIONAL · {label.toUpperCase()}</span><h1>Your {label.toLowerCase()} workspace.</h1><p>This workflow is the next design stage. Return to the dashboard to see the placed treaty portfolio.</p><Link className="sv-button" to={`${BASE}/non-proportional`}>Back to dashboard <Icon name="arrow" /></Link></section></div>;
}
function Metric({ label, value, note, icon, tone = '', badge }) {
  return <section className={`sv-metric ${tone}`}><div className="sv-metric-top"><span className="sv-icon"><Icon name={icon} /></span>{badge && <span className="sv-micro-tag">{badge}</span>}</div><h2>{label}</h2><div className="sv-value">{value}</div><p>{note}</p></section>;
}
export default function ClaimsPremiumDashboard() {
  useScreenHead('Claims & premium / Non-Proportional', 'Treaty servicing');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [currency, setCurrency] = useState('');
  const [year, setYear] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    api('GET', '/dashboards/servicing/non-proportional').then(result => { if (alive) setData(result); }).catch(e => { if (alive) { setData(null); setError(e.message); } }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision]);
  useEffect(() => { setPage(1); }, [search, currency, year, data]);
  const treaties = data?.treaties || [];
  const filtered = useMemo(() => selectTreaties(treaties, { search, currency, year }), [data, search, currency, year]);
  const totals = useMemo(() => summarize(filtered, currency), [filtered, currency]);
  const years = [...new Set(treaties.map(t => String(t.inception).slice(0, 4)))].sort().reverse();
  const pendingSchedules = filtered.filter(t => !t.premiums.length || t.premiums.reduce((s, p) => s + number(p.scheduled_layers), 0) < number(t.layer_count)).length;
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * 8, currentPage * 8);
  const money = key => <Money values={totals[key]} />;
  return <div className="screen sv">
    <div className="sv-navigation"><Back /><span className="sv-context"><i /> NON-PROPORTIONAL</span></div>
    <section className="sv-hero"><div><span className="sv-eyebrow">YOUR PLACED PORTFOLIO</span><h1>Premiums in motion.<br /><em>Claims in focus.</em></h1><p>One clear view of every placed treaty and the accounts behind it.</p></div><div className="sv-hero-side"><div className="sv-actions"><Link className="sv-button" to={`${BASE}/non-proportional/premium`}><Icon name="money" /> Premium <Icon name="arrow" /></Link><Link className="sv-button" to={`${BASE}/non-proportional/claims`}><Icon name="shield" /> Claims <Icon name="arrow" /></Link></div><span>Two dedicated workflows. One connected portfolio.</span></div></section>
    <div className="sv-toolbar"><div><span className="sv-dot" /> Portfolio overview <span className="sv-count">{loading ? '…' : filtered.length} treaties</span></div><div className="sv-filters"><label><span>Underwriting year</span><select aria-label="Underwriting year" value={year} onChange={e => setYear(e.target.value)}><option value="">All years</option>{years.map(y => <option key={y}>{y}</option>)}</select></label><label><span>Currency</span><select aria-label="Currency" value={currency} onChange={e => setCurrency(e.target.value)}><option value="">All currencies</option>{currenciesOf(treaties).map(c => <option key={c}>{c}</option>)}</select></label><button className="sv-refresh" onClick={() => setRevision(v => v + 1)} disabled={loading} aria-label="Refresh dashboard"><Icon name="refresh" /></button></div></div>
    {error && <div className="sv-error" role="alert">Could not load treaty servicing: {error} <button onClick={() => setRevision(v => v + 1)}>Try again</button></div>}
    {loading ? <div className="sv-loading" role="status">Loading placed treaties and account balances…</div> : data && <>
      <div className="sv-metrics">
        <Metric label="Premiums Paid" value={money('paid')} note="Gross signed-share debit notes settled" icon="money" tone="sv-positive" badge="COLLECTED" />
        <Metric label="Premiums Due" value={money('due')} note="Unpaid debit notes due by today" icon="clock" tone="sv-amber" badge="TO COLLECT" />
        <Metric label="Premium accounts due" value={totals.accounts_due.toLocaleString()} note="Unpaid market instalment accounts" icon="file" />
        <Metric label="Adjustment premiums calculations due" value={totals.adjustment_due.toLocaleString()} note="Expired, at least 12 months old, not yet adjusted" icon="refresh" badge="YEAR-END" />
        <Metric label="Reported Claims (Number)" value={totals.reported_count.toLocaleString()} note="Distinct recorded loss events" icon="shield" />
        <Metric label="Reported Claims (Amount)" value={money('reported_amount')} note="Current loss reported · at 100%" icon="shield" />
        <Metric label="PLAs (Number)" value={totals.pla_count.toLocaleString()} note="Claims with a delivered preliminary advice" icon="file" />
        <Metric label="PLAs (Amount)" value={money('pla_amount')} note="Latest advised reserve per claim · at 100%" icon="file" />
      </div>
      <div className="sv-insights"><section className="sv-collection"><div className="sv-section-head"><div><span className="sv-eyebrow">THE PREMIUM PICTURE</span><h2>Collection position</h2></div><Icon name="money" /></div><div className="sv-legend"><span><i className="paid" />Paid</span><span><i className="due" />Due</span><span><i className="upcoming" />Not yet due</span></div>{Object.keys(totals.paid).length ? Object.keys(totals.paid).map(ccy => {
        const paid = totals.paid[ccy], due = totals.due[ccy] || 0, upcoming = totals.upcoming[ccy] || 0, total = paid + due + upcoming;
        return <div className="sv-collection-row" key={ccy}><div><b>{ccy}</b><span>{total ? `${Math.round(paid / total * 100)}% collected` : 'No issued balance'}</span></div><div className="sv-bar" role="img" aria-label={`${ccy}: ${paid} paid, ${due} due, ${upcoming} not yet due`}>{total > 0 && <><i className="paid" style={{ width: `${paid / total * 100}%` }} /><i className="due" style={{ width: `${due / total * 100}%` }} /><i className="upcoming" style={{ width: `${upcoming / total * 100}%` }} /></>}</div><div className="sv-bar-values"><span>{compact(paid)} paid</span><span>{compact(due)} due</span><span>{compact(upcoming)} not yet due</span></div></div>;
      }) : <p className="sv-muted">Collection balances will appear once premium schedules are issued.</p>}</section>
      <section className="sv-focus"><span className="sv-eyebrow">ON YOUR RADAR</span><h2>A clear next step.</h2><div><span className="sv-focus-number">{totals.accounts_due}</span><p>premium accounts are due<br />for collection.</p></div><p className="sv-focus-note">{pendingSchedules ? `${pendingSchedules} ${pendingSchedules === 1 ? 'treaty has' : 'treaties have'} premium schedules still to be issued.` : filtered.length ? 'All displayed treaties have issued premium schedules.' : 'Your placed treaties will appear here once signed or confirmed.'}</p><Link to={`${BASE}/non-proportional/premium`}>Open Premium <Icon name="arrow" /></Link></section></div>
      <section className="sv-treaties"><div className="sv-table-head"><div><span className="sv-eyebrow">THE BOOK BEHIND THE NUMBERS</span><h2>Placed treaties <span>{filtered.length}</span></h2></div><label className="sv-search"><Icon name="search" /><input type="search" aria-label="Search placed treaties" placeholder="Search treaty, cedant or country…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
      <div className="sv-table-scroll"><table><thead><tr><th>Treaty / Cedant</th><th>Period</th><th>Premiums paid</th><th>Premiums due</th><th>Reported claims</th><th>PLAs</th><th>Accounts</th></tr></thead><tbody>{visible.map(t => {
        const s = summarize([t], currency);
        const scheduled = t.premiums.some(p => (!currency || p.currency === currency) && number(p.scheduled_layers) > 0);
        const claimInScope = !currency || currency === t.currency;
        return <tr key={t.id}><td><Link to={`/placements/${t.id}/claims`}>{t.cedant_name} <span>↗</span></Link><small>{t.reference} · {t.class}</small><small>{t.country || 'Country not recorded'}</small></td><td><span>{date(t.inception)}</span><small>to {date(t.expiry)}</small></td><td><Money values={s.paid} /></td><td className="sv-due-value"><Money values={s.due} /></td><td><b>{claimInScope ? t.reported_count : '—'}</b><small><Money values={s.reported_amount} /></small></td><td><b>{claimInScope ? t.pla_count : '—'}</b><small><Money values={s.pla_amount} /></small></td><td><span className={`sv-status ${s.accounts_due ? 'sv-status-due' : ''}`}>{s.accounts_due ? `${s.accounts_due} due` : scheduled ? 'Up to date' : 'No schedule'}</span></td></tr>;
      })}</tbody></table></div>
      {!filtered.length && <div className="sv-empty"><Icon name="layers" size={30} /><h3>{treaties.length ? 'No treaties match these filters' : 'Your placed book starts here'}</h3><p>{treaties.length ? 'Try another cedant, year or currency.' : 'Signed or bound non-proportional layers and confirmed non-proportional placements will appear automatically.'}</p>{treaties.length > 0 && <button className="sv-button" onClick={() => { setSearch(''); setCurrency(''); setYear(''); }}>Clear filters</button>}</div>}
      <div className="sv-table-footer"><span>{filtered.length ? `${(currentPage - 1) * 8 + 1}–${Math.min(currentPage * 8, filtered.length)} of ${filtered.length} treaties` : '0 treaties'}</span><div><button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage} / {pages}</span><button disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div></div></section>
      <footer className="sv-footnote"><span>As at {date(data.as_of)} · Amounts remain in their original currency. No FX conversion.</span><details><summary>How these figures are counted</summary><p>Premiums include approved MDP and adjustment debit notes plus current legacy MDP debit notes. Credit notes are shown separately in the Premium workspace. Due means unpaid and due today or earlier; each market instalment is one account. Superseded schedules are excluded. Reported claims are distinct loss events, including settled events, at their current recorded 100% amount: retained loss entering the treaty for Claims workspace entries, and the original gross-loss basis for legacy entries. PLAs count one successfully delivered preliminary advice per claim and use its latest reserve; resends are not added again. Claims and PLAs overlap and must not be added together. Adjustment calculations are due after expiry and at least 12 months from inception, until an adjustment account is approved. Filters apply to both the cards and the treaty list.</p></details></footer>
    </>}
  </div>;
}
