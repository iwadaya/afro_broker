import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  useFetch, Blueprint, SectionLabel, StatusPill, Pill, ErrorBanner,
  fmtCompact, fmtDate, fmtPct,
} from '../components.jsx';
import { useScreenHead } from '../shell.jsx';
import { ALL_YEARS, useTreatyYear, yearLabel } from '../treatyYear.js';
import { currencyNote, MoneyCell } from './PortfolioIntelligence.jsx';
import { HBars, Columns, Meters, Grid, Legend, Figures, seriesColor } from './portfolio/charts.jsx';

/**
 * Programme analysis — behind the "Analyse programmes" button on Portfolio
 * intelligence: the same book, cut by the house placing each programme and
 * the reinsurers writing it, and drawn.
 *
 * Everything comes from /dashboards/portfolio/programmes, computed from the
 * placement book on each call by the same reading the portfolio screen uses
 * (our role from the order or Final Placement, the lines from the layer
 * ledger and Final Placement). The treaty year in the top bar scopes it. A
 * programme is an account with an order to read — a layer, or a Final
 * Placement recording who leads it.
 *
 * One measure toggle, above everything, scopes every chart at once: how many
 * programmes, or the premium behind them. Clicking a broker, a reinsurer or a
 * cell of the grid narrows the programme table underneath to that slice.
 */

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const brokerLabel = (b) => b.name || 'Another house — not yet named';
const fmtCount = (n) => String(Math.round(n));

const MEASURES = [
  { value: 'count', label: 'Programmes' },
  { value: 'premium', label: 'Premium (100%)' },
];

/** The role a reinsurer holds on a programme — lead, follow, or no approach on record. */
const ROLES = [
  { key: 'lead', label: 'Lead', color: seriesColor(0) },
  { key: 'follow', label: 'Follow', color: seriesColor(1) },
  { key: 'unroled', label: 'Role not recorded', color: seriesColor(null) },
];

const TOP_REINSURERS = 10;
const GRID_REINSURERS = 12;
const CLASS_SLOTS = 6;

function Kpi({ label, value, sub }) {
  return (
    <Blueprint className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
    </Blueprint>
  );
}

function Panel({ title, legend, note, loading, children, testid }) {
  return (
    <Blueprint className={`viz-panel${loading ? ' is-loading' : ''}`} data-testid={testid}>
      <div className="viz-head">
        <span className="viz-title">{title}</span>
        {legend}
      </div>
      {children}
      {note && <p className="viz-note">{note}</p>}
    </Blueprint>
  );
}

