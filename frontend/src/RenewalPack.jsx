import React, { useEffect, useMemo, useState } from 'react';
import { api, download } from './api.js';
import ModellingPack from './ModellingPack.jsx';
import { useModelling, scopedSectionKey } from './modelling/store.jsx';
import { requiredScreens } from './modelling/workflow.js';

/*
 * The renewal pack screen.
 *
 * The pack view is a checklist: every screen of the placement's wizard —
 * the placement screens once, the modelling screens per class of business —
 * marked with or without data, then the standard running order's sections
 * with their filled / empty status. **Create Renewal Pack** cuts the next
 * version from what the screens hold: the version is stored (SQL), and its
 * Excel and PDF are rendered at that moment and stored with it, so the
 * download of a version is always the file that was cut.
 *
 * Which screens are *required* follows from the quoting structure — the
 * bases the placement page derives from the structures to quote, through
 * requiredScreens() in modelling/workflow.js — and a version records which
 * required screens had no data when it was created.
 */

/* ── The checklist of screens ── */

/** The section(s) a modelling screen saves to. */
const SCREEN_SECTIONS = {
  'm:tri_premium': ['triangle_premium'],
  'm:tri_paid': ['triangle_paid'],
  'm:tri_os': ['triangle_os'],
  'm:tri_incurred': ['triangle_incurred', 'triangle_paid', 'triangle_os'], // derived from paid + OS
  'm:straight_stats': ['straight_stats'],
  'm:large_list': ['large_losses'],
  'm:large_selection': ['loss_selection_large'],
  'm:large_pareto': ['loss_selection_large'],
  'm:cat_list': ['cat_losses'],
  'm:cat_selection': ['loss_selection_cat'],
  'm:cat_pareto': ['loss_selection_cat'],
  'm:dev_premium': ['dev_factors_premium'],
  'm:dev_paid': ['dev_factors_paid'],
  'm:dev_os': ['dev_factors_os'],
  'm:dev_incurred': ['dev_factors_incurred'],
  'm:projected_summary': ['pricing_yearly'],
  'm:quick_summary': ['prop_terms'],
  'm:risk_profile': ['risk_profile'],
  'm:claims_profile': ['claims_profile'],
  'm:cresta': ['cresta'],
  'm:event_loss_tables': ['event_loss_tables'],
  'm:np_premiums': ['np_premiums'],
  'm:np_large_ldf': ['np_large_ldf'],
  'm:np_cat_ldf': ['np_cat_ldf'],
  'm:np_excess_dev': ['np_excess_dev'],
  'm:np_historical': ['np_historical'],
};

/** The placement-level screens, and the pack sections that show each one
    holds data — read off the live pack preview rather than the modelling store. */
const PLACEMENT_SCREEN_SECTIONS = {
  detail: ['treaty_detail', 'info_page'],
  expiring: ['expiring_structure'],
  structure: ['structure_to_quote'],
  retentions: ['retentions'],
};

/** Tabs of the placement page that are not data screens: the Data screen
    reads the others rather than holding data of its own, and the stages
    from the pack onward are built from them. */
const NOT_DATA_SCREENS = new Set(['data', 'pack', 'approval', 'negotiation', 'finalquote', 'final']);

/** Whether a saved section carries anything entered — a value, not just empty rows or flags. */
export function hasContent(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'boolean') return false;
  if (Array.isArray(v)) return v.some(hasContent);
  if (typeof v === 'object') return Object.values(v).some(hasContent);
  return false;
}

