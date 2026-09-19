import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Card, useFetch, Form, StatusPill, TonePill, ErrorBanner, Money, Pct } from '../components.jsx';
import { useScreenHead } from '../shell.jsx';
import { useHasRole } from '../auth.jsx';

/**
 * One counterparty: its compliance file (KYC, rating, security list), the group
 * summary (market position, latest news, five-year financials) and — for a
 * reinsurer — the business we have placed with it.
 *
 * Everything on the group summary is either keyed in here or gathered from the
 * internet. AI-gathered content is labelled and stays unverified until someone
 * checks it against the sources and signs it off.
 */
const FINANCIAL_ROWS = [
  { key: 'gwp', label: 'Gross written premium', money: true },
  { key: 'nwp', label: 'Net written premium', money: true },
  { key: 'net_income', label: 'Net income', money: true },
  { key: 'shareholders_equity', label: "Shareholders' equity", money: true },
  { key: 'total_assets', label: 'Total assets', money: true },
  { key: 'loss_ratio', label: 'Loss ratio' },
  { key: 'expense_ratio', label: 'Expense ratio' },
  { key: 'combined_ratio', label: 'Combined ratio' },
  { key: 'roe', label: 'Return on equity' },
];

const CSV_TEMPLATE = 'year,currency,gwp,nwp,net_income,shareholders_equity,total_assets,'
  + 'loss_ratio,expense_ratio,combined_ratio,roe';

