import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import {
  useFetch, Blueprint, SectionLabel, Pill, StatusPill, ErrorBanner, fmtCompact, fmtDate, fmtStamp, providerLabel,
} from '../components.jsx';
import { useScreenHead } from '../shell.jsx';
import { useAuth, useHasRole } from '../auth.jsx';
import { useRefData } from '../RefData.jsx';
import { useToast } from '../toast.jsx';
import { ALL_YEARS, useTreatyYear, yearLabel } from '../treatyYear.js';
import { currencyNote, MoneyCell } from './PortfolioIntelligence.jsx';

/**
 * Market intelligence — behind the "Market intelligence" button on Portfolio
 * intelligence: a market by country or by region of the reference list,
 * read from three sources at once.
 *
 *  - the brief     what the AI gathered from the internet for the market —
 *                  its dynamics, the cedants buying reinsurance there,
 *                  regulatory change, dated developments, what to do next —
 *                  with the desk's own notes and visits folded in. It lands
 *                  unverified and says so until someone signs it off.
 *  - our book      the accounts whose cedant is domiciled in the market, as
 *                  Portfolio intelligence reads them; the treaty year in the
 *                  top bar narrows this table alone.
 *  - the desk      every broker's market visits — where, when, what it cost,
 *                  whom they met — each read against the brokerage the book
 *                  expects from the cedants met (or the country) in the year
 *                  after the trip; and the notes kept on a cedant, a country
 *                  or a region, typed or uploaded, which roll up into the
 *                  scopes above them and into the next gather.
 *
 * The scope lives in the URL (?region=Europe&country=GB) so a market can be
 * linked. With no scope the screen is the map: every region and country with
 * what the desk holds on it, the trips log and the latest notes.
 */

const BASE = '/market-intelligence';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const money = (ccy, n) => `${ccy ? `${ccy} ` : ''}${fmtCompact(n)}`;
const signedPct = (pct) => (pct == null ? '—' : `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toLocaleString('en-US', { maximumFractionDigits: 0 })}%`);
const LEVELS = [
  { value: 'cedant', label: 'Cedant' },
  { value: 'country', label: 'Country' },
  { value: 'region', label: 'Region' },
];
const TOPIC_LABEL = {
  pricing: 'Pricing', capacity: 'Capacity', demand: 'Demand', catastrophe: 'Catastrophe', losses: 'Losses',
  distribution: 'Distribution', competition: 'Competition', economy: 'Economy', other: 'Other',
};
const FALLBACK_CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF', 'AED', 'SAR', 'ZAR', 'INR', 'SGD', 'JPY', 'AUD', 'CAD'];

function Kpi({ label, value, sub, testid }) {
  return (
    <Blueprint className="kpi" data-testid={testid}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </Blueprint>
  );
}