export default function ProgrammeAnalysis() {
  const [year] = useTreatyYear();
  const allYears = year === ALL_YEARS;
  const scopeLabel = allYears ? 'All treaty years' : `${yearLabel(year)} treaty year`;
  useScreenHead('Placement diary', 'Programme analysis', scopeLabel);
  const navigate = useNavigate();

  const path = allYears ? '/dashboards/portfolio/programmes' : `/dashboards/portfolio/programmes?year=${year}`;
  const req = useFetch('GET', path, [path]);
  const d = req.data;
  const s = d?.summary;
  // On a re-scope the last picture holds, dimmed, until the new one lands.
  const loading = req.loading && !!d;
  const waiting = !d && !req.error;

  const [measure, setMeasure] = useState('count');
  const [sel, setSel] = useState({ broker: null, reinsurer: null });
  const byPremium = measure === 'premium';
  const fmt = byPremium ? fmtCompact : fmtCount;
  const measureNoun = byPremium ? 'premium (100%)' : 'programmes';

  const brokers = d?.brokers || [];
  const reinsurers = d?.reinsurers || [];
  const classes = d?.classes || [];
  const years = d?.years || [];
  const programmes = d?.programmes || [];
  const conc = s?.concentration || null;

  // The book's six biggest classes take the six hues, in one fixed order for
  // every chart on the screen; the rest fold into "Other". Colour follows the
  // class, never its rank within a bar.
  const classSlots = useMemo(() => {
    const m = new Map();
    classes.slice(0, CLASS_SLOTS).forEach((c, i) => m.set(c.class, i));
    return m;
  }, [classes]);
  const otherClasses = Math.max(0, classes.length - CLASS_SLOTS);
  const classLegend = [
    ...classes.slice(0, CLASS_SLOTS).map((c, i) => ({ label: c.class, color: seriesColor(i) })),
    ...(otherClasses ? [{ label: `Other — ${plural(otherClasses, 'class', 'classes')}`, color: seriesColor(null) }] : []),
  ];

  // ---- by broker ----
  const brokerRows = brokers.map((b) => {
    const segs = new Map();
    for (const c of b.classes) {
      const key = classSlots.has(c.class) ? c.class : '__other__';
      segs.set(key, (segs.get(key) || 0) + (byPremium ? c.premium.total : c.programmes));
    }
    const order = [...classes.slice(0, CLASS_SLOTS).map((c) => c.class), '__other__'].filter((k) => segs.has(k));
    return {
      key: b.key,
      label: brokerLabel(b),
      sub: b.is_house
        ? 'this desk · the whole order'
        : b.name
          ? `we follow · our order ${fmtPct(b.order_share_pct, 0)}`
          : 'we follow · lead house not yet named',
      total: byPremium ? b.premium.total : b.programmes,
      totalLabel: measureNoun,
      segments: order.map((k) => ({
        label: k === '__other__' ? 'Other classes' : k,
        value: segs.get(k),
        color: k === '__other__' ? seriesColor(null) : seriesColor(classSlots.get(k)),
      })),
    };
  });
  const orderRows = brokers.map((b) => ({
    key: b.key,
    label: brokerLabel(b),
    sub: `${plural(b.programmes, 'programme')} · ${currencyNote(b.premium, 'no layer premium yet')}`,
    pct: b.order_share_pct,
    value: fmtCompact(b.premium_order.total),
    valueLabel: 'our order',
    whole: fmtCompact(b.premium.total),
    wholeLabel: 'premium at 100%',
  }));

  // ---- by reinsurer ----
  const roleValue = (r, k) => (byPremium ? r[`premium_${k}`].total : r[`programmes_${k}`]);
  const anyUnroled = reinsurers.some((r) => r.programmes_unroled || r.premium_unroled.total);
  const roles = ROLES.filter((x) => x.key !== 'unroled' || anyUnroled);
  const topRe = reinsurers.slice(0, TOP_REINSURERS);
  const restRe = reinsurers.slice(TOP_REINSURERS);
  const reRows = topRe.map((r) => ({
    key: r.market_id,
    label: r.name,
    sub: [r.rating, r.region, r.programmes_led ? `leads ${r.programmes_led}` : null].filter(Boolean).join(' · ') || undefined,
    total: byPremium ? r.premium_on_lines.total : r.programmes,
    totalLabel: byPremium ? 'premium on its lines' : 'programmes',
    segments: roles.map((x) => ({ label: x.label, value: roleValue(r, x.key), color: x.color })),
  }));
  if (restRe.length) {
    reRows.push({
      key: '__other__',
      label: `Other — ${plural(restRe.length, 'reinsurer')}`,
      sub: 'the rest of the panel',
      selectable: false,
      total: restRe.reduce((n, r) => n + (byPremium ? r.premium_on_lines.total : r.programmes), 0),
      totalLabel: byPremium ? 'premium on their lines' : 'programmes',
      segments: roles.map((x) => ({ label: x.label, value: restRe.reduce((n, r) => n + roleValue(r, x.key), 0), color: x.color })),
    });
  }
  const roleLegend = roles.map((x) => ({ label: x.key === 'unroled' ? x.label : `${x.label} lines`, color: x.color }));

  const concRows = conc
    ? [1, 3, 5, 10]
      .filter((n, i, arr) => i === 0 || arr[i - 1] < conc.reinsurers)
      .map((n) => {
        const top = conc.curve.slice(0, n);
        return {
          key: `top${n}`,
          label: n === 1 ? 'The biggest writer' : `The biggest ${Math.min(n, conc.reinsurers)}`,
          sub: top.map((c) => c.name).join(', '),
          pct: top[top.length - 1].cumulative_pct,
          value: fmtCompact(top.reduce((sum, c) => sum + c.premium_on_lines, 0)),
          valueLabel: 'of the premium on lines',
          whole: fmtCompact(s.premium_on_lines.total),
          wholeLabel: 'premium on every line',
        };
      })
    : [];

  // ---- brokers × reinsurers ----
  const gridRows = reinsurers.slice(0, GRID_REINSURERS).map((r) => ({
    key: r.market_id,
    label: r.name,
    total: byPremium ? r.premium_on_lines.total : r.programmes,
    cells: r.brokers.map((b) => ({
      colKey: b.key,
      value: byPremium ? b.premium_on_lines.total : b.programmes,
      readout: {
        title: `${r.name} · ${brokerLabel(b)}`,
        rows: [
          { value: fmtCount(b.programmes), label: b.programmes === 1 ? 'programme' : 'programmes', strong: !byPremium },
          { value: fmtCount(b.lines), label: b.lines === 1 ? 'line' : 'lines' },
          { value: fmtCompact(b.premium_on_lines.total), label: 'premium on lines', strong: byPremium },
          ...(b.share_total ? [{ value: fmtPct(b.share_total, 1), label: 'written in all' }] : []),
        ],
      },
    })),
  }));
  const gridCols = brokers.map((b) => ({
    key: b.key,
    label: brokerLabel(b),
    total: byPremium ? b.premium_on_lines.total : b.programmes,
  }));

  // ---- over the treaty years ----
  const yearCounts = years.map((y) => ({
    key: y.year,
    label: String(y.year),
    total: y.programmes,
    totalLabel: 'programmes',
    segments: [
      { label: 'We lead', value: y.led, color: seriesColor(0) },
      { label: 'We follow', value: y.followed, color: seriesColor(1) },
    ],
  }));
  const yearPremium = years.map((y) => ({
    key: y.year,
    label: String(y.year),
    total: y.premium.total,
    totalLabel: 'premium (100%)',
    segments: [
      { label: 'Our order', value: y.premium_order.total, color: seriesColor(0) },
      { label: 'Placed by the lead house', value: Math.max(0, y.premium.total - y.premium_order.total), color: seriesColor(null) },
    ],
  }));

  // ---- the programmes, narrowed by what was clicked ----
  const filtered = programmes.filter((p) => (
    (!sel.broker || p.broker_key === sel.broker)
    && (!sel.reinsurer || p.panel.some((m) => m.market_id === sel.reinsurer))
  ));
  const selBroker = sel.broker ? brokers.find((b) => b.key === sel.broker) : null;
  const selReinsurer = sel.reinsurer ? reinsurers.find((r) => r.market_id === sel.reinsurer) : null;
  const openProgramme = (p) => navigate(`/contracts/${p.id}`);

  const otherHouses = brokers.filter((b) => b.name && !b.is_house).length;

  return (
    <div className="screen pa-screen">
      <ErrorBanner error={req.error} />

      <div className="sechead pi-scoperow">
        <span className="pi-scope">
          {scopeLabel} — set in the top bar. A programme is an account with an order to read: a layer on the
          placement, or a Final Placement recording who leads it. Premium is summed across currencies (the book
          holds no FX rates); a mixed figure shows its split beside it.
        </span>
        <div className="sechead-actions">
          <div className="segmini pa-measure" role="group" aria-label="Measure">
            {MEASURES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`segbtn${measure === m.value ? ' on' : ''}`}
                aria-pressed={measure === m.value}
                onClick={() => setMeasure(m.value)}
              >{m.label}</button>
            ))}
          </div>
          <Link className="btn btn-secondary btn-sm" to="/portfolio">← Portfolio intelligence</Link>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Programmes" value={s ? String(s.programmes) : '—'}
          sub={s ? [
            `${plural(s.cedants, 'cedant')} · ${plural(s.layers, 'layer')}`,
            s.accounts_unstructured ? `${s.accounts_unstructured} on the book not yet structured` : null,
          ].filter(Boolean).join(' · ') : ''} />
        <Kpi label="We lead" value={s ? String(s.programmes_led) : '—'}
          sub={s ? `${s.programmes_followed} we follow, another house leading` : ''} />
        <Kpi label="Houses placing" value={s ? String(s.brokers) : '—'}
          sub={s ? [
            otherHouses ? `this desk and ${plural(otherHouses, 'other house')}` : 'this desk alone',
            s.programmes_unnamed_broker ? `${s.programmes_unnamed_broker} led by a house not yet named` : null,
          ].filter(Boolean).join(' · ') : ''} />
        <Kpi label="Reinsurers writing" value={s ? String(s.reinsurers) : '—'}
          sub={s ? (s.lines ? `${plural(s.lines, 'line')} · ${s.signed_lines} signed` : 'no written line yet') : ''} />
        <Kpi label="Premium seen (100%)" value={s ? fmtCompact(s.premium_seen.total) : '—'}
          sub={s ? currencyNote(s.premium_seen, 'no layer premium recorded yet') : ''} />
        <Kpi label="Our order" value={s ? fmtCompact(s.premium_order.total) : '—'}
          sub={s ? (s.order_share_pct != null ? `${s.order_share_pct}% of the premium seen is ours to place` : 'no order recorded on a layer yet') : ''} />
        <Kpi label="Premium on lines" value={s ? fmtCompact(s.premium_on_lines.total) : '—'}
          sub={s ? (s.premium_on_lines.total
            ? `${currencyNote(s.premium_on_lines)} · ${fmtCompact(s.premium_signed.total)} signed`
            : 'no line carries a layer premium yet') : ''} />
        <Kpi label="Top three writers" value={conc ? `${Math.round(conc.top3_pct)}%` : '—'}
          sub={conc
            ? `of the premium on lines · ${s.avg_panel_size} reinsurers on an average panel`
            : (s ? 'no premium on lines to read a concentration from' : '')} />
      </div>

      {/* Who places */}
      <section>
        <div className="sechead">
          <SectionLabel>Who places the programmes — by broker</SectionLabel>
          <span className="hint">this desk when the full order runs through it; the house named at Final Placement when we follow · click a bar to narrow the programmes below</span>
        </div>
        <div className="pa-duo">
          <Panel
            title={`${byPremium ? 'Premium' : 'Programmes'} by broker, by class of business`}
            legend={<Legend items={classLegend} ariaLabel="Classes of business" />}
            loading={loading}
            testid="pa-brokers"
            note="Each bar is one house; its segments are the classes of business on the programmes it leads. The biggest six classes on the book take a colour each, the rest fold into Other."
          >
            <HBars
              rows={brokerRows}
              format={fmt}
              integer={!byPremium}
              ariaLabel={`${measureNoun} by broker, stacked by class of business`}
              onSelect={(key) => setSel((cur) => ({ ...cur, broker: key }))}
              selectedKey={sel.broker}
              emptyNote={waiting ? 'Loading…' : 'No programme has an order to read a broker from yet.'}
            />
            <Figures
              summary="Figures — the brokers, class by class"
              columns={[
                { label: 'Broker' }, { label: 'Class of business' }, { label: 'Programmes', align: 'r' },
                { label: 'Premium (100%)', align: 'r' }, { label: 'Our order', align: 'r' },
                { label: 'Reinsurers', align: 'r' }, { label: 'Avg panel', align: 'r' },
              ]}
              rows={brokers.flatMap((b) => [
                {
                  key: b.key,
                  cells: [
                    <b>{brokerLabel(b)}</b>, <span className="muted">{plural(b.classes.length, 'class', 'classes')}</span>, b.programmes,
                    <MoneyCell money={b.premium} />, <MoneyCell money={b.premium_order} />, b.reinsurer_count, b.avg_panel_size ?? '—',
                  ],
                },
                ...b.classes.map((c) => ({
                  key: `${b.key}:${c.class}`,
                  cells: ['', c.class, c.programmes, <MoneyCell money={c.premium} />, <MoneyCell money={c.premium_order} />, '', ''],
                })),
              ])}
            />
          </Panel>
          <Panel
            title="Our order behind each house's programmes"
            loading={loading}
            testid="pa-order"
            note="The bar is the premium at 100% on the house's programmes; the filled part is the share of it mandated to this desk. Full when we lead."
          >
            <Meters
              rows={orderRows}
              ariaLabel="Our order as a share of the premium on each house's programmes"
              emptyNote={waiting ? 'Loading…' : 'No programme has an order to read yet.'}
            />
            <Figures
              summary="Figures — the order"
              columns={[{ label: 'Broker' }, { label: 'Premium (100%)', align: 'r' }, { label: 'Our order', align: 'r' }, { label: 'The rest', align: 'r' }, { label: 'Our share', align: 'r' }]}
              rows={brokers.map((b) => ({
                key: b.key,
                cells: [brokerLabel(b), <MoneyCell money={b.premium} />, <MoneyCell money={b.premium_order} />, <MoneyCell money={b.premium_rest} />, fmtPct(b.order_share_pct, 0)],
              }))}
            />
          </Panel>
        </div>
      </section>

      {/* Who writes */}
      <section>
        <div className="sechead">
          <SectionLabel>Who writes them — by reinsurer{d && reinsurers.length ? ` · ${reinsurers.length}` : ''}</SectionLabel>
          <span className="hint">every reinsurer with a written or signed line, in the role it was approached in · click a bar to narrow the programmes below</span>
        </div>
        <div className="pa-duo">
          <Panel
            title={`${byPremium ? 'Premium on lines' : 'Programmes written'} by reinsurer, by role`}
            legend={<Legend items={roleLegend} ariaLabel="Role approached in" />}
            loading={loading}
            testid="pa-reinsurers"
            note={`The ${TOP_REINSURERS} reinsurers on most programmes, the rest of the panel folded into one bar. A programme reads by the strongest role the reinsurer holds on it; premium on lines is each layer's premium at 100% times the line's share.`}
          >
            <HBars
              rows={reRows}
              format={fmt}
              integer={!byPremium}
              ariaLabel={`${byPremium ? 'premium on lines' : 'programmes'} by reinsurer, stacked by role`}
              onSelect={(key) => setSel((cur) => ({ ...cur, reinsurer: key }))}
              selectedKey={sel.reinsurer}
              emptyNote={waiting ? 'Loading…' : 'No written line in this scope yet.'}
            />
            <Figures
              summary="Figures — the reinsurers"
              columns={[
                { label: 'Reinsurer' }, { label: 'Rating' }, { label: 'Programmes', align: 'r' }, { label: 'Lead · follow · unrecorded', align: 'r' },
                { label: 'Lines (signed)', align: 'r' }, { label: 'Premium on lines', align: 'r' }, { label: 'Premium signed', align: 'r' },
                { label: 'Leads', align: 'r' }, { label: 'Houses', align: 'r' },
              ]}
              rows={reinsurers.map((r) => ({
                key: r.market_id,
                cells: [
                  r.name, r.rating || '—', r.programmes,
                  `${r.programmes_lead} · ${r.programmes_follow} · ${r.programmes_unroled}`,
                  `${r.lines} (${r.signed_lines})`, <MoneyCell money={r.premium_on_lines} />, <MoneyCell money={r.premium_signed} />,
                  r.programmes_led || '—', r.brokers.length,
                ],
              }))}
            />
          </Panel>
          <Panel
            title="How concentrated the panel is"
            loading={loading}
            testid="pa-concentration"
            note="The share of the premium on lines carried by the biggest writers, ranked by what their lines carry across the book."
          >
            <Meters
              rows={concRows}
              ariaLabel="Share of premium on lines held by the biggest reinsurers"
              emptyNote={waiting ? 'Loading…' : 'No line carries a layer premium yet, so there is no concentration to read.'}
            />
            <Figures
              summary="Figures — the ranking"
              columns={[{ label: '#', align: 'r' }, { label: 'Reinsurer' }, { label: 'Premium on lines', align: 'r' }, { label: 'Share', align: 'r' }, { label: 'Cumulative', align: 'r' }]}
              rows={(conc?.curve || []).map((c) => ({
                key: c.market_id,
                cells: [c.rank, c.name, fmtCompact(c.premium_on_lines), fmtPct(c.share_pct, 1), fmtPct(c.cumulative_pct, 1)],
              }))}
            />
          </Panel>
        </div>
      </section>

      {/* Where they meet */}
      <section>
        <div className="sechead">
          <SectionLabel>Brokers × reinsurers — who writes on whose programmes</SectionLabel>
          <span className="hint">darker is more · click a cell to narrow the programmes below to that house and that reinsurer</span>
        </div>
        <div className="pa-single">
          <Panel
            title={`${byPremium ? 'Premium on lines' : 'Programmes'} by reinsurer and by the house placing them`}
            loading={loading}
            testid="pa-grid"
            note={`The ${GRID_REINSURERS} reinsurers on most programmes, one row each; a column per house. The last column is the reinsurer across every house; the last row is each house's whole book in this measure${byPremium ? ' — the premium on every line written on its programmes' : ''}.`}
          >
            <Grid
              rows={gridRows}
              cols={gridCols}
              format={fmt}
              rowHead="Reinsurer"
              colHead="Broker"
              ariaLabel={`${measureNoun} by reinsurer and broker`}
              onSelect={(cell) => setSel(cell ? { broker: cell.col, reinsurer: cell.row } : { broker: null, reinsurer: null })}
              selected={{ row: sel.reinsurer, col: sel.broker }}
              renderRowLabel={(r) => r.label}
              emptyNote={waiting ? 'Loading…' : 'No written line in this scope yet.'}
            />
          </Panel>
        </div>
      </section>

      {/* Over the years */}
      <section>
        <div className="sechead">
          <SectionLabel>Over the treaty years</SectionLabel>
          <span className="hint">a treaty year is named for the year it incepts in</span>
        </div>
        {allYears ? (
          <div className="pa-duo is-even">
            <Panel
              title="Programmes each treaty year, by our role"
              legend={<Legend items={[{ label: 'We lead', color: seriesColor(0) }, { label: 'We follow', color: seriesColor(1) }]} ariaLabel="Our role" />}
              loading={loading}
              testid="pa-years"
            >
              <Columns groups={yearCounts} format={fmtCount} integer ariaLabel="Programmes by treaty year, stacked by our role" emptyNote={waiting ? 'Loading…' : 'No programme on the book yet.'} />
              <Figures
                summary="Figures — the years"
                columns={[
                  { label: 'Treaty year' }, { label: 'Programmes', align: 'r' }, { label: 'We lead', align: 'r' }, { label: 'We follow', align: 'r' },
                  { label: 'Premium (100%)', align: 'r' }, { label: 'Our order', align: 'r' }, { label: 'Lines', align: 'r' }, { label: 'Reinsurers', align: 'r' }, { label: 'Houses', align: 'r' },
                ]}
                rows={years.map((y) => ({
                  key: y.year,
                  cells: [y.year, y.programmes, y.led, y.followed, <MoneyCell money={y.premium} />, <MoneyCell money={y.premium_order} />, y.lines, y.reinsurers, y.brokers],
                }))}
              />
            </Panel>
            <Panel
              title="Premium each treaty year, our order and the rest"
              legend={<Legend items={[{ label: 'Our order', color: seriesColor(0) }, { label: 'Placed by the lead house', color: seriesColor(null) }]} ariaLabel="Whose order" />}
              loading={loading}
              note="Premium at 100% on the programmes incepting each year, split into the share mandated to this desk and the share the lead house places."
            >
              <Columns groups={yearPremium} format={fmtCompact} ariaLabel="Premium by treaty year, our order against the rest" emptyNote={waiting ? 'Loading…' : 'No layer premium recorded yet.'} />
            </Panel>
          </div>
        ) : (
          <Blueprint className="viz-panel pa-yearnote">
            <p className="viz-note">
              The scope is one treaty year. Set the top bar to <b>All treaty years</b> to see the programmes, our role and the
              premium year by year.
            </p>
          </Blueprint>
        )}
      </section>

      {/* The programmes */}
      <section>
        <div className="sechead">
          <SectionLabel>The programmes{d ? ` · ${filtered.length} of ${programmes.length}` : ''}</SectionLabel>
          <span className="hint">click a reference to open the placement</span>
          <div className="sechead-actions pa-chips">
            {selBroker && (
              <button type="button" className="pa-filterchip" onClick={() => setSel((cur) => ({ ...cur, broker: null }))} title="Clear this filter">
                Broker <b>{brokerLabel(selBroker)}</b> ×
              </button>
            )}
            {selReinsurer && (
              <button type="button" className="pa-filterchip" onClick={() => setSel((cur) => ({ ...cur, reinsurer: null }))} title="Clear this filter">
                Reinsurer <b>{selReinsurer.name}</b> ×
              </button>
            )}
            {(sel.broker || sel.reinsurer) && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSel({ broker: null, reinsurer: null })}>Show all</button>
            )}
          </div>
        </div>
        <Blueprint className={`table-wrap${loading ? ' is-loading' : ''}`} style={{ marginTop: 10 }}>
          <table className="table pi-table renewal-cal pa-programmes">
            <thead>
              <tr>
                <th>Incepts</th>
                <th>Reference</th>
                <th>Cedant</th>
                <th>Class of business</th>
                <th>Treaty type</th>
                <th className="r">Layers</th>
                <th>Our role</th>
                <th>Lead broker</th>
                <th>Lead reinsurer</th>
                <th className="r">Panel</th>
                <th className="r">Lines</th>
                <th className="r">Our share</th>
                <th className="r">Premium (100%)</th>
                <th className="r">On lines</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{fmtDate(p.inception, { shortYear: true })}</td>
                  <td><button className="refbtn" onClick={() => openProgramme(p)}>{p.reference}</button></td>
                  <td>{p.cedant_name}</td>
                  <td style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>{p.class}</td>
                  <td>{p.treaty_types || '—'}</td>
                  <td className="r">{p.layers}</td>
                  <td><Pill tone={p.broker_role === 'Lead' ? 'green' : 'blue'}>{p.broker_role}</Pill></td>
                  <td>{p.lead_broker || <span className="muted">not yet named</span>}</td>
                  <td>{p.lead_reinsurer || <span className="muted">not yet led</span>}</td>
                  <td className="r" title={p.panel.map((m) => `${m.name} ${fmtPct(m.share, 1)}`).join(', ')}>
                    {p.panel_size || <span className="muted">—</span>}
                  </td>
                  <td className="r">{p.lines ? `${p.lines}${p.signed_lines ? ` · ${p.signed_lines} signed` : ''}` : <span className="muted">—</span>}</td>
                  <td className="r">{fmtPct(p.order_share_pct, 0)}</td>
                  <td className="r">{p.premium100 ? `${p.currency} ${fmtCompact(p.premium100)}` : '—'}</td>
                  <td className="r"><MoneyCell money={p.premium_on_lines} /></td>
                  <td><StatusPill value={p.status} /></td>
                </tr>
              ))}
              {d && !filtered.length && (
                <tr>
                  <td colSpan="15" className="muted">
                    {programmes.length ? 'No programme matches this selection.' : 'No programme on the book in this scope — try another treaty year.'}
                  </td>
                </tr>
              )}
              {waiting && <tr><td colSpan="15" className="muted">Loading…</td></tr>}
            </tbody>
          </table>
        </Blueprint>
      </section>
    </div>
  );
}