export default function MarketDetail() {
  const { id } = useParams();
  const broker = useHasRole('broker', 'admin');
  const authoriser = useHasRole('underwriter', 'admin');

  const market = useFetch('GET', `/markets/${id}`, [id]);
  useScreenHead('Market register', market.data?.name || 'Counterparty', market.data?.type);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  const m = market.data;
  if (market.error) return <ErrorBanner error={market.error} />;
  if (!m) return null;

  async function act(label, fn) {
    setError(null);
    setNotice(null);
    setBusy(label);
    try {
      const result = await fn();
      if (result?.gather?.note) setNotice(result.gather.note);
      market.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const { compliance: c, profile, business: b } = m;
  const aiProfile = profile?.source === 'ai';

  return (
    <>
      <ErrorBanner error={error} />
      {notice && <div className="ok banner">{notice}</div>}

      {/* ---- Compliance ---- */}
      <Card
        title="Compliance"
        actions={(
          <TonePill tone={c.overall}>
            {c.overall === 'ok' ? 'Compliant' : c.overall === 'attention' ? 'Needs attention' : 'Blocked'}
          </TonePill>
        )}
      >
        {!c.can_place && (
          <div className="err banner">
            Cannot be approached for capacity: {c.blockers.join('; ')}.
          </div>
        )}
        <div className="gates">
          {[c.kyc, c.rating, c.security].map((gate) => (
            <div key={gate.gate} className={`gate tone-border-${gate.tone}`}>
              <div className="gate-head">
                <span className="gate-name">{gate.gate === 'kyc' ? 'KYC' : gate.gate}</span>
                <TonePill tone={gate.tone}>{gate.status || gate.value || '—'}</TonePill>
              </div>
              <p className="muted small">{gate.detail}</p>
            </div>
          ))}
        </div>
        <dl className="kv">
          <dt>Group</dt><dd>{m.group_name || '—'}</dd>
          <dt>Country / region</dt><dd>{[m.domicile, m.region].filter(Boolean).join(' · ') || '—'}</dd>
          <dt>Rating</dt>
          <dd>
            {m.rating || '—'}
            {m.rating_agency && <span className="muted"> · {m.rating_agency}</span>}
            {m.rating_outlook && <span className="muted"> · {m.rating_outlook} outlook</span>}
            {m.rating_as_of && <span className="muted"> · as at {String(m.rating_as_of).slice(0, 10)}</span>}
          </dd>
          <dt>KYC reviewed</dt>
          <dd>
            {m.kyc_reviewed_at ? String(m.kyc_reviewed_at).slice(0, 10) : '—'}
            {m.kyc_expires_at && <span className="muted"> · expires {String(m.kyc_expires_at).slice(0, 10)}</span>}
          </dd>
          {m.kyc_notes && <><dt>KYC notes</dt><dd>{m.kyc_notes}</dd></>}
          {m.website && <><dt>Website</dt><dd><a href={m.website} target="_blank" rel="noreferrer">{m.website}</a></dd></>}
        </dl>

        {authoriser ? (
          <>
            <h3>Record a compliance review</h3>
            <Form
              submitLabel="Save compliance"
              initial={{
                kyc_status: m.kyc_status,
                kyc_expires_at: m.kyc_expires_at ? String(m.kyc_expires_at).slice(0, 10) : '',
                rating: m.rating || '',
                rating_agency: m.rating_agency || '',
                rating_outlook: m.rating_outlook || '',
                rating_as_of: m.rating_as_of ? String(m.rating_as_of).slice(0, 10) : '',
                security_status: m.security_status,
              }}
              fields={[
                { name: 'kyc_status', label: 'KYC', type: 'select', options: ['not_started', 'in_progress', 'approved', 'expired', 'rejected'] },
                { name: 'kyc_expires_at', label: 'KYC expires', type: 'date' },
                { name: 'rating', label: 'Rating' },
                { name: 'rating_agency', label: 'Agency' },
                { name: 'rating_outlook', label: 'Outlook', type: 'select', options: ['positive', 'stable', 'negative', 'developing'] },
                { name: 'rating_as_of', label: 'Rating as at', type: 'date' },
                { name: 'security_status', label: 'Security', type: 'select', options: ['approved', 'watch', 'declined'] },
                { name: 'kyc_notes', label: 'Notes' },
              ]}
              onSubmit={async (v) => {
                const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null));
                await api('PATCH', `/markets/${id}/compliance`, body);
                market.reload();
              }}
            />
          </>
        ) : (
          <p className="muted small">KYC and rating sign-off is recorded by an underwriter or admin.</p>
        )}
      </Card>

      {/* ---- Underwriter contacts ---- */}
      <Card title="Underwriters">
        <Underwriters marketId={id} canEdit={broker} />
      </Card>

      {/* ---- Group summary ---- */}
      <Card
        title="Group summary"
        actions={broker && (
          <button
            className="secondary small"
            disabled={busy === 'enrich'}
            onClick={() => act('enrich', () => api('POST', `/markets/${id}/profile/enrich`))}
          >
            {busy === 'enrich' ? 'Gathering…' : 'Gather from internet'}
          </button>
        )}
      >
        {aiProfile && (
          <div className={profile.verified ? 'ok banner' : 'warn banner'}>
            {profile.verified
              ? 'Gathered from the internet and verified.'
              : 'Gathered from the internet — unverified. Check it against the sources before relying on it.'}
            {profile.gathered_at && <span className="muted small"> ({new Date(profile.gathered_at).toLocaleString()})</span>}
            {!profile.verified && (
              <button
                className="ghost small"
                disabled={busy === 'verify'}
                onClick={() => act('verify', () => api('POST', `/markets/${id}/profile/verify`))}
              >
                Mark verified
              </button>
            )}
          </div>
        )}

        {profile ? (
          <dl className="kv">
            <dt>Market position</dt><dd>{profile.market_position || <span className="muted">—</span>}</dd>
            <dt>Overview</dt><dd>{profile.overview || <span className="muted">—</span>}</dd>
            <dt>Strategy</dt><dd>{profile.strategy || <span className="muted">—</span>}</dd>
          </dl>
        ) : (
          <p className="muted">No group summary yet — write one below, or gather it from the internet.</p>
        )}

        {profile?.citations?.length > 0 && (
          <p className="small muted">
            Sources:{' '}
            {profile.citations.map((s, i) => (
              <React.Fragment key={s.url}>
                {i > 0 && ' · '}
                <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>
              </React.Fragment>
            ))}
          </p>
        )}

        {broker && (
          <>
            <h3>Write the summary</h3>
            <Form
              key={profile?.updated_at || 'new'}
              submitLabel="Save summary"
              initial={{
                market_position: profile?.market_position || '',
                overview: profile?.overview || '',
                strategy: profile?.strategy || '',
              }}
              fields={[
                { name: 'market_position', label: 'Market position', type: 'textarea' },
                { name: 'overview', label: 'Overview', type: 'textarea' },
                { name: 'strategy', label: 'Strategy / appetite', type: 'textarea' },
              ]}
              onSubmit={async (v) => { await api('PUT', `/markets/${id}/profile`, v); market.reload(); }}
            />
          </>
        )}
      </Card>

      {/* ---- News ---- */}
      <Card title="Latest news">
        <table>
          <thead><tr><th>Date</th><th>Headline</th><th>Source</th>{broker && <th />}</tr></thead>
          <tbody>
            {m.news.map((n) => (
              <tr key={n.id}>
                <td>{n.published_at ? String(n.published_at).slice(0, 10) : '—'}</td>
                <td>
                  {n.url
                    ? <a href={n.url} target="_blank" rel="noreferrer">{n.headline}</a>
                    : n.headline}
                  {n.summary && <div className="muted small">{n.summary}</div>}
                </td>
                <td><span className="muted small">{n.source === 'ai' ? 'gathered' : 'manual'}</span></td>
                {broker && (
                  <td className="right">
                    <button
                      className="ghost small"
                      onClick={() => act(`news-${n.id}`, () => api('DELETE', `/markets/${id}/news/${n.id}`))}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {m.news.length === 0 && <tr><td colSpan={broker ? 4 : 3} className="muted">No news recorded.</td></tr>}
          </tbody>
        </table>
        {broker && (
          <>
            <h3>Add an item</h3>
            <Form
              submitLabel="Add news"
              fields={[
                { name: 'headline', label: 'Headline', required: true },
                { name: 'published_at', label: 'Date', type: 'date' },
                { name: 'url', label: 'Link' },
                { name: 'summary', label: 'Summary' },
              ]}
              onSubmit={async (v) => { await api('POST', `/markets/${id}/news`, v); market.reload(); }}
            />
          </>
        )}
      </Card>

      {/* ---- Five-year financials ---- */}
      <Financials market={m} id={id} broker={broker} onChange={market.reload} act={act} busy={busy} />

      {/* ---- Business placed ---- */}
      {m.type === 'reinsurer' && (
        <Card title="Business placed with this market">
          <dl className="kv">
            <dt>Lines</dt>
            <dd>{b.lines_count} ({b.lead_lines} as lead, {b.follow_lines} as follow)</dd>
            <dt>Share written</dt>
            <dd>
              <Pct value={b.total_share} /> total ·{' '}
              <Pct value={b.lead_share} /> lead · <Pct value={b.follow_share} /> follow
            </dd>
            <dt>Signed premium</dt><dd><Money amount={b.premium_signed} /></dd>
            <dt>Approaches</dt>
            <dd>{b.approaches_count} ({b.declined_approaches} declined)</dd>
          </dl>
          <table>
            <thead><tr><th>Placement</th><th>Layer</th><th>Role</th><th className="right">Written</th><th className="right">Signed</th><th>Status</th></tr></thead>
            <tbody>
              {m.placements.map((p) => (
                <tr key={p.line_id}>
                  <td>
                    <Link to={`/placements/${p.placement_id}`}>{p.reference}</Link>
                    {p.cedant_name && <div className="muted small">{p.cedant_name}</div>}
                  </td>
                  <td><Link to={`/layers/${p.layer_id}`}>{p.layer_name}</Link></td>
                  <td>{p.role || '—'}</td>
                  <td className="right"><Pct value={p.written_pct} /></td>
                  <td className="right"><Pct value={p.signed_pct} /></td>
                  <td><StatusPill value={p.status} /></td>
                </tr>
              ))}
              {m.placements.length === 0 && <tr><td colSpan="6" className="muted">No business placed yet.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}

      {m.cedants.length > 0 && (
        <Card title="Cedant record">
          <p className="muted small">
            This counterparty is also a cedant: {m.cedants.map((x) => x.name).join(', ')}.
          </p>
        </Card>
      )}
    </>
  );
}

/**
 * Five years of headline financials, newest first. Years run across the top
 * because that is how an analyst reads a trend; each metric is a row.
 */
function Financials({ market, id, broker, onChange, act, busy }) {
  const [csv, setCsv] = useState('');
  const years = market.financials.slice(0, 8);

  function cell(f, row) {
    const v = f[row.key];
    if (v == null) return <span className="muted">—</span>;
    return row.money
      ? <Money amount={v} currency={f.currency} />
      : <span>{Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span>;
  }

  return (
    <Card title="Five-year financials">
      {years.length === 0 ? (
        <p className="muted">
          Nothing recorded. Upload the figures below, or gather them from the internet with the
          group summary.
        </p>
      ) : (
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th />
                {years.map((f) => (
                  <th key={f.year} className="right">
                    {f.year}
                    <div className="muted small">{f.source === 'ai' ? 'gathered' : 'manual'}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FINANCIAL_ROWS.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  {years.map((f) => <td key={f.year} className="right">{cell(f, row)}</td>)}
                </tr>
              ))}
              {broker && (
                <tr>
                  <td />
                  {years.map((f) => (
                    <td key={f.year} className="right">
                      <button
                        className="ghost small"
                        disabled={busy === `fin-${f.year}`}
                        onClick={() => act(`fin-${f.year}`, () => api('DELETE', `/markets/${id}/financials/${f.year}`))}
                      >
                        Remove
                      </button>
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {broker && (
        <>
          <h3>Add or amend a year</h3>
          <Form
            submitLabel="Save year"
            initial={{ currency: 'USD' }}
            fields={[
              { name: 'year', label: 'Year', type: 'number', required: true },
              { name: 'currency', label: 'Currency' },
              { name: 'gwp', label: 'GWP', type: 'number', step: 'any' },
              { name: 'nwp', label: 'NWP', type: 'number', step: 'any' },
              { name: 'net_income', label: 'Net income', type: 'number', step: 'any' },
              { name: 'shareholders_equity', label: "Shareholders' equity", type: 'number', step: 'any' },
              { name: 'total_assets', label: 'Total assets', type: 'number', step: 'any' },
              { name: 'loss_ratio', label: 'Loss ratio %', type: 'number', step: 'any' },
              { name: 'expense_ratio', label: 'Expense ratio %', type: 'number', step: 'any' },
              { name: 'combined_ratio', label: 'Combined ratio %', type: 'number', step: 'any' },
              { name: 'roe', label: 'ROE %', type: 'number', step: 'any' },
            ]}
            onSubmit={async (v) => {
              const row = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x != null));
              await api('PUT', `/markets/${id}/financials`, { financials: [row] });
              onChange();
            }}
          />

          <h3>Upload a CSV</h3>
          <p className="muted small">One row per year. Header: <code>{CSV_TEMPLATE}</code></p>
          <form
            className="inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              await act('csv', async () => {
                await api('POST', `/markets/${id}/financials/import`, { csv });
                setCsv('');
              });
            }}
          >
            <label className="field grow">
              <span>CSV</span>
              <textarea rows="4" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={CSV_TEMPLATE} required />
            </label>
            <button type="submit" disabled={busy === 'csv' || !csv.trim()}>
              {busy === 'csv' ? 'Uploading…' : 'Upload financials'}
            </button>
          </form>
          <p className="muted small">
            Or drop a file:{' '}
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setCsv(await file.text());
                e.target.value = '';
              }}
            />
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * The named underwriters at a market and the address a submission goes to.
 * This is the list the negotiation tab picks from, so deactivating a contact
 * simply drops it out of that list without touching what was already sent.
 */
function Underwriters({ marketId, canEdit }) {
  const contacts = useFetch('GET', `/markets/${marketId}/contacts`, [marketId]);
  const [error, setError] = useState(null);

  async function act(fn) {
    setError(null);
    try { await fn(); contacts.reload(); } catch (e) { setError(e); }
  }

  return (
    <div>
      {canEdit && (
        <Form
          submitLabel="Add underwriter"
          initial={{ role: 'underwriter' }}
          fields={[
            { name: 'name', label: 'Name', required: true, placeholder: 'Jo Smith' },
            { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'jo.smith@market.example' },
            { name: 'role', label: 'Role', placeholder: 'underwriter' },
            { name: 'is_primary', label: 'Primary', type: 'checkbox' },
          ]}
          onSubmit={async (v) => { await api('POST', `/markets/${marketId}/contacts`, v); contacts.reload(); }}
        />
      )}
      <ErrorBanner error={error} />
      <ErrorBanner error={contacts.error} />
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Primary</th><th>Status</th><th /></tr></thead>
        <tbody>
          {contacts.data?.map((c) => (
            <tr key={c.id} className={c.active ? '' : 'muted'}>
              <td>{c.name}</td>
              <td>{c.email}</td>
              <td>{c.role || '—'}</td>
              <td>{c.is_primary ? '★' : ''}</td>
              <td>{c.active ? 'active' : 'inactive'}</td>
              <td className="right">
                {canEdit && (c.active
                  ? <button className="small ghost" onClick={() => act(() => api('DELETE', `/market-contacts/${c.id}`))}>Deactivate</button>
                  : <button className="small ghost" onClick={() => act(() => api('PATCH', `/market-contacts/${c.id}`, { active: true }))}>Reactivate</button>)}
              </td>
            </tr>
          ))}
          {contacts.data?.length === 0 && <tr><td colSpan="6" className="muted">No underwriter emails on file.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
