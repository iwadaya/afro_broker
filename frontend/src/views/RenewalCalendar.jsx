import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  useFetch, Blueprint, SectionLabel, StatusPill, Pill, ErrorBanner,
  fmtCompact, fmtDate, fmtPct,
} from '../components.jsx';
import { useScreenHead } from '../shell.jsx';

// The launcher's calendar pill lands here on the 3-month view the diary is
// worked from; the longer windows exist because a January-heavy book is empty
// three months out for most of the year.
const WINDOWS = [3, 6, 12];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function daysUntil(date) {
  const ms = new Date(date) - new Date(new Date().toISOString().slice(0, 10));
  return Math.round(ms / 86_400_000);
}

/** '2027-01-01' → 'January 2027' for the month separators. */
function monthLabel(date) {
  const d = new Date(date);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The renewal calendar: every placement renewing inside the window — an
 * in-force treaty expiring, or a new-period placement already being worked
 * that incepts — grouped by month, with the treaty's shape and the broker's
 * position on it read straight from the layers.
 */
export default function RenewalCalendar() {
  useScreenHead('Placement diary', 'Renewal calendar');
  const navigate = useNavigate();
  const [months, setMonths] = useState(3);
  const calendar = useFetch('GET', `/dashboards/renewal-calendar?months=${months}`, [months]);

  const renewals = calendar.data?.renewals || [];

  // Month separators: a row whenever the renewal month changes.
  const grouped = [];
  let lastMonth = null;
  for (const r of renewals) {
    const label = monthLabel(r.renews_on);
    if (label !== lastMonth) {
      grouped.push({ separator: label });
      lastMonth = label;
    }
    grouped.push(r);
  }

  return (
    <div className="screen">
      <ErrorBanner error={calendar.error} />

      <section>
        <div className="sechead">
          <SectionLabel>
            Upcoming renewals — next {months} months
            {calendar.data && ` · ${renewals.length} ${renewals.length === 1 ? 'placement' : 'placements'}`}
          </SectionLabel>
          <span className="hint">click a reference to open the contract</span>
          <div className="sechead-actions">
            <Link className="btn btn-secondary btn-sm" to="/portfolio">Portfolio intelligence →</Link>
            <div className="segmini" role="group" aria-label="Renewal window">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`segbtn${months === w ? ' on' : ''}`}
                  onClick={() => setMonths(w)}
                >{w} mo</button>
              ))}
            </div>
          </div>
        </div>

        <Blueprint className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table renewal-cal">
            <thead>
              <tr>
                <th>Renews</th>
                <th>Reference</th>
                <th>Cedant</th>
                <th>Country</th>
                <th>Region</th>
                <th>Class of business</th>
                <th>Treaty type</th>
                <th>Current leader</th>
                <th>Broker status</th>
                <th className="r">Current share</th>
                <th className="r">Total premium (100%)</th>
                <th className="r">Brokerage</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((row) => (row.separator ? (
                <tr key={row.separator} className="renewal-cal-month">
                  <td colSpan="13">{row.separator}</td>
                </tr>
              ) : (
                <tr key={row.id}>
                  <td className="mono" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                    {fmtDate(row.renews_on, { shortYear: true })}
                    <span className="muted"> · {daysUntil(row.renews_on)}d</span>
                  </td>
                  <td>
                    <button className="refbtn" onClick={() => navigate(`/contracts/${row.id}`)}>
                      {row.reference}
                    </button>
                  </td>
                  <td>{row.cedant_name}</td>
                  <td>{row.cedant_country || '—'}</td>
                  <td>{row.cedant_region || '—'}</td>
                  <td style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>{row.class}</td>
                  <td>{row.treaty_types || '—'}</td>
                  <td>{row.current_leader || <span className="muted">not yet led</span>}</td>
                  <td>
                    {row.broker_role
                      ? <Pill tone={row.broker_role === 'Lead' ? 'green' : 'blue'}>{row.broker_role}</Pill>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="r">{fmtPct(row.order_share_pct, 1)}</td>
                  <td className="r">
                    {row.total_premium100
                      ? `${row.currency} ${fmtCompact(row.total_premium100)}`
                      : row.est_gwp != null
                        // No layer premium yet — the book-level GWP estimate is
                        // shown instead so the row still carries a size.
                        ? <span className="muted">est. {row.currency} {fmtCompact(row.est_gwp)}</span>
                        : '—'}
                  </td>
                  <td className="r">{row.brokerage_pct ? fmtPct(row.brokerage_pct, 2) : '—'}</td>
                  <td><StatusPill value={row.status} /></td>
                </tr>
              )))}
              {calendar.data && renewals.length === 0 && (
                <tr>
                  <td colSpan="13" className="muted">
                    Nothing renewing in the next {months} months — try a longer window.
                  </td>
                </tr>
              )}
              {!calendar.data && !calendar.error && (
                <tr><td colSpan="13" className="muted">Loading…</td></tr>
              )}
            </tbody>
          </table>
        </Blueprint>

        <p className="muted small" style={{ marginTop: 10 }}>
          Broker status and current share are read from the order: Lead when the
          full 100% order is placed through this desk, Follow when it holds a
          share of it. Total premium is the layers&rsquo; premium at 100%;
          brokerage is the premium-weighted rate across those layers.
        </p>
      </section>
    </div>
  );
}