const titleCase = (s) => String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const kb = (n) => (n == null ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Totals over a checklist's rows. */
function tally(cobs, rows) {
  const total = rows.reduce((n, r) => n + r.done.length, 0);
  const filled = rows.reduce((n, r) => n + r.done.filter(Boolean).length, 0);
  const missing = rows.filter((r) => r.done.some((d) => !d));
  const requiredRows = rows.filter((r) => r.required);
  return {
    cobs, rows, total, filled, missing,
    requiredTotal: requiredRows.length,
    requiredFilled: requiredRows.filter((r) => r.done.every(Boolean)).length,
    requiredMissing: missing.filter((r) => r.required),
  };
}

/**
 * The live checklist: every screen of the wizard against what is saved now.
 * A modelling screen counts as holding data for a class when any of its
 * sections carries a value (the first class also reading the plain key saved
 * before the classes split); a placement screen when its pack section is
 * filled on the live preview.
 */
export function useScreenChecklist(groups, preview, bases) {
  const mod = useModelling();
  return useMemo(() => {
    const cobs = mod.cobs.length ? mod.cobs : [''];
    const status = Object.fromEntries((preview?.sections || []).map((s) => [s.key, s.status]));
    // The quoting structure decides which screens are required.
    const required = requiredScreens(bases);
    const filledFor = (key, cob, i) => (SCREEN_SECTIONS[key] || [key.replace(/^m:/, '')]).some((section) => {
      const own = mod.sections?.[scopedSectionKey(section, cob, mod.cobs)]?.data;
      if (own != null) return hasContent(own);
      return i === 0 && hasContent(mod.sections?.[section]?.data);
    });
    const rows = groups.flatMap((g) => g.tabs
      .filter(([key]) => !NOT_DATA_SCREENS.has(key))
      .map(([key, label]) => {
        const scope = key.startsWith('m:') ? 'class' : 'placement';
        const done = scope === 'placement'
          ? [(PLACEMENT_SCREEN_SECTIONS[key] || [key]).some((s) => status[s] === 'filled')]
          : cobs.map((c, i) => filledFor(key, c, i));
        return { key, label, group: titleCase(g.label), scope, done, required: required.has(key) };
      }));
    return { ...tally(cobs, rows), loading: mod.loading, recorded: null };
  }, [groups, preview, bases, mod.sections, mod.cobs, mod.loading]);
}

/** The checklist a stored version recorded when it was created, in the live checklist's shape. */
function recordedChecklist(record, version) {
  if (!record?.rows?.length) return null;
  const cobs = record.cobs?.length ? record.cobs : [''];
  return { ...tally(cobs, record.rows), loading: false, recorded: version };
}

/** What the create call sends: the checklist without the derived counts. */
const checklistPayload = (c) => ({
  cobs: c.cobs,
  rows: c.rows.map(({ key, label, group, scope, done, required }) => ({ key, label, group, scope, done, required })),
});

function ScreenChecklist({ checklist, onOpen }) {
  const mod = useModelling();
  const { cobs, rows, total, filled, missing, requiredTotal, requiredFilled, requiredMissing, recorded, loading } = checklist;
  const open = (key, cob) => {
    if (!onOpen) return;
    if (cob && cob !== mod.activeCob) mod.switchCob(cob);
    onOpen(key);
  };
  // Ready when every required screen holds data; every screen filled is the
  // stronger statement.
  const ready = rows.length > 0 && (requiredTotal > 0 ? requiredMissing.length === 0 : missing.length === 0);
  const chips = [...requiredMissing, ...missing.filter((r) => !r.required)];

  return (
    <div className="rp-checklist rp-checklist--screens" data-testid="screen-checklist">
      <div className="rp-checklist-head">
        <div className="rp-sub-title">
          Screens{recorded ? <span className="muted"> · as recorded when v{recorded} was created</span> : ''}
        </div>
        <div className={`rp-tracker rp-tracker--inline${ready ? ' rp-tracker--ready' : ''}`} data-testid="screen-tracker">
          <b>
            {requiredTotal > 0
              ? <>{requiredFilled}/{requiredTotal} required screens have data{requiredMissing.length === 0 ? ' — ready for approval' : ''} · {filled}/{total} in all</>
              : <>{filled}/{total} screens have data{missing.length === 0 && rows.length ? ' — every screen filled' : ''}</>}
          </b>
          {chips.slice(0, 8).map((r) => (
            <span key={r.key} className={`rp-tracker-chip${r.required ? ' rp-tracker-chip--required' : ''}`}
              title={r.required ? 'Required by the quoting structure' : 'Not required by the quoting structure'}>
              {r.label}
            </span>
          ))}
          {chips.length > 8 && <span className="rp-tracker-chip">+{chips.length - 8} more</span>}
        </div>
      </div>
      {loading ? <div className="rp-empty-note">Loading the modelling data…</div> : (
        <table className="rp-table rp-check-table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Screen</th>
              {cobs.map((c) => <th key={c || 'all'} className="center">{c || 'Data'}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const allDone = r.done.every(Boolean);
              const first = i === 0 || rows[i - 1].group !== r.group;
              const mark = (done, cob, key) => (
                <button type="button" key={key} className={`rp-check-mark rp-check-mark--${done ? 'filled' : 'empty'}`}
                  title={done ? `${cob || 'Data'}: entered — open the screen` : `${cob || 'Data'}: no data — open the screen to enter it`}
                  onClick={() => open(r.key, cob)}>
                  {done ? '✓' : '—'}
                </button>
              );
              return (
                <tr key={r.key} className={`rp-check-row rp-check-row--${allDone ? 'filled' : 'empty'}${r.required && !allDone ? ' rp-check-row--required' : ''}`}>
                  <td className="rp-check-group">{first ? r.group : ''}</td>
                  <td>
                    <button type="button" className="rp-check-link rp-check-title" onClick={() => open(r.key)}>{r.label}</button>
                    {r.required && <span className="rp-status rp-status--required">required</span>}
                  </td>
                  {r.scope === 'placement'
                    ? <td className="center" colSpan={cobs.length}>{mark(r.done[0], '', 'all')}</td>
                    : cobs.map((c, ci) => <td key={c || 'all'} className="center">{mark(r.done[ci], c, c || 'all')}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PackChecklist({ snapshot, sectionsByKey }) {
  const [openKeys, setOpenKeys] = useState(() => new Set());
  const toggle = (key) => setOpenKeys((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const total = snapshot.sections.length;
  const filled = snapshot.sections.filter((s) => s.status === 'filled').length;
  return (
    <div className="rp-checklist rp-checklist--pack" data-testid="pack-checklist">
      <div className="rp-checklist-head">
        <div className="rp-sub-title">Pack sections</div>
        <div className="rp-tracker rp-tracker--inline"><b>{filled}/{total} sections filled</b></div>
      </div>
      <table className="rp-table rp-check-table">
        <thead><tr><th>Group</th><th>Section</th><th>Status</th><th /></tr></thead>
        <tbody>
          {snapshot.groups.flatMap((g) => g.keys.map((key, i) => {
            const s = sectionsByKey[key];
            if (!s) return null;
            const isOpen = openKeys.has(key);
            return (
              <React.Fragment key={key}>
                <tr className={`rp-check-row rp-check-row--${s.status}${s.required && s.status === 'empty' ? ' rp-check-row--required' : ''}`}>
                  <td className="rp-check-group">{i === 0 ? g.label : ''}</td>
                  <td>
                    <span className={`rp-check-mark rp-check-mark--${s.status}`}>{s.status === 'filled' ? '✓' : '—'}</span>
                    <span className="rp-check-title">{s.title}</span>
                    <div className="rp-section-blurb">{s.status === 'empty' ? <span className="rp-empty-note">{s.note}</span> : s.blurb}</div>
                  </td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <span className={`rp-status rp-status--${s.status}`}>
                        {s.status === 'empty' && s.required ? 'required · empty' : s.status}
                      </span>
                    </span>
                  </td>
                  <td className="right">
                    {s.status === 'filled' && (
                      <button type="button" className="np-struct-btn rp-check-toggle" onClick={() => toggle(key)}>{isOpen ? 'Hide' : 'Show'}</button>
                    )}
                  </td>
                </tr>
                {isOpen && s.status === 'filled' && (
                  <tr className="rp-check-body">
                    <td colSpan={4}>
                      <div className="rp-section">
                        <div className="rp-section-title">{s.title}</div>
                        <SectionBody section={s} currency={snapshot.placement.currency} />
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          }))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Section renderers: how each pack section shows its data ── */

const fmt = (n) => (n == null || n === '' || Number.isNaN(Number(n))
  ? '—'
  : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const pct = (n) => (n == null ? '—' : `${fmt(n)}%`);
const day = (d) => (d ? String(d).slice(0, 10) : '—');
/** "sum_insured_100" → "Sum insured 100%", "loss_ratio_pct" → "Loss ratio %". */
const factLabel = (key) => key
  .replace(/_pct$/, '_%')
  .replace(/_100\b/, '_100%')
  .replace(/_/g, ' ')
  .replace(/^./, (c) => c.toUpperCase());

/** A plain table for a section's rows. */
function Rows({ columns, rows }) {
  if (!rows?.length) return null;
  return (
    <div className="np-table-wrap">
      <table className="np-struct-table rp-table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.right ? 'right' : ''}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} className={c.right ? 'right' : ''}>
                  {c.render ? c.render(r) : (c.money ? fmt(r[c.key]) : (r[c.key] ?? '—'))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Label/value pairs for a section's figures. */
function Facts({ items }) {
  const shown = items.filter(([, v]) => v !== undefined);
  if (!shown.length) return null;
  return (
    <dl className="rp-facts">
      {shown.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

/** How each section renders its data. Anything without an entry falls back to
    a readable dump, so a new template section is never invisible. */
/** UW-year development matrix: one column per bordereau as-at date. */
function Triangle({ d, ccy }) {
  const columns = [
    { key: 'year', label: 'UW Year' },
    ...d.columns.map((label, i) => ({ key: `c${i}`, label: `${label} (${ccy})`, money: true, right: true })),
  ];
  const rows = d.rows.map((r) => ({
    year: r.year,
    ...Object.fromEntries(r.values.map((v, i) => [`c${i}`, v])),
  }));
  return <Rows columns={columns} rows={rows} />;
}

/** Per-class subtables, titled with the class name. */
function ByClass({ classes, render }) {
  return (
    <>
      {classes.map((c) => (
        <div key={c.class} className="rp-substructure">
          <div className="rp-sub-title">{c.class}</div>
          {render(c)}
        </div>
      ))}
    </>
  );
}

function SectionBody({ section, currency }) {
  const d = section.data;
  const ccy = currency || '';
  switch (section.key) {
    case 'info_page':
      return (
        <>
          <Facts items={[
            ['Reference', d.reference], ['Cedant', d.cedant], ['Domicile', d.domicile],
            ['Inception', day(d.inception)], ['Renewal date', day(d.renewal_date)],
            ['Classes of business', (d.classes_of_business || []).join(', ') || '—'],
            ['Treaty type', d.treaty_type || '—'], ['Currency', d.currency],
            ['Expiring leader', d.expiring_leader || 'not recorded'],
            ['Status', d.status],
            ['Basis of renewal', d.renewal_of ? 'Renewal of the prior year contract' : 'New business'],
            ...(d.notes ? [['Notes', d.notes]] : []),
          ]} />
          {(d.treaty_structure || []).length > 0 && (
            <Rows columns={[{ key: 'line', label: 'Treaty structure' }]}
              rows={d.treaty_structure.map((line) => ({ line }))} />
          )}
        </>
      );
    case 'historical_epi':
      return (
        <>
          <Facts items={[
            ['EPI to market', `${ccy} ${fmt(d.epi_to_market)}`],
            ['Expiring EPI', `${ccy} ${fmt(d.expiring_epi)}`],
          ]} />
          <Rows columns={[
            { key: 'year', label: 'UW Year' }, { key: 'risks', label: 'Risks', right: true },
            { key: 'epi', label: `EPI (${ccy})`, money: true, right: true },
          ]} rows={d.years} />
        </>
      );
    case 'ceding_criteria':
      return (
        <div className="rp-prose">
          {String(d.text || '').split('\n').map((line, i) => (line.trim()
            ? <p key={i}>{line}</p>
            : null))}
        </div>
      );
    case 'triangulation_premium':
    case 'triangulation_paid':
    case 'triangulation_os':
      return <Triangle d={d} ccy={ccy} />;
    case 'straight_premium':
      return <Rows columns={[
        { key: 'year', label: 'UW Year' }, { key: 'risks', label: 'Risks', right: true },
        { key: 'premium', label: `Premium (${ccy})`, money: true, right: true },
      ]} rows={d.rows} />;
    case 'straight_paid':
      return <Rows columns={[
        { key: 'year', label: 'UW Year' }, { key: 'claims', label: 'Claims', right: true },
        { key: 'paid', label: `Paid (${ccy})`, money: true, right: true },
      ]} rows={d.rows} />;
    case 'straight_os':
      return <Rows columns={[
        { key: 'year', label: 'UW Year' }, { key: 'claims', label: 'Claims', right: true },
        { key: 'outstanding', label: `Outstanding (${ccy})`, money: true, right: true },
      ]} rows={d.rows} />;
    case 'commissions':
      return <Rows columns={[
        { key: 'source', label: 'Terms' }, { key: 'treaty_type', label: 'Treaty type' },
        { key: 'commission_pct', label: 'Commission %', right: true, render: (r) => pct(r.commission_pct) },
        { key: 'profit_commission_pct', label: 'Profit comm. %', right: true, render: (r) => pct(r.profit_commission_pct) },
        { key: 'mgmt_expenses_pct', label: 'Mgmt exp. %', right: true, render: (r) => pct(r.mgmt_expenses_pct) },
        { key: 'brokerage_pct', label: 'Brokerage %', right: true, render: (r) => pct(r.brokerage_pct) },
        { key: 'lpv_pct', label: 'LPV %', right: true, render: (r) => pct(r.lpv_pct) },
      ]} rows={d.rows} />;
    case 'stats_ratios':
      return (
        <>
          <Facts items={[['Commission basis', d.commission_basis]]} />
          <Rows columns={[
            { key: 'year', label: 'UW Year' },
            { key: 'premium', label: `Premium (${ccy})`, money: true, right: true },
            { key: 'incurred', label: `Incurred (${ccy})`, money: true, right: true },
            { key: 'loss_ratio_pct', label: 'Loss ratio', right: true, render: (r) => pct(r.loss_ratio_pct) },
            { key: 'commission_ratio_pct', label: 'Commission', right: true, render: (r) => pct(r.commission_ratio_pct) },
            { key: 'combined_ratio_pct', label: 'Combined', right: true, render: (r) => pct(r.combined_ratio_pct) },
          ]} rows={d.rows} />
        </>
      );
    case 'large_losses_by_class':
      return (
        <>
          <Facts items={[['Threshold', `${ccy} ${fmt(d.threshold)}`], ['Basis', d.basis]]} />
          <ByClass classes={d.classes} render={(c) => (
            <Rows columns={[
              { key: 'claim_ref', label: 'Claim' }, { key: 'insured', label: 'Insured' },
              { key: 'date_of_loss', label: 'Date of loss' }, { key: 'cause_of_loss', label: 'Cause' },
              { key: 'paid', label: 'Paid', money: true, right: true },
              { key: 'outstanding', label: 'Outstanding', money: true, right: true },
              { key: 'incurred', label: 'Incurred', money: true, right: true },
            ]} rows={c.losses} />
          )} />
        </>
      );
    case 'cat_losses_by_class':
      return (
        <>
          <Facts items={[['CAT incurred', `${ccy} ${fmt(d.incurred)}`]]} />
          <ByClass classes={d.classes} render={(c) => (
            <Rows columns={[
              { key: 'claim_ref', label: 'Claim' }, { key: 'date_of_loss', label: 'Date of loss' },
              { key: 'cause_of_loss', label: 'Peril' },
              { key: 'incurred', label: 'Incurred', money: true, right: true },
            ]} rows={c.losses} />
          )} />
        </>
      );
    case 'risk_profile_by_class':
      return <ByClass classes={d.classes} render={(c) => (
        <Rows columns={[
          { key: 'band', label: `Sum insured band (${ccy})` },
          { key: 'risks', label: 'Risks', right: true },
          { key: 'sum_insured_100', label: 'Sum insured', money: true, right: true },
          { key: 'premium_ceded', label: 'Premium ceded', money: true, right: true },
        ]} rows={c.bands} />
      )} />;
    case 'aggregates_by_class':
      return (
        <>
          {(d.regions || []).length > 0 && (
            <>
              <div className="rp-sub-title">By region</div>
              <Rows columns={[
                { key: 'class', label: 'Class' }, { key: 'zone', label: 'Region' },
                { key: 'risks', label: 'Risks', right: true },
                { key: 'sum_insured_100', label: 'Sum insured', money: true, right: true },
                { key: 'premium_ceded', label: 'Premium ceded', money: true, right: true },
              ]} rows={d.regions} />
            </>
          )}
          {(d.cresta || []).length > 0 && (
            <>
              <div className="rp-sub-title">By CRESTA zone</div>
              <Rows columns={[
                { key: 'class', label: 'Class' }, { key: 'zone', label: 'CRESTA zone' },
                { key: 'risks', label: 'Risks', right: true },
                { key: 'sum_insured_100', label: 'Sum insured', money: true, right: true },
                { key: 'premium_ceded', label: 'Premium ceded', money: true, right: true },
              ]} rows={d.cresta} />
            </>
          )}
        </>
      );
    case 'top_risks':
      return (
        <>
          <Facts items={[['Note', d.note]]} />
          <Rows columns={[
            { key: 'rank', label: '#', right: true }, { key: 'insured', label: 'Insured' },
            { key: 'policy_ref', label: 'Policy' }, { key: 'class', label: 'Class' },
            { key: 'territory', label: 'Territory' },
            { key: 'sum_insured_100', label: `Sum insured (${ccy})`, money: true, right: true },
            { key: 'premium_ceded', label: 'Premium ceded', money: true, right: true },
          ]} rows={d.rows} />
        </>
      );
    case 'occupancy_profile':
      return <Rows columns={[
        { key: 'occupancy', label: 'Occupancy' }, { key: 'risks', label: 'Risks', right: true },
        { key: 'sum_insured_100', label: `Sum insured (${ccy})`, money: true, right: true },
        { key: 'premium_ceded', label: 'Premium ceded', money: true, right: true },
      ]} rows={d.rows} />;
    case 'special_acceptances':
      return <Rows columns={[
        { key: 'type', label: 'Type' }, { key: 'title', label: 'Title' },
        { key: 'explanation', label: 'Explanation' },
        { key: 'effective_date', label: 'Effective', render: (r) => day(r.effective_date) },
        { key: 'status', label: 'Status' },
      ]} rows={d.rows} />;
    case 'treaty_detail':
      return <Facts items={[
        ['Reference', d.reference], ['Cedant', d.cedant], ['Domicile', d.domicile],
        ['Class', d.class], ['Currency', d.currency],
        ['Period', `${day(d.inception)} → ${day(d.expiry)}`], ['Status', d.status],
        ['Renewal of', d.renewal_of ? 'prior year contract' : 'new business'],
        ...(d.notes ? [['Notes', d.notes]] : []),
      ]} />;
    case 'documents':
      return <Rows columns={[
        { key: 'type', label: 'Document' }, { key: 'version', label: 'Version' },
        { key: 'created_at', label: 'Generated', render: (r) => day(r.created_at) },
      ]} rows={d.documents} />;
    // BOTH shows its proportional section over its non-proportional one.
    case 'expiring_structure': {
      const propPart = (
        <Facts items={[
          ['Basis', d.basis === 'BOTH' ? 'Both' : 'Proportional'], ['Treaty type', d.prop?.treatyType],
          ['QS limit', fmt(d.prop?.qsLimit)], ['Retention %', pct(d.prop?.retentionPct)],
          ['Commission %', pct(d.prop?.commissionPct)], ['EPI', fmt(d.prop?.epi)],
        ]} />
      );
      const layerPart = (
        <Rows columns={[
          { key: 'name', label: 'Layer' }, { key: 'limit', label: `Limit (${ccy})`, money: true, right: true },
          { key: 'attachment', label: 'Attachment', money: true, right: true },
          { key: 'premium', label: 'Premium', money: true, right: true },
        ]} rows={d.layers} />
      );
      if (d.basis === 'PROP') return propPart;
      if (d.basis !== 'BOTH') return layerPart;
      return (
        <>
          <div className="rp-substructure">
            <div className="rp-sub-title">Section 1 · Proportional</div>
            {propPart}
          </div>
          <div className="rp-substructure">
            <div className="rp-sub-title">Section 2 · Non-proportional</div>
            {layerPart}
          </div>
        </>
      );
    }
    case 'structure_to_quote':
      return (
        <>
          {d.structures.map((s) => (
            <div key={s.index} className="rp-substructure">
              <div className="rp-sub-title">Structure {s.index} · {s.basis === 'PROP' ? 'Proportional' : 'Non-proportional'}</div>
              {s.basis === 'PROP'
                ? <Facts items={[
                  ['Treaty type', s.prop?.treatyType], ['QS limit', fmt(s.prop?.qsLimit)],
                  ['Retention %', pct(s.prop?.retentionPct)], ['Commission %', pct(s.prop?.commissionPct)],
                ]} />
                : <Rows columns={[
                  { key: 'name', label: 'Layer' },
                  { key: 'limit', label: `Limit (${ccy})`, money: true, right: true },
                  { key: 'attachment', label: 'Attachment', money: true, right: true },
                  { key: 'reinstatements', label: 'Reinst.' },
                  { key: 'premium', label: 'Premium', money: true, right: true },
                ]} rows={s.layers} />}
            </div>
          ))}
          {d.placed_layers.length > 0 && (
            <>
              <div className="rp-sub-title">Layers on the placement</div>
              <Rows columns={[
                { key: 'name', label: 'Layer' },
                { key: 'limit', label: `Limit (${ccy})`, money: true, right: true },
                { key: 'attachment', label: 'Attachment', money: true, right: true },
                { key: 'order_pct', label: 'Order %', right: true, render: (r) => pct(r.order_pct) },
                { key: 'premium100', label: 'Premium 100%', money: true, right: true },
                { key: 'status', label: 'Status' },
              ]} rows={d.placed_layers} />
            </>
          )}
        </>
      );
    case 'premiums_table':
      return <Rows columns={[
        { key: 'layer', label: 'Layer' },
        { key: 'egnpi', label: `EGNPI (${ccy})`, money: true, right: true },
        { key: 'rate_pct', label: 'Rate %', right: true, render: (r) => pct(r.rate_pct) },
        { key: 'premium100', label: 'Premium 100%', money: true, right: true },
        { key: 'reinstatements', label: 'Reinst.' },
        { key: 'aad', label: 'AAD', money: true, right: true },
      ]} rows={d.layers} />;
    case 'retentions':
      return (
        <>
          <Facts items={[['Treaty full limit', fmt(d.limit)]]} />
          <Rows columns={[
            { key: 'klass', label: 'Class' }, { key: 'category', label: 'Occupancy' },
            { key: 'pct', label: '% of limit', right: true, render: (r) => pct(r.pct) },
          ]} rows={d.rows} />
        </>
      );
    case 'premium_experience':
      return (
        <>
          <Facts items={[
            ['Risks', fmt(d.risks)], ['Policies', fmt(d.distinct_policies)],
            ['Sum insured 100%', `${ccy} ${fmt(d.sum_insured_100)}`],
            ['Ceded SI', `${ccy} ${fmt(d.si_ceded)}`],
            ['Gross premium 100%', `${ccy} ${fmt(d.gross_premium_100)}`],
            ['Premium ceded', `${ccy} ${fmt(d.premium_ceded)}`],
            ['Ceded rate', pct(d.ceded_rate_pct)],
          ]} />
          <Rows columns={[
            { key: 'key', label: 'Class of business' }, { key: 'count', label: 'Risks', right: true },
            { key: 'premium_ceded', label: 'Premium ceded', money: true, right: true },
            { key: 'sum_insured_100', label: 'Sum insured', money: true, right: true },
          ]} rows={d.by_class} />
        </>
      );
    case 'claims_experience':
      return (
        <>
          <Facts items={[
            ['Claims', fmt(d.claims)], ['Paid', `${ccy} ${fmt(d.paid)}`],
            ['Outstanding', `${ccy} ${fmt(d.outstanding)}`], ['Incurred', `${ccy} ${fmt(d.incurred)}`],
            ['Open', fmt(d.open_claims)], ['Closed', fmt(d.closed_claims)],
          ]} />
          <Rows columns={[
            { key: 'key', label: 'Class of business' }, { key: 'count', label: 'Claims', right: true },
            { key: 'incurred', label: 'Incurred', money: true, right: true },
            { key: 'paid', label: 'Paid', money: true, right: true },
          ]} rows={d.by_class} />
        </>
      );
    case 'projected_summary':
    case 'historical_performance':
    case 'quick_summary':
      return <Facts items={Object.entries(d).map(([k, v]) => [factLabel(k), k.endsWith('_pct') ? pct(v) : fmt(v)])} />;
    case 'large_loss_list':
      return (
        <>
          <Facts items={[['Threshold', `${ccy} ${fmt(d.threshold)}`], ['Basis', d.basis]]} />
          <Rows columns={[
            { key: 'claim_ref', label: 'Claim' }, { key: 'insured', label: 'Insured' },
            { key: 'date_of_loss', label: 'Date of loss' }, { key: 'cause_of_loss', label: 'Cause' },
            { key: 'paid', label: 'Paid', money: true, right: true },
            { key: 'outstanding', label: 'Outstanding', money: true, right: true },
            { key: 'incurred', label: 'Incurred', money: true, right: true },
          ]} rows={d.losses} />
        </>
      );
    case 'large_loss_selection':
      return <Facts items={[
        ['Threshold', `${ccy} ${fmt(d.threshold)}`], ['Selected', fmt(d.selected)],
        ['Selected incurred', `${ccy} ${fmt(d.selected_incurred)}`],
        ['Attritional incurred', `${ccy} ${fmt(d.attritional_incurred)}`],
        ['Note', d.note],
      ]} />;
    case 'cat_loss_list':
      return (
        <>
          <Facts items={[['Cat incurred', `${ccy} ${fmt(d.incurred)}`]]} />
          <Rows columns={[
            { key: 'claim_ref', label: 'Claim' }, { key: 'date_of_loss', label: 'Date of loss' },
            { key: 'cause_of_loss', label: 'Peril' },
            { key: 'incurred', label: 'Incurred', money: true, right: true },
          ]} rows={d.losses} />
        </>
      );
    case 'risk_profile':
      return <Rows columns={[
        { key: 'band', label: `Sum insured band (${ccy})` },
        { key: 'risks', label: 'Risks', right: true },
        { key: 'sum_insured_100', label: 'Sum insured', money: true, right: true },
        { key: 'premium_ceded', label: 'Premium ceded', money: true, right: true },
      ]} rows={d.bands} />;
    case 'claims_profile':
      return (
        <>
          <Rows columns={[
            { key: 'key', label: 'Cause of loss' }, { key: 'count', label: 'Claims', right: true },
            { key: 'incurred', label: 'Incurred', money: true, right: true },
          ]} rows={d.by_cause} />
          {(d.largest_losses || []).length > 0 && (
            <>
              <div className="rp-sub-title">Largest losses</div>
              <Rows columns={[
                { key: 'claim_ref', label: 'Claim' }, { key: 'insured', label: 'Insured' },
                { key: 'cause_of_loss', label: 'Cause' },
                { key: 'incurred', label: 'Incurred', money: true, right: true },
              ]} rows={d.largest_losses} />
            </>
          )}
        </>
      );
    case 'cresta_aggregates':
      return <Rows columns={[
        { key: 'zone', label: 'CRESTA zone' }, { key: 'risks', label: 'Risks', right: true },
        { key: 'sum_insured_100', label: 'Sum insured', money: true, right: true },
      ]} rows={d.zones} />;
    case 'event_loss_tables':
      return (
        <>
          <Facts items={[['Model / run', d.note || '—']]} />
          <Rows columns={[
            { key: 'return_period', label: 'Return period (yrs)', right: true },
            { key: 'oep', label: `OEP (${ccy})`, money: true, right: true },
            { key: 'aep', label: `AEP (${ccy})`, money: true, right: true },
          ]} rows={d.rows} />
        </>
      );
    case 'pricing':
      return (
        <>
          <Rows columns={[
            { key: 'name', label: 'Layer' },
            { key: 'technical_rate_on_line', label: 'Technical ROL', right: true },
            { key: 'source', label: 'Source' },
          ]} rows={d.technical_view} />
          <div className="rp-sub-title">Quotes</div>
          <Rows columns={[
            { key: 'market', label: 'Market' }, { key: 'type', label: 'Type' },
            { key: 'rate_on_line', label: 'ROL', right: true },
            { key: 'premium', label: 'Premium', money: true, right: true },
            { key: 'status', label: 'Status' },
            { key: 'validity', label: 'Valid to', render: (r) => day(r.validity) },
          ]} rows={d.quotes} />
        </>
      );
    case 'wording':
      return <Facts items={[
        ['Title', d.title], ['Status', d.status], ['Base wording', d.reinsurer || 'Standard'],
        ['Clauses', fmt(d.clauses)],
      ]} />;
    default:
      return <pre className="rp-dump">{JSON.stringify(d, null, 2)}</pre>;
  }
}

/* ── The card ── */

export default function RenewalPack({ placementId, canEdit, canApprove = false, screens = [], bases, onOpenScreen, onPacksChange }) {
  const [view, setView] = useState('pack'); // 'pack' | 'model'
  const [versions, setVersions] = useState(null);
  const [selectedId, setSelectedId] = useState(null); // null = live preview
  const [preview, setPreview] = useState(null); // what the next version would hold
  const [versionSnapshot, setVersionSnapshot] = useState(null); // the selected version, as cut
  const [created, setCreated] = useState(null); // the version just created, with its files
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadVersions = () => api('GET', `/placements/${placementId}/packs`)
    .then((rows) => { setVersions(rows); return rows; })
    .catch((e) => { setError(e); return []; });

  useEffect(() => { loadVersions(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [placementId]);

  // The live preview is always read: it is what Create cuts, and what the
  // placement-level rows of the screen checklist are marked from.
  useEffect(() => {
    let stale = false;
    api('GET', `/placements/${placementId}/pack-preview`)
      .then((p) => { if (!stale) setPreview(p.snapshot); })
      .catch((e) => { if (!stale) setError(e); });
    return () => { stale = true; };
  }, [placementId]);

  // A picked version shows its snapshot exactly as it was cut.
  useEffect(() => {
    if (!selectedId) { setVersionSnapshot(null); return undefined; }
    let stale = false;
    api('GET', `/packs/${selectedId}`)
      .then((p) => { if (!stale) setVersionSnapshot(p.snapshot); })
      .catch((e) => { if (!stale) setError(e); });
    return () => { stale = true; };
  }, [selectedId]);

  const snapshot = selectedId ? versionSnapshot : preview;
  const selected = versions?.find((v) => v.id === selectedId) || null;
  const live = useScreenChecklist(screens, preview, bases);
  // A stored version shows the checklist it recorded; the live preview, and
  // a version cut without one, show the live checklist.
  const checklist = (selected && recordedChecklist(snapshot?.screens, selected.version)) || live;

  /** Create the renewal pack: the version in SQL, its Excel and PDF stored with it. */
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const pack = await api('POST', `/placements/${placementId}/packs`, {
        screens: screens.length ? checklistPayload(live) : undefined,
      });
      await loadVersions();
      setSelectedId(pack.id);
      setCreated({ id: pack.id, version: pack.version, files: pack.files || {}, requiredMissing: live.requiredMissing });
      setView('pack');
      if (onPacksChange) onPacksChange();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const downloadPack = async (packId, format) => {
    setBusy(true); setError(null);
    try {
      await download(packId
        ? `/packs/${packId}/export?format=${format}`
        : `/placements/${placementId}/pack-preview/export?format=${format}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  // A stored version exports as cut; the live preview exports what would be
  // cut right now, marked "preview" instead of a version number.
  const exportAs = (format) => downloadPack(selectedId, format);

  /* The approval itself — submit, approve, return with a note, the comments
     and the audit trail — lives on the Pack Approval tab, the stage after
     this one. This tab only says where a version stands. Submit is held
     until every required screen had data when the version was created: the
     version is immutable, so the data goes on the screen and a new version
     is created from it. */
  const blockedBy = snapshot?.screens?.required_missing || [];
  const openApproval = () => { if (onOpenScreen) onOpenScreen('approval'); };

  const sectionsByKey = useMemo(
    () => Object.fromEntries((snapshot?.sections || []).map((s) => [s.key, s])),
    [snapshot],
  );
  const changes = selected?.changes || [];
  const nextVersion = (versions?.[0]?.version || 0) + 1;

  return (
    <section className="np-struct-card rp">
      <div className="np-struct-card-header">
        <div>
          <div className="np-struct-card-h2">Renewal Pack</div>
          <div className="np-struct-card-hint">
            {view === 'model'
              ? 'Standardised modelling pack — the AI reads every modelling screen and summarises it; the Excel carries a sheet per screen per class of business.'
              : snapshot
                ? <>Checklist — every screen of the wizard, with or without data, then the standard {snapshot.basis === 'PROP' ? 'proportional' : 'non-proportional'} running order's sections; {snapshot.summary.sections_filled} of {snapshot.summary.sections_total} sections carry data. Create Renewal Pack cuts v{nextVersion} from the screens — stored, with its Excel and PDF.</>
                : 'Loading…'}
          </div>
        </div>
        <div className="np-struct-card-actions">
          <span className="rp-viewswitch" role="tablist">
            <button type="button" className={view === 'pack' ? 'on' : ''} onClick={() => setView('pack')}>
              Pack
            </button>
            <button type="button" className={view === 'model' ? 'on' : ''} onClick={() => setView('model')}>
              Modelling Pack
            </button>
          </span>
          {view === 'pack' && (
            <>
              <select className="np-mini-input" style={{ width: 190 }} value={selectedId || ''}
                onChange={(e) => setSelectedId(e.target.value || null)}>
                <option value="">Live preview (not created)</option>
                {versions?.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.version} · {v.status} · {day(v.created_at)}
                  </option>
                ))}
              </select>
              <span className="rp-exports">
                <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy || !snapshot}
                  title={selected?.files?.xlsx ? 'The Excel workbook stored with this version' : 'Excel workbook — a sheet per section'} onClick={() => exportAs('xlsx')}>
                  ⤓ Excel
                </button>
                <button type="button" className="np-struct-btn" disabled={busy || !snapshot}
                  title="Every section as titled CSV blocks in one file" onClick={() => exportAs('csv')}>
                  CSV
                </button>
                <button type="button" className="np-struct-btn" disabled={busy || !snapshot}
                  title={selected?.files?.pdf ? 'The PDF stored with this version' : 'Printable pack to attach to an email'} onClick={() => exportAs('pdf')}>
                  PDF
                </button>
              </span>
              {selected && (
                <button type="button" className="np-struct-btn np-struct-btn--accent" data-testid="open-approval"
                  title="Submit, approve or return this version, comment on it and read its audit trail on the Pack Approval tab."
                  onClick={openApproval}>
                  {selected.status === 'draft' ? `Submit v${selected.version} on Pack Approval` : `v${selected.version} on Pack Approval`}
                </button>
              )}
            </>
          )}
          {canEdit && (
            <button type="button" className="np-green-pill" data-testid="create-pack" disabled={busy || !preview}
              title={`Cut v${nextVersion} from the screens as they stand: the version is stored, and its Excel and PDF are rendered and kept with it.`}
              onClick={create}>
              {busy ? 'Creating…' : 'Create Renewal Pack'}
            </button>
          )}
        </div>
      </div>

      {error && <div className="ing-error">{error.message || 'Failed'}</div>}

      {view === 'model' && <ModellingPack placementId={placementId} canEdit={canEdit} />}

      {view === 'pack' && created && (
        <div className="rp-created" data-testid="pack-created">
          <div className="rp-created-text">
            <b>Renewal pack v{created.version} created.</b>{' '}
            Stored as version {created.version}; the Excel and PDF were cut from the same snapshot and are kept with it.
            {' '}Submit it for a Senior Broker's approval on the Pack Approval tab to open the quoting stage.
            {created.requiredMissing?.length > 0 && (
              <> <span className="rp-approval-required">Submit is held: created without data on {created.requiredMissing.length} required screen{created.requiredMissing.length === 1 ? '' : 's'} — {created.requiredMissing.map((r) => r.label).join(', ')}. Fill them and create a new version.</span></>
            )}
          </div>
          <span className="rp-exports">
            {canEdit && versions?.find((v) => v.id === created.id)?.status === 'draft' && (
              <button type="button" className="np-green-pill" disabled={busy} data-testid="submit-created"
                title="Submit this version for a Senior Broker's approval on the Pack Approval tab."
                onClick={openApproval}>
                Submit v{created.version} on Pack Approval
              </button>
            )}
            <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy}
              onClick={() => downloadPack(created.id, 'xlsx')}>
              ⤓ Excel{created.files.xlsx ? ` · ${kb(created.files.xlsx.bytes)}` : ''}
            </button>
            <button type="button" className="np-struct-btn np-struct-btn--accent" disabled={busy}
              onClick={() => downloadPack(created.id, 'pdf')}>
              ⤓ PDF{created.files.pdf ? ` · ${kb(created.files.pdf.bytes)}` : ''}
            </button>
            <button type="button" className="np-struct-btn rp-created-close" title="Dismiss" onClick={() => setCreated(null)}>×</button>
          </span>
        </div>
      )}

      {view === 'pack' && selected && (
        <div className={`rp-approval rp-approval--${selected.status}`} data-testid="pack-standing">
          <span className={`rp-status rp-status--${selected.status}`}>{selected.status === 'submitted' ? 'awaiting approval' : selected.status}</span>
          <span className="rp-approval-text">
            {selected.status === 'approved' && (
              <>Approved by <b>{selected.approved_by_name || 'a Senior Broker'}</b> on {day(selected.approved_at)} — cleared for market; the Quoting Stage is open.</>
            )}
            {selected.status === 'submitted' && (
              <>Submitted by <b>{selected.submitted_by_name || 'the broker'}</b> on {day(selected.submitted_at)} — awaiting a Senior Broker's approval on the Pack Approval tab.</>
            )}
            {selected.status === 'draft' && selected.rejection_note && (
              <>Returned by <b>{selected.rejected_by_name || 'a Senior Broker'}</b> on {day(selected.rejected_at)}: <i>{selected.rejection_note}</i> — address it and submit again on the Pack Approval tab, or create a new version.</>
            )}
            {selected.status === 'draft' && !selected.rejection_note && blockedBy.length === 0 && (
              <>Draft — submit it for a Senior Broker's approval on the Pack Approval tab. The Quoting Stage opens once a version is approved.</>
            )}
            {blockedBy.length > 0 && (
              <span className="rp-approval-required" data-testid="approval-required-missing">
                {selected.status === 'draft' ? 'Submit is held — r' : 'R'}equired screens without data when this version was created: <b>{blockedBy.join(', ')}</b>.
                {selected.status === 'draft' ? ' Fill them on the screens and create a new version.' : ''}
              </span>
            )}
          </span>
        </div>
      )}

      {view === 'pack' && snapshot && (
        <>
          <div className="rp-meta">
            <span className="pill-mini">{snapshot.basis === 'PROP' ? 'PROPORTIONAL' : 'NON-PROPORTIONAL'}</span>
            <span className="pill-mini">TEMPLATE v{snapshot.template_version}</span>
            {selected?.files?.xlsx && selected?.files?.pdf && (
              <span className="pill-mini" title={`Excel ${kb(selected.files.xlsx.bytes)} · PDF ${kb(selected.files.pdf.bytes)} — rendered when this version was created and stored with it.`}>
                EXCEL + PDF STORED
              </span>
            )}
            {snapshot.bordereaux_source && (
              <span className="pill-mini" title="This placement has no bordereaux of its own yet, so unfilled sections auto-populate from the expiring placement's data. Enter this year's data on the screens to take over.">
                DATA FROM {snapshot.bordereaux_source.reference}
              </span>
            )}
            {selected
              ? <span className="muted">Version {selected.version} · created {day(selected.created_at)}{selected.created_by_name ? ` by ${selected.created_by_name}` : ''}</span>
              : <span className="muted">Live preview of what the next version would contain — exports reflect it, but nothing is stored until you create it.</span>}
          </div>

          {/* The standard page header: every rendered page — screen and
              export alike — names these four. */}
          <div className="rp-context">
            <b>{snapshot.placement.cedant || '—'}</b>
            <span>· Class: <b>{snapshot.placement.cob || snapshot.placement.class || '—'}</b></span>
            <span>· Treaty: <b>{snapshot.placement.treaty_type || '—'}</b></span>
            <span>· Currency: <b>{snapshot.placement.currency || '—'}</b></span>
          </div>

          {/* The tracker: required sections still standing between this pack
              and going to market. */}
          {snapshot.summary.required_total > 0 && (
            <div className={`rp-tracker${snapshot.summary.required_filled === snapshot.summary.required_total ? ' rp-tracker--ready' : ''}`}>
              <b>
                {snapshot.summary.required_filled}/{snapshot.summary.required_total} required sections filled
                {snapshot.summary.required_filled === snapshot.summary.required_total ? ' — ready for market' : ''}
              </b>
              {(snapshot.summary.missing_required || []).map((title) => (
                <span key={title} className="rp-tracker-chip">{title}</span>
              ))}
            </div>
          )}

          {selected && changes.length > 0 && (
            <div className="rp-changes">
              <b>Changed since v{selected.version - 1}:</b>{' '}
              {changes.map((c) => (
                <span key={c.key} className={`rp-change rp-change--${c.change}`}>{c.title} {c.change}</span>
              ))}
            </div>
          )}

          {screens.length > 0 && <ScreenChecklist checklist={checklist} onOpen={onOpenScreen} />}
          <PackChecklist snapshot={snapshot} sectionsByKey={sectionsByKey} />
        </>
      )}
    </section>
  );
}