/** A file picked in the browser, as the API takes it: its name and base64 bytes. */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ filename: file.name, data: String(reader.result).split(',')[1] || '' });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Every country on the list, grouped by region, as <optgroup>s. */
function CountryOptions({ regions }) {
  return regions.map((r) => (
    <optgroup key={r.region} label={r.region}>
      {r.countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
    </optgroup>
  ));
}

export default function MarketIntelligence() {
  const [year] = useTreatyYear();
  const allYears = year === ALL_YEARS;
  const [params, setParams] = useSearchParams();
  const regionParam = params.get('region') || '';
  const countryParam = params.get('country') || '';
  const scope = countryParam
    ? { type: 'country', key: countryParam }
    : regionParam ? { type: 'region', key: regionParam } : null;

  const overview = useFetch('GET', BASE, []);
  const scopePath = scope
    ? `${BASE}/scope?scope_type=${scope.type}&scope_key=${encodeURIComponent(scope.key)}${allYears ? '' : `&year=${year}`}`
    : null;
  const view = useFetch('GET', scopePath, [scopePath]);
  // With no scope: the trips log and the latest notes across every market.
  const log = useFetch('GET', scope ? null : `${BASE}/visits`, [scope ? 'scoped' : 'all']);
  const latest = useFetch('GET', scope ? null : `${BASE}/notes?limit=30`, [scope ? 'scoped' : 'all']);

  const map = overview.data;
  const d = view.data;
  const { user } = useAuth();
  const canWrite = useHasRole('broker', 'admin');
  const canVerify = useHasRole('broker', 'underwriter', 'admin');
  const owns = (row) => !!user && (row.user_id === user.id || user.role === 'admin');
  const toast = useToast();

  const headTag = scope
    ? (d?.scope ? `${d.scope.label}${d.scope.type === 'country' && d.scope.region ? ` · ${d.scope.region}` : ''}` : scope.key)
    : 'All markets';
  useScreenHead('Placement diary', 'Market intelligence', headTag);

  const regions = map?.regions || [];
  const regionOfCountry = (code) => regions.find((r) => r.countries.some((c) => c.code === code))?.region || '';
  const pick = ({ region = '', country = '' }) => {
    const next = new URLSearchParams();
    if (region) next.set('region', region);
    if (country) next.set('country', country);
    setParams(next);
  };
  const currentRegion = regionParam || (countryParam ? regionOfCountry(countryParam) : '');
  const countryChoices = currentRegion ? (regions.find((r) => r.region === currentRegion)?.countries || []) : [];

  const refresh = () => { view.reload(); overview.reload(); log.reload(); latest.reload(); };

  // ---- the brief ----
  const [gatherBusy, setGatherBusy] = useState(false);
  const [gatherError, setGatherError] = useState(null);
  useEffect(() => { setGatherError(null); }, [scopePath]);
  async function gather() {
    if (!d) return;
    setGatherBusy(true);
    setGatherError(null);
    try {
      const r = await api('POST', `${BASE}/brief/gather`, { scope_type: d.scope.type, scope_key: d.scope.key });
      toast(`Brief gathered for ${r.scope.label} — ${plural(r.brief.notes_used, 'note')} and ${plural(r.brief.visits_used, 'trip')} folded in. Check it before relying on it.`);
      refresh();
    } catch (e) {
      setGatherError(e);
    } finally {
      setGatherBusy(false);
    }
  }
  async function verify() {
    try {
      await api('POST', `${BASE}/brief/${d.brief.id}/verify`);
      toast('Brief marked verified.');
      refresh();
    } catch (e) {
      setGatherError(e);
    }
  }

  const cedants = map?.cedants || [];
  const scopeCodes = useMemo(() => new Set((d?.scope?.countries || []).map((c) => c.code)), [d]);
  const visits = scope ? (d?.visits || []) : (log.data?.visits || []);
  const roi = scope ? d?.roi : log.data?.roi;
  const notes = scope ? (d?.notes || []) : (latest.data || []);
  const s = d?.book?.summary;
  const noteCounts = LEVELS.map((l) => [l.label, notes.filter((n) => n.level === l.value).length]).filter(([, n]) => n);

  return (
    <div className="screen">
      <ErrorBanner error={overview.error || view.error} />

      <div className="sechead pi-scoperow">
        <span className="pi-scope">
          A market by country or region: our book there, the brief the AI gathers from the internet — market
          dynamics, cedants, regulatory change — and the desk&rsquo;s own market visits and notes, which the
          next gather folds in. {allYears ? 'All treaty years' : `The ${yearLabel(year)} treaty year`} (top bar)
          narrows the book table alone; a trip&rsquo;s return reads across years.
        </span>
        <div className="sechead-actions">
          <Link className="btn btn-secondary btn-sm" to="/portfolio">← Portfolio intelligence</Link>
          <Link className="btn btn-secondary btn-sm" to="/portfolio/programmes">Analyse programmes →</Link>
        </div>
      </div>

      {/* ---- Which market ---- */}
      <Blueprint>
        <div className="mi-pickers">
          <label className="field">
            <span>Region</span>
            <select className="input" value={currentRegion} data-testid="mi-region" aria-label="Region" onChange={(e) => pick({ region: e.target.value })}>
              <option value="">All markets — the map</option>
              {regions.map((r) => <option key={r.region} value={r.region}>{r.region}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Country</span>
            <select
              className="input"
              value={countryParam}
              data-testid="mi-country"
              aria-label="Country"
              onChange={(e) => pick({ region: e.target.value ? regionOfCountry(e.target.value) : currentRegion, country: e.target.value })}
            >
              <option value="">{currentRegion ? `Whole region — ${currentRegion}` : 'Pick a region first, or a country'}</option>
              {currentRegion
                ? countryChoices.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)
                : <CountryOptions regions={regions} />}
            </select>
          </label>
          <span className="mi-pickers-note">
            {map
              ? `${plural(map.totals.accounts, 'account')} on the book across ${regions.filter((r) => r.accounts).length} regions · ${plural(map.totals.visits, 'trip')} logged · ${plural(map.totals.notes, 'note')} kept · ${plural(map.totals.briefs, 'brief')} gathered`
                + (map.totals.accounts_unresolved ? ` · ${map.totals.accounts_unresolved} with a cedant country not on the list` : '')
              : 'Loading the map…'}
          </span>
        </div>
      </Blueprint>

      {/* ---- The map, when no market is chosen ---- */}
      {!scope && <MapTable regions={regions} loading={!map && !overview.error} onPick={pick} />}

      {/* ---- The market ---- */}
      {scope && d && (
        <>
          <div className="kpis mi-kpis">
            <Kpi label="Accounts on the book" value={String(s.accounts)}
              sub={[plural(s.cedants, 'cedant'), allYears ? 'all treaty years' : `${yearLabel(year)} treaty year`].join(' · ')} />
            <Kpi label="Brokerage expected" value={fmtCompact(s.brokerage_expected.total)}
              sub={s.brokerage_expected.total ? `${currencyNote(s.brokerage_expected)} on our order at the layers' rates` : 'no brokerage rate on a layer yet'} />
            <Kpi label="Market visits" value={String(visits.length)} testid="mi-kpi-trips"
              sub={visits.length ? `cost ${currencyNote(roi.cost, 'nothing recorded')}` : 'no trip logged yet'} />
            <Kpi label="Return attributed" value={fmtCompact(roi.return.total)} testid="mi-kpi-return"
              sub={roi.return.total ? `${currencyNote(roi.return)} on ${plural(roi.accounts, 'account')} in the year after a trip` : 'no account in the year after a trip'} />
            <Kpi label="Return on visits" testid="mi-kpi-roi"
              value={roi.by_currency.length === 1 ? signedPct(roi.by_currency[0].roi_pct) : roi.by_currency.length ? 'by ccy' : '—'}
              sub={roi.by_currency.length
                ? roi.by_currency.map((r) => `${r.currency} ${signedPct(r.roi_pct)}`).join(' · ')
                : 'brokerage attributed against what the trips cost'} />
            <Kpi label="Notes" value={String(notes.length)}
              sub={noteCounts.length ? noteCounts.map(([l, n]) => `${n} on a ${l.toLowerCase()}`).join(' · ') : 'none kept yet'} />
          </div>

          <BriefPanel d={d} canWrite={canWrite} canVerify={canVerify} busy={gatherBusy} error={gatherError} onGather={gather} onVerify={verify} />

          <BookPanel d={d} allYears={allYears} year={year} />
        </>
      )}
      {scope && !d && !view.error && <p className="muted">Loading {scope.key}…</p>}

      {/* ---- The desk: trips and notes ---- */}
      <div className="mi-two">
        <VisitsPanel
          title={scope ? `Market visits — ${d?.scope?.label || scope.key}` : 'Market visits — every trip logged'}
          visits={visits}
          roi={roi}
          loading={scope ? !d : !log.data}
          scope={d?.scope || null}
          regions={regions}
          cedants={cedants}
          canWrite={canWrite}
          owns={owns}
          onChanged={refresh}
          attributionMonths={map?.attribution_months || 12}
        />
        <NotesPanel
          title={scope ? `Notes — ${d?.scope?.label || scope.key}` : 'Notes — the latest across every market'}
          notes={notes}
          loading={scope ? !d : !latest.data}
          scope={d?.scope || null}
          regions={regions}
          cedants={scope ? cedants.filter((c) => c.country_code && scopeCodes.has(c.country_code)) : cedants}
          visits={visits}
          canWrite={canWrite}
          owns={owns}
          onChanged={refresh}
        />
      </div>
    </div>
  );
}

/* ═══ The map ═══ */

function MapTable({ regions, loading, onPick }) {
  const [showAll, setShowAll] = useState(false);
  const active = (x) => x.accounts || x.cedants || x.visits || x.notes || x.brief;
  const briefCell = (b) => (b
    ? <span className="mi-nowrap">{fmtDate(b.gathered_at, { shortYear: true })} <span className="muted small">· {b.verified ? 'verified' : 'unverified'}</span></span>
    : <span className="muted">—</span>);
  return (
    <section>
      <div className="sechead">
        <SectionLabel>The map — every market, with what the desk holds on it</SectionLabel>
        <span className="hint">click a region or a country to open it</span>
      </div>
      <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
        <table className="table mi-map" data-testid="mi-map">
          <thead>
            <tr>
              <th>Market</th>
              <th className="r">Accounts on the book</th>
              <th className="r">Cedants on the book</th>
              <th className="r">Cedants on the register</th>
              <th className="r">Trips</th>
              <th className="r">Notes</th>
              <th>Brief gathered</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <React.Fragment key={r.region}>
                <tr className="is-region is-pick" onClick={() => onPick({ region: r.region })}>
                  <td>{r.region}</td>
                  <td className="r">{r.accounts || <span className="muted">—</span>}</td>
                  <td className="r">{r.cedants_on_book || <span className="muted">—</span>}</td>
                  <td className="r">{r.cedants || <span className="muted">—</span>}</td>
                  <td className="r">{r.visits || <span className="muted">—</span>}</td>
                  <td className="r">{r.notes || <span className="muted">—</span>}</td>
                  <td>{briefCell(r.brief)}</td>
                </tr>
                {r.countries.filter((c) => showAll || active(c)).map((c) => (
                  <tr key={c.code} className="is-country is-pick" onClick={() => onPick({ region: r.region, country: c.code })}>
                    <td>{c.name}</td>
                    <td className="r">{c.accounts || <span className="muted">—</span>}</td>
                    <td className="r">{c.cedants_on_book || <span className="muted">—</span>}</td>
                    <td className="r">{c.cedants || <span className="muted">—</span>}</td>
                    <td className="r">{c.visits || <span className="muted">—</span>}</td>
                    <td className="r">{c.notes || <span className="muted">—</span>}</td>
                    <td>{briefCell(c.brief)}</td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
            {loading && <tr><td colSpan="7" className="muted">Loading…</td></tr>}
          </tbody>
        </table>
        <div className="mi-map-foot">
          <span>Countries with nothing on them yet are folded into their region.</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Fold quiet countries' : 'Show every country'}
          </button>
        </div>
      </Blueprint>
    </section>
  );
}

/* ═══ The brief ═══ */

function Section({ title, children }) {
  return (
    <div className="mi-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function ExtLink({ href, children }) {
  if (!href) return <>{children}</>;
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}

function BriefPanel({ d, canWrite, canVerify, busy, error, onGather, onVerify }) {
  const b = d.brief;
  const none = (what) => <p className="mi-empty">Nothing on {what} in this brief.</p>;
  return (
    <Blueprint className="viz-panel" data-testid="mi-brief">
      <div className="viz-head mi-brief-head">
        <span className="viz-title">Market brief — {d.scope.label}</span>
        {b && (
          <Pill tone={b.verified ? 'green' : 'gold'} className="mi-unverified">
            {b.verified ? `verified by ${b.verified_by_name || 'the desk'}` : 'gathered from the internet — unverified'}
          </Pill>
        )}
        {b && !b.verified && canVerify && (
          <button type="button" className="btn btn-secondary btn-sm" data-testid="mi-verify" onClick={onVerify}>Mark verified</button>
        )}
        {canWrite && (
          <button type="button" className="btn btn-primary btn-sm" data-testid="mi-gather" disabled={busy} onClick={onGather}>
            {busy ? 'Gathering…' : b ? 'Gather again' : 'Gather from internet'}
          </button>
        )}
      </div>
      <ErrorBanner error={error} />
      {!d.ai.configured && (
        <p className="viz-note">
          No AI provider is configured (set <code>OPENAI_API_KEY</code>) — a gather will fail rather than invent a market.
          Everything else on this screen works without it.
        </p>
      )}
      {!b && (
        <p className="mi-empty" data-testid="mi-brief-empty">
          No brief yet. Gather one from the internet: market dynamics, the cedants buying reinsurance here, regulatory
          changes, dated developments and what to do next — with the {plural(d.notes.length, 'note')} and
          {' '}{plural(d.visits.length, 'trip')} the desk holds on this market folded in.
        </p>
      )}
      {b && (
        <>
          <p className="mi-headline">{b.headline || <span className="muted">The gather returned no summary.</span>}</p>
          <p className="viz-note">
            Gathered {fmtStamp(b.gathered_at)} by {b.gathered_by_name || 'the desk'} with {providerLabel(b.provider)}
            {b.model ? ` (${b.model})` : ''}; {plural(b.notes_used, 'note')} and {plural(b.visits_used, 'trip')} folded in.
            {' '}Check it against its sources before relying on it — a rule or a programme read here drives nothing until it is confirmed.
          </p>
          <div className="mi-brief-grid">
            <Section title="Market dynamics">
              {b.market_dynamics.length ? (
                <ul className="mi-list">
                  {b.market_dynamics.map((m, i) => (
                    <li key={i} className="mi-item"><span className="mi-topic">{TOPIC_LABEL[m.topic] || m.topic}</span>{m.detail}</li>
                  ))}
                </ul>
              ) : none('the market\'s dynamics')}
            </Section>
            <Section title="Regulatory changes">
              {b.regulatory.length ? (
                <ul className="mi-list">
                  {b.regulatory.map((r, i) => (
                    <li key={i} className="mi-item">
                      <span className="mi-item-head"><ExtLink href={r.url}>{r.headline}</ExtLink></span>
                      {(r.regulator || r.effective_date) && (
                        <span className="mi-item-meta">{[r.regulator, r.effective_date && `effective ${fmtDate(r.effective_date)}`].filter(Boolean).join(' · ')}</span>
                      )}
                      {r.summary && <div>{r.summary}</div>}
                    </li>
                  ))}
                </ul>
              ) : none('regulation')}
            </Section>
            <Section title="Cedants in the market">
              {b.cedants.length ? (
                <ul className="mi-list">
                  {b.cedants.map((c, i) => (
                    <li key={i} className="mi-item">
                      <span className="mi-item-head"><ExtLink href={c.url}>{c.name}</ExtLink></span>
                      {c.overview && <div>{c.overview}</div>}
                      {c.reinsurance && <div className="muted small">Reinsurance: {c.reinsurance}</div>}
                    </li>
                  ))}
                </ul>
              ) : none('the cedants')}
            </Section>
            <Section title="Developments">
              {b.developments.length ? (
                <ul className="mi-list">
                  {b.developments.map((n, i) => (
                    <li key={i} className="mi-item">
                      <span className="mi-item-head"><ExtLink href={n.url}>{n.headline}</ExtLink></span>
                      {n.published_at && <span className="mi-item-meta">{fmtDate(n.published_at)}</span>}
                      {n.summary && <div>{n.summary}</div>}
                    </li>
                  ))}
                </ul>
              ) : none('recent developments')}
            </Section>
            <Section title="What to do next">
              {b.opportunities.length ? (
                <ul className="mi-list">
                  {b.opportunities.map((o, i) => (
                    <li key={i} className="mi-item">
                      <span className="mi-item-head">{o.title}</span>
                      {o.rationale && <div>{o.rationale}</div>}
                    </li>
                  ))}
                </ul>
              ) : none('what to do next')}
            </Section>
            <Section title="From the desk">
              {b.from_the_desk
                ? <p className="mi-desk">{b.from_the_desk}</p>
                : <p className="mi-empty">No notes or trips were on file for this market when the brief was gathered.</p>}
            </Section>
          </div>
          {b.citations.length > 0 && (
            <div className="mi-sources">
              Sources: {b.citations.map((c, i) => (
                <span key={i}>{i > 0 && ' · '}<ExtLink href={c.url}>{c.title || c.url}</ExtLink></span>
              ))}
            </div>
          )}
        </>
      )}
    </Blueprint>
  );
}

/* ═══ Our book in the market ═══ */

function BookPanel({ d, allYears, year }) {
  const accounts = d.book.accounts;
  return (
    <section>
      <div className="sechead">
        <SectionLabel>Our book in {d.scope.label}{accounts.length ? ` · ${accounts.length}` : ''}</SectionLabel>
        <span className="hint">
          the accounts whose cedant is domiciled here, as Portfolio intelligence reads them
          {allYears ? '' : ` — ${yearLabel(year)} treaty year`}
        </span>
      </div>
      <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
        <table className="table pi-table" data-testid="mi-book">
          <thead>
            <tr>
              <th>Incepts</th>
              <th>Reference</th>
              <th>Cedant</th>
              <th>Country</th>
              <th>Class of business</th>
              <th>Our role</th>
              <th>Lead reinsurer</th>
              <th className="r">Premium (100%)</th>
              <th className="r">Brokerage expected</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td className="mono pi-nowrap" style={{ fontSize: 12.5 }}>{fmtDate(a.inception, { shortYear: true })}</td>
                <td><Link className="refbtn" to={`/placements/${a.id}`}>{a.reference}</Link></td>
                <td>{a.cedant_name}</td>
                <td>{a.country_name || a.cedant_country || '—'}</td>
                <td style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>{a.class}</td>
                <td>{a.broker_role ? <Pill tone={a.broker_role === 'Lead' ? 'green' : 'blue'}>{a.broker_role}</Pill> : <span className="muted">—</span>}</td>
                <td>{a.lead_reinsurer || <span className="muted">not yet led</span>}</td>
                <td className="r">{a.total_premium100 ? money(a.currency, a.total_premium100) : <span className="muted">—</span>}</td>
                <td className="r">{a.brokerage_expected ? money(a.currency, a.brokerage_expected) : <span className="muted">—</span>}</td>
                <td><StatusPill value={a.status} /></td>
              </tr>
            ))}
            {!accounts.length && (
              <tr><td colSpan="10" className="muted">Nothing on the book in {d.scope.label}{allYears ? '' : ' this treaty year'}.</td></tr>
            )}
          </tbody>
        </table>
      </Blueprint>
    </section>
  );
}

/* ═══ Market visits ═══ */

function VisitsPanel({ title, visits, roi, loading, scope, regions, cedants, canWrite, owns, onChanged, attributionMonths }) {
  const [editing, setEditing] = useState(null);   // null | 'new' | a visit
  const [error, setError] = useState(null);
  const toast = useToast();
  useEffect(() => { setEditing(null); }, [scope?.type, scope?.key]);

  async function save(body) {
    setError(null);
    if (editing && editing !== 'new') {
      await api('PATCH', `${BASE}/visits/${editing.id}`, body);
      toast('Trip updated.');
    } else {
      const v = await api('POST', `${BASE}/visits`, body);
      toast(`Trip to ${v.country_name} logged.`);
    }
    setEditing(null);
    onChanged();
  }
  async function remove(v) {
    const extra = v.notes_count ? ` and the ${plural(v.notes_count, 'note')} taken on it` : '';
    if (!window.confirm(`Delete the trip to ${v.country_name} (${fmtDate(v.start_date)})${extra}?`)) return;
    setError(null);
    try {
      await api('DELETE', `${BASE}/visits/${v.id}`);
      toast('Trip deleted.');
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  const defaultCountry = scope?.type === 'country' ? scope.key : (scope?.countries?.[0]?.code || '');
  return (
    <section data-testid="mi-visits">
      <div className="sechead">
        <SectionLabel>{title}{visits.length ? ` · ${visits.length}` : ''}</SectionLabel>
        <span className="hint">every broker&rsquo;s trips — where, when, what it cost, whom they met — and what came back</span>
        {canWrite && editing === null && (
          <div className="sechead-actions">
            <button type="button" className="btn btn-primary btn-sm" data-testid="mi-add-trip" onClick={() => setEditing('new')}>Log a trip</button>
          </div>
        )}
      </div>
      <Blueprint style={{ marginTop: 10 }}>
        <ErrorBanner error={error} />
        {roi && roi.trips > 0 && (
          <p className="mi-roi-note">
            {plural(roi.trips, 'trip')} costing {currencyNote(roi.cost, 'nothing recorded')}; {plural(roi.accounts, 'account')} credited,
            worth {currencyNote(roi.return, 'nothing yet')} in brokerage expected.
            {' '}{roi.by_currency.map((r) => `${r.currency}: ${r.roi_pct == null ? (r.return ? '—' : 'no ratio — the return is in another currency') : signedPct(r.roi_pct)}`).join(' · ')}.
          </p>
        )}
        <div className="table-wrap">
          <table className="table pi-table">
            <thead>
              <tr>
                <th>Broker</th>
                <th>Where</th>
                <th>When</th>
                <th>Purpose</th>
                <th>Cedants met</th>
                <th className="r">Cost</th>
                <th className="r">Return</th>
                <th className="r">ROI</th>
                <th className="r">Notes</th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.id}>
                  <td>{v.broker_name}</td>
                  <td>{v.country_name}{v.city ? <span className="mi-sub">{v.city}</span> : null}</td>
                  <td className="pi-nowrap">
                    {fmtDate(v.start_date, { shortYear: true })}
                    {v.end_date !== v.start_date && <span className="mi-sub">to {fmtDate(v.end_date, { shortYear: true })}</span>}
                  </td>
                  <td style={{ fontSize: 13 }}>{v.purpose || <span className="muted">—</span>}</td>
                  <td style={{ fontSize: 13 }}>
                    {v.cedants.length ? v.cedants.map((c) => c.name).join(', ') : <span className="muted">none named — the whole country counts</span>}
                  </td>
                  <td className="r pi-nowrap">{v.cost_amount ? money(v.cost_currency, v.cost_amount) : <span className="muted">—</span>}</td>
                  <td className="r pi-nowrap" title={v.attributed.map((a) => `${a.reference} · ${a.cedant_name} · ${money(a.currency, a.brokerage_expected)}`).join('\n')}>
                    {v.roi.return.total
                      ? <><MoneyCell money={v.roi.return} /><span className="mi-sub">{plural(v.roi.accounts, 'account')}</span></>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="r pi-nowrap">
                    {v.roi.roi_pct != null
                      ? <span className="num">{signedPct(v.roi.roi_pct)}</span>
                      : <span className="muted" title={Object.keys(v.roi.unconverted).length ? 'the return is in another currency and the book holds no FX rate' : 'no cost recorded'}>—</span>}
                  </td>
                  <td className="r">{v.notes_count || <span className="muted">—</span>}</td>
                  {canWrite && (
                    <td>
                      {owns(v) && (
                        <span className="mi-actions">
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(v)}>Edit</button>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(v)}>Delete</button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {!visits.length && !loading && (
                <tr><td colSpan={canWrite ? 10 : 9} className="muted">No trip logged{scope ? ` for ${scope.label}` : ''} yet.</td></tr>
              )}
              {loading && <tr><td colSpan={canWrite ? 10 : 9} className="muted">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="mi-roi-note">
          A trip&rsquo;s return is the brokerage the book expects — our order at the layers&rsquo; rates — on the accounts of
          the cedants met, or of every cedant in the country when none is named, incepting from the trip&rsquo;s first day
          to {attributionMonths} months after its last. The ratio is read in the cost&rsquo;s currency only: the book holds no
          FX rates, so a return in another currency is shown beside it, unconverted.
        </p>
        {canWrite && editing !== null && (
          <VisitForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? null : editing}
            defaultCountry={defaultCountry}
            regions={regions}
            cedants={cedants}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        )}
      </Blueprint>
    </section>
  );
}

function VisitForm({ initial, defaultCountry, regions, cedants, onSubmit, onCancel }) {
  const ref = useRefData();
  const currencies = ref.currencies?.length ? ref.currencies.map((c) => c.code || c.name) : FALLBACK_CURRENCIES;
  const [f, setF] = useState(() => ({
    country_code: initial?.country_code || defaultCountry || '',
    city: initial?.city || '',
    purpose: initial?.purpose || '',
    start_date: initial?.start_date || today(),
    end_date: initial?.end_date || today(),
    cost_amount: initial ? String(initial.cost_amount ?? '') : '',
    cost_currency: initial?.cost_currency || (currencies.includes('USD') ? 'USD' : currencies[0]),
    cedant_ids: initial ? initial.cedants.map((c) => c.id) : [],
    notes: initial?.notes || '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const inCountry = cedants.filter((c) => c.country_code === f.country_code);
  const toggleCedant = (id) => set('cedant_ids', f.cedant_ids.includes(id) ? f.cedant_ids.filter((x) => x !== id) : [...f.cedant_ids, id]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        country_code: f.country_code,
        city: f.city || undefined,
        purpose: f.purpose || undefined,
        start_date: f.start_date,
        end_date: f.end_date || f.start_date,
        cost_amount: f.cost_amount === '' ? 0 : Number(f.cost_amount),
        cost_currency: f.cost_currency,
        cedant_ids: f.cedant_ids,
        notes: f.notes || undefined,
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mi-form" onSubmit={submit} data-testid="mi-visit-form">
      <p className="mi-form-title">{initial ? 'Correct the trip' : 'Log a trip'}</p>
      <label className="field">
        <span>Country *</span>
        <select className="input" required value={f.country_code} onChange={(e) => { set('country_code', e.target.value); set('cedant_ids', []); }}>
          <option value="">—</option>
          <CountryOptions regions={regions} />
        </select>
      </label>
      <label className="field"><span>City</span><input className="input" value={f.city} onChange={(e) => set('city', e.target.value)} placeholder="London" /></label>
      <label className="field"><span>From *</span><input className="input" type="date" required value={f.start_date} onChange={(e) => set('start_date', e.target.value)} /></label>
      <label className="field"><span>To *</span><input className="input" type="date" required value={f.end_date} min={f.start_date} onChange={(e) => set('end_date', e.target.value)} /></label>
      <label className="field"><span>Cost</span><input className="input" type="number" min="0" step="0.01" value={f.cost_amount} onChange={(e) => set('cost_amount', e.target.value)} placeholder="flights, hotels, entertainment" /></label>
      <label className="field">
        <span>Currency</span>
        <select className="input" value={f.cost_currency} onChange={(e) => set('cost_currency', e.target.value)}>
          {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="field mi-wide"><span>Purpose</span><input className="input" value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="Renewal roadshow, new-business prospecting, a conference…" /></label>
      <div className="field mi-wide">
        <span>Cedants met — the accounts the trip is credited with; none named means the whole country counts</span>
        {inCountry.length ? (
          <div className="mi-cedant-pick">
            {inCountry.map((c) => (
              <label key={c.id}>
                <input type="checkbox" checked={f.cedant_ids.includes(c.id)} onChange={() => toggleCedant(c.id)} />
                {c.name}
              </label>
            ))}
          </div>
        ) : <span className="muted small">{f.country_code ? 'No cedant on the register in this country yet.' : 'Pick the country first.'}</span>}
      </div>
      <label className="field mi-wide"><span>Trip report</span><textarea className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="What was said, what was promised, what to follow up." /></label>
      <div className="mi-form-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save trip' : 'Log trip'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <span className="hint">Logged as you, the signed-in broker.</span>
      </div>
      <div className="mi-wide"><ErrorBanner error={error} /></div>
    </form>
  );
}

/* ═══ Notes ═══ */

function NotesPanel({ title, notes, loading, scope, regions, cedants, visits, canWrite, owns, onChanged }) {
  const [editing, setEditing] = useState(null);   // null | 'new' | a note
  const [levelFilter, setLevelFilter] = useState('');
  const [error, setError] = useState(null);
  const toast = useToast();
  useEffect(() => { setEditing(null); setLevelFilter(''); }, [scope?.type, scope?.key]);

  async function save(body) {
    setError(null);
    if (editing && editing !== 'new') {
      await api('PATCH', `${BASE}/notes/${editing.id}`, body);
      toast('Note updated.');
    } else {
      const n = await api('POST', `${BASE}/notes`, body);
      toast(`Note kept on ${subjectOf(n)}.`);
    }
    setEditing(null);
    onChanged();
  }
  async function remove(n) {
    if (!window.confirm(`Delete this note on ${subjectOf(n)}?`)) return;
    setError(null);
    try {
      await api('DELETE', `${BASE}/notes/${n.id}`);
      toast('Note deleted.');
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  const shown = levelFilter ? notes.filter((n) => n.level === levelFilter) : notes;
  return (
    <section data-testid="mi-notes">
      <div className="sechead">
        <SectionLabel>{title}{notes.length ? ` · ${notes.length}` : ''}</SectionLabel>
        <span className="hint">by cedant, country or region — typed or uploaded — folded into the next gather</span>
        {canWrite && editing === null && (
          <div className="sechead-actions">
            <button type="button" className="btn btn-primary btn-sm" data-testid="mi-add-note" onClick={() => setEditing('new')}>Add a note</button>
          </div>
        )}
      </div>
      <Blueprint style={{ marginTop: 10 }}>
        <ErrorBanner error={error} />
        <div className="filterbar">
          <select className="input" value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)} aria-label="Filter notes by level">
            <option value="">All levels</option>
            {LEVELS.map((l) => <option key={l.value} value={l.value}>On a {l.label.toLowerCase()}</option>)}
          </select>
          <span className="filterbar-meta">{notes.length ? `${shown.length} of ${plural(notes.length, 'note')}` : ''}</span>
        </div>
        <div className="mi-notes">
          {shown.map((n) => (
            <article key={n.id} className="mi-note">
              <div className="mi-note-head">
                <Pill tone={n.level === 'cedant' ? 'green' : n.level === 'country' ? 'blue' : 'gold'} className="mi-level">{n.level}</Pill>
                <strong>{subjectOf(n)}</strong>
                {n.level === 'cedant' && n.country_name && <span>· {n.country_name}</span>}
                {n.level !== 'region' && n.region && <span>· {n.region}</span>}
                <span className="mi-note-who">{fmtDate(n.noted_on)} · {n.author_name}</span>
              </div>
              {n.title && <div className="mi-note-title">{n.title}</div>}
              <div className="mi-note-body">{n.body}</div>
              <div className="mi-note-foot">
                {n.visit_id && <span>On the trip to {n.visit_country_name || '—'}{n.visit_start_date ? `, ${fmtDate(n.visit_start_date)}` : ''}{n.visit_purpose ? ` — ${n.visit_purpose}` : ''}</span>}
                {n.attachment_name && <span>Read from {n.attachment_name}</span>}
                {canWrite && owns(n) && (
                  <span className="mi-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(n)}>Edit</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(n)}>Delete</button>
                  </span>
                )}
              </div>
            </article>
          ))}
          {!shown.length && !loading && (
            <p className="muted" style={{ margin: 0 }}>
              {notes.length ? 'No note at this level.' : `No note kept${scope ? ` on ${scope.label}` : ''} yet.`}
            </p>
          )}
          {loading && <p className="muted" style={{ margin: 0 }}>Loading…</p>}
        </div>
        {canWrite && editing !== null && (
          <NoteForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? null : editing}
            scope={scope}
            regions={regions}
            cedants={cedants}
            visits={visits}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        )}
      </Blueprint>
    </section>
  );
}

const subjectOf = (n) => (n.level === 'cedant' ? n.cedant_name : n.level === 'country' ? n.country_name : n.region) || '—';

function NoteForm({ initial, scope, regions, cedants, visits, onSubmit, onCancel }) {
  const [f, setF] = useState(() => ({
    level: initial?.level || (scope?.type === 'region' ? 'region' : cedants.length ? 'cedant' : scope ? 'country' : 'cedant'),
    cedant_id: initial?.cedant_id || '',
    country_code: initial?.country_code || (scope?.type === 'country' ? scope.key : ''),
    region: initial?.region || scope?.region || '',
    visit_id: initial?.visit_id || '',
    noted_on: initial?.noted_on || today(),
    title: initial?.title || '',
    body: initial?.body || '',
  }));
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const editing = !!initial;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const upload = file ? await readFile(file) : undefined;
      const body = {
        visit_id: f.visit_id || null,
        noted_on: f.noted_on,
        title: f.title || undefined,
        body: f.body || undefined,
        file: upload,
      };
      if (!editing) {
        Object.assign(body, {
          level: f.level,
          cedant_id: f.level === 'cedant' ? f.cedant_id : undefined,
          country_code: f.level === 'country' ? f.country_code : undefined,
          region: f.level === 'region' ? f.region : undefined,
        });
      }
      await onSubmit(body);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mi-form" onSubmit={submit} data-testid="mi-note-form">
      <p className="mi-form-title">{editing ? `Amend the note on ${subjectOf(initial)}` : 'Add a note'}</p>
      {!editing && (
        <>
          <label className="field">
            <span>On a *</span>
            <select className="input" value={f.level} onChange={(e) => set('level', e.target.value)} aria-label="Note level">
              {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </label>
          {f.level === 'cedant' && (
            <label className="field">
              <span>Cedant *</span>
              <select className="input" required value={f.cedant_id} onChange={(e) => set('cedant_id', e.target.value)} aria-label="Cedant">
                <option value="">—</option>
                {cedants.map((c) => <option key={c.id} value={c.id}>{c.name}{c.country_name ? ` — ${c.country_name}` : ''}</option>)}
              </select>
            </label>
          )}
          {f.level === 'country' && (
            <label className="field">
              <span>Country *</span>
              <select className="input" required value={f.country_code} onChange={(e) => set('country_code', e.target.value)} aria-label="Note country">
                <option value="">—</option>
                <CountryOptions regions={regions} />
              </select>
            </label>
          )}
          {f.level === 'region' && (
            <label className="field">
              <span>Region *</span>
              <select className="input" required value={f.region} onChange={(e) => set('region', e.target.value)} aria-label="Note region">
                <option value="">—</option>
                {regions.map((r) => <option key={r.region} value={r.region}>{r.region}</option>)}
              </select>
            </label>
          )}
        </>
      )}
      <label className="field">
        <span>On a trip</span>
        <select className="input" value={f.visit_id} onChange={(e) => set('visit_id', e.target.value)} aria-label="Trip">
          <option value="">Not on a trip</option>
          {visits.map((v) => <option key={v.id} value={v.id}>{v.country_name}, {fmtDate(v.start_date, { shortYear: true })} — {v.broker_name}{v.purpose ? ` — ${v.purpose}` : ''}</option>)}
        </select>
      </label>
      <label className="field"><span>Date *</span><input className="input" type="date" required value={f.noted_on} onChange={(e) => set('noted_on', e.target.value)} /></label>
      <label className="field"><span>Title</span><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Retention, appetite, who to call…" /></label>
      <label className="field mi-wide">
        <span>Note {file ? '(the file\'s text is added below what you type)' : ''}</span>
        <textarea className="input" value={f.body} onChange={(e) => set('body', e.target.value)} placeholder="What you learnt — the programme, the people, the appetite, the market." aria-label="Note text" />
      </label>
      <label className="field mi-wide mi-file">
        <span>Or upload notes — a .txt, .md or .pdf file, read into the note</span>
        <input type="file" accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </label>
      <div className="mi-form-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save note' : 'Keep note'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
        <span className="hint">Kept as you, the signed-in broker. A cedant note counts for its country and region too.</span>
      </div>
      <div className="mi-wide"><ErrorBanner error={error} /></div>
    </form>
  );
}
