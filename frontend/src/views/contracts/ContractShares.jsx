import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useFetch, ErrorBanner, ProgressBar } from '../../components.jsx';
import { useScreenHead } from '../../shell.jsx';
import { useHasRole } from '../../auth.jsx';
import { useToast } from '../../toast.jsx';
import WizardNav from '../../WizardNav.jsx';
import { useContractHeader, ContractSummary } from './ContractDetailsPane.jsx';
import { BASIS_LABEL, documentsPath } from './contractModel.js';
import { NumField } from './propTerms.jsx';
import { toNumber } from './calcs.js';
import { HOUSE } from '../../brand.js';

/**
 * Contracts → Shares: the third step of both workflows, after Documents —
 * who takes what of the programme, in percent of it:
 *
 *   BROKER SHARE — this desk (Afro-Asian Insurance Services, the lead broker by
 *   default) and any co-broker the order is split with. Each broker has
 *   its Order (100% unless split), its Placed order — the reinsurers'
 *   signed total, pro rata to the order — and a placement bar showing how
 *   far the order is placed.
 *   REINSURER SHARES — the panel, each reinsurer picked off the market
 *   register (its rating shows through) or typed, with a Lead mark, a
 *   Written share (the line put down), a Signed share (what it was signed
 *   down to), a market reference and a note.
 *
 * Totals foot each table, and the reinsurers' signed total says whether
 * the programme is fully placed, short, or over. The page saves the whole
 * table at once; the floating dock takes it Back to the documents (saving
 * first) and Save & done to the register. Ctrl+S saves.
 *
 * On a broker row the stored written share is its order; its stored
 * signed share is not used — the placed order is derived.
 */

let seq = 0;
const newRow = (party, patch = {}) => ({
  key: `r${++seq}`, party, market_id: null, name: '', role: 'follow', written_pct: '', signed_pct: '', reference: '', note: '', ...patch,
});
const pctStr = (v) => (v == null ? '' : String(v));
const fromApi = (r) => newRow(r.party, {
  market_id: r.market_id, name: r.name, role: r.role, written_pct: pctStr(r.written_pct), signed_pct: pctStr(r.signed_pct),
  reference: r.reference || '', note: r.note || '',
});
const hasContent = (r) => r.name.trim() || r.written_pct !== '' || r.signed_pct !== '';
const toApi = (r) => ({
  market_id: r.market_id || null, name: r.name.trim(), role: r.role,
  written_pct: toNumber(r.written_pct), signed_pct: r.party === 'broker' ? null : toNumber(r.signed_pct),
  reference: r.reference.trim() || null, note: r.note.trim() || null,
});
const round4 = (n) => Math.round(n * 10000) / 10000;
const sum = (rows, key) => round4(rows.reduce((t, r) => t + (toNumber(r[key]) || 0), 0));
const fmtPct = (n) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 })}%`;
/** The placement bar's colour for a status — with the words beside it, never on its own. */
const BAR_TONE = { ok: 'emerald', short: 'gold', over: 'red' };

/** Fully placed, short, or over: the reinsurers' signed total against 100%. */
function placedStatus(signed) {
  if (signed === 0) return null;
  if (Math.abs(signed - 100) < 0.00005) return { tone: 'ok', text: 'Fully placed' };
  if (signed < 100) return { tone: 'short', text: `${fmtPct(Math.round((100 - signed) * 10000) / 10000)} short` };
  return { tone: 'over', text: `${fmtPct(Math.round((signed - 100) * 10000) / 10000)} over` };
}

export default function ContractShares({ basis }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const canEdit = useHasRole('broker', 'admin');
  const placement = useFetch('GET', `/placements/${id}`, [id]);
  const shares = useFetch('GET', `/placements/${id}/shares`, [id]);
  const reinsurers = useFetch('GET', '/markets?type=reinsurer&limit=200', []);
  const brokers = useFetch('GET', '/markets?type=broker&limit=200', []);
  const pd = placement.data;
  useScreenHead(`Contracts · ${BASIS_LABEL[basis]} · 3 of 3`, 'Shares', pd?.reference || '');
  const h = useContractHeader({ pd, isNew: false, basis });

  const [brokerRows, setBrokerRows] = useState(null);
  const [reRows, setReRows] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const saveRef = useRef(null);
  const ro = !canEdit || busy;

  // The stored table; a contract without a broker share yet starts with this desk as the lead broker.
  const hydrate = (data) => {
    const b = (data?.broker || []).map(fromApi);
    setBrokerRows(b.length || !canEdit ? b : [newRow('broker', { name: HOUSE, role: 'lead', written_pct: '100' })]);
    setReRows((data?.reinsurers || []).map(fromApi));
    setDirty(false);
  };
  useEffect(() => { if (shares.data) hydrate(shares.data); }, [shares.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const reMarkets = reinsurers.data || [];
  const brokerMarkets = brokers.data || [];
  const marketById = useMemo(() => new Map([...reMarkets, ...brokerMarkets].map((m) => [m.id, m])), [reMarkets, brokerMarkets]);
  const marketByName = useMemo(() => {
    const map = new Map();
    for (const m of [...reMarkets, ...brokerMarkets]) map.set(`${m.type}:${m.name.trim().toLowerCase()}`, m);
    return map;
  }, [reMarkets, brokerMarkets]);

  const edit = (setRows) => (key, patch) => {
    setRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const editBroker = edit(setBrokerRows);
  const editRe = edit(setReRows);
  /** A typed name binds to the register's row of that name, so the rating and domicile read through. */
  const nameOf = (party) => (r, name) => {
    const m = marketByName.get(`${party === 'broker' ? 'broker' : 'reinsurer'}:${name.trim().toLowerCase()}`);
    return { name, market_id: m ? m.id : null };
  };
  const remove = (setRows) => (key) => { setRows((rows) => rows.filter((r) => r.key !== key)); setDirty(true); };
  const add = (setRows, party, patch) => () => { setRows((rows) => [...rows, newRow(party, patch)]); setDirty(true); };

  /** Write the table. Resolves true once saved, false when held or failed. */
  async function persist() {
    if (ro) return false;
    setError(null);
    const all = [...brokerRows, ...reRows].filter(hasContent);
    const unnamed = all.find((r) => !r.name.trim());
    if (unnamed) {
      setError(new Error(`Every share needs a name — ${unnamed.party === 'broker' ? 'the broker' : 'the reinsurer'} on a row with a share is blank.`));
      return false;
    }
    const over = all.find((r) => (toNumber(r.written_pct) ?? 0) > 100 || (toNumber(r.signed_pct) ?? 0) > 100 || (toNumber(r.written_pct) ?? 0) < 0 || (toNumber(r.signed_pct) ?? 0) < 0);
    if (over) {
      setError(new Error(`A share is a percentage of the programme, 0 to 100 — check ${over.name.trim()}.`));
      return false;
    }
    setBusy(true);
    try {
      const saved = await api('PUT', `/placements/${id}/shares`, {
        broker: brokerRows.filter(hasContent).map(toApi),
        reinsurers: reRows.filter(hasContent).map(toApi),
      });
      hydrate(saved);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (await persist()) toast('Shares saved.');
  }
  saveRef.current = save;

  /** Back saves what changed, then opens the documents. */
  async function back() {
    if (canEdit && dirty && !(await persist())) return;
    navigate(documentsPath(basis, id));
  }
  /** Save & done: the register, once the table is written. */
  async function done() {
    if (canEdit && !(await persist())) return;
    navigate('/contracts');
    if (canEdit) setTimeout(() => toast('Shares saved.'), 0);
  }

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') { e.preventDefault(); saveRef.current?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (placement.error) return <ErrorBanner error={placement.error} />;
  if (!pd || !h.ed) return null;

  // The placed order is the reinsurers' signed total; each broker's share of it follows its order.
  const placedPct = reRows ? sum(reRows, 'signed_pct') : 0;
  const placedOf = (r) => round4(placedPct * (toNumber(r.written_pct) || 0) / 100);
  const totals = brokerRows && reRows ? {
    broker: { order: sum(brokerRows, 'written_pct'), placed: round4(brokerRows.reduce((t, r) => t + placedOf(r), 0)) },
    re: { written: sum(reRows, 'written_pct'), signed: placedPct },
  } : null;
  const status = totals ? placedStatus(totals.re.signed) : null;

  return (
    <div className="screen contract-screen">
      <ContractSummary h={h} />
      {h.contractDescription && (
        <div className="td-contract"><span className="td-contract-label">Contract:</span>{h.contractDescription}</div>
      )}
      <ErrorBanner error={error || shares.error} />

      <div className="docs" data-testid="contract-shares">
        <div className="docs-chip">
          <span className="docs-chip-dot" />
          <span className="docs-chip-text">Shares of the programme</span>
        </div>
        <div className="docs-id">
          <b>CONTRACT ID:</b>{' '}<span className="mono">{pd.reference || '—'}</span>
          {' · '}written is the line put down, signed is what it was signed down to — both in percent of the programme
        </div>

        {!totals ? <div className="docs-empty">Loading…</div> : (
          <div className="td-grid td-grid--single">
            {/* ═══ BROKER SHARE ═══ */}
            <div className="td-card td-card--pane" data-testid="broker-shares">
              <div className="td-card-head">
                <span className="td-card-label">BROKER SHARE</span>
                <span className="td-card-tag">{brokerRows.length} {brokerRows.length === 1 ? 'BROKER' : 'BROKERS'}</span>
              </div>
              <div className="td-card-body">
                <div className="td-hint">
                  This desk's order — 100% unless a co-broker takes part of it. The placed order follows the
                  reinsurers' signed shares, pro rata to each order, and the bar shows how far the order is placed.
                </div>
                <table className="shares-table">
                  <thead>
                    <tr>
                      <th>Broker</th><th>Role</th><th className="r">Order</th><th className="r">Placed order</th>
                      <th>Placement</th><th>Note</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {brokerRows.map((r) => {
                      const m = r.market_id ? marketById.get(r.market_id) : null;
                      const order = toNumber(r.written_pct) || 0;
                      const placed = placedOf(r);
                      const progress = order > 0 ? round4((placed / order) * 100) : 0;
                      const st = order > 0 ? placedStatus(progress) : null;
                      const barText = order <= 0 ? 'No order' : st ? `${fmtPct(progress)} · ${st.text.toLowerCase()}` : `${fmtPct(0)} · nothing placed yet`;
                      return (
                        <tr key={r.key} data-testid="share-row">
                          <td>
                            <input className="fi" list="broker-names" value={r.name} readOnly={ro} aria-label="Broker" placeholder="Broker"
                              onChange={(e) => editBroker(r.key, nameOf('broker')(r, e.target.value))} />
                            {m?.domicile && <span className="shares-market-meta">{m.domicile}</span>}
                          </td>
                          <td className="role">
                            <select className="fi" value={r.role} disabled={ro} aria-label="Broker role" onChange={(e) => editBroker(r.key, { role: e.target.value })}>
                              <option value="lead">Lead broker</option>
                              <option value="follow">Co-broker</option>
                            </select>
                          </td>
                          <td className="pct">
                            <NumField suffix="%" value={r.written_pct} readOnly={ro} aria-label="Order %" placeholder="e.g. 100%"
                              onChange={(v) => editBroker(r.key, { written_pct: v })} />
                          </td>
                          <td className="placed mono" data-testid="broker-placed">{fmtPct(placed)}</td>
                          <td className="bar">
                            <div className="shares-bar" data-testid="placement-bar">
                              <ProgressBar value={progress} tone={BAR_TONE[st?.tone] || 'emerald'} showValue={false}
                                label={`Placement: ${fmtPct(progress)} of the order placed`} />
                              <span className="shares-bar-text">{barText}</span>
                            </div>
                          </td>
                          <td>
                            <input className="fi" value={r.note} readOnly={ro} aria-label="Broker note" placeholder="Optional"
                              onChange={(e) => editBroker(r.key, { note: e.target.value })} />
                          </td>
                          <td className="rm">
                            {canEdit && (
                              <button type="button" className="shares-rm" disabled={busy} aria-label={`Remove ${r.name || 'broker'}`} title="Remove"
                                onClick={() => remove(setBrokerRows)(r.key)}>×</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {brokerRows.length === 0 && <tr><td colSpan="7" className="muted">No broker share yet.</td></tr>}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan="2">Total</td>
                      <td className="r mono" data-testid="broker-total-order">{fmtPct(totals.broker.order)}</td>
                      <td className="r mono" data-testid="broker-total-placed">{fmtPct(totals.broker.placed)}</td>
                      <td colSpan="3" />
                    </tr>
                  </tfoot>
                </table>
                {canEdit && (
                  <div className="shares-add">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} data-testid="add-broker"
                      onClick={add(setBrokerRows, 'broker', brokerRows.length ? {} : { name: HOUSE, role: 'lead', written_pct: '100' })}>+ Add broker</button>
                  </div>
                )}
              </div>
            </div>

            {/* ═══ REINSURER SHARES ═══ */}
            <div className="td-card td-card--pane" data-testid="reinsurer-shares">
              <div className="td-card-head">
                <span className="td-card-label">REINSURER SHARES</span>
                <span className="td-card-head-actions">
                  {status && <span className={`shares-status shares-status--${status.tone}`} data-testid="placed-status">{status.text}</span>}
                  <span className="td-card-tag">{reRows.length} {reRows.length === 1 ? 'REINSURER' : 'REINSURERS'}</span>
                </span>
              </div>
              <div className="td-card-body">
                <div className="td-hint">The panel: each reinsurer off the market register or typed, its written line and its signed share.</div>
                <table className="shares-table">
                  <thead>
                    <tr>
                      <th>Reinsurer</th><th className="lead">Lead</th><th className="r">Written share</th><th className="r">Signed share</th>
                      <th>Reference</th><th>Note</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {reRows.map((r) => {
                      const m = r.market_id ? marketById.get(r.market_id) : null;
                      const meta = m ? [m.domicile, m.rating && `Rated ${m.rating}`, m.security_status && m.security_status !== 'approved' && `Security: ${m.security_status}`].filter(Boolean).join(' · ') : '';
                      return (
                        <tr key={r.key} data-testid="share-row">
                          <td>
                            <input className="fi" list="reinsurer-names" value={r.name} readOnly={ro} aria-label="Reinsurer" placeholder="Reinsurer"
                              onChange={(e) => editRe(r.key, nameOf('reinsurer')(r, e.target.value))} />
                            {meta && <span className="shares-market-meta" data-testid="share-market-meta">{meta}</span>}
                          </td>
                          <td className="lead">
                            <input type="checkbox" className="shares-lead" checked={r.role === 'lead'} disabled={ro} aria-label="Lead"
                              onChange={(e) => editRe(r.key, { role: e.target.checked ? 'lead' : 'follow' })} />
                          </td>
                          <td className="pct">
                            <NumField suffix="%" value={r.written_pct} readOnly={ro} aria-label="Written share %" placeholder="e.g. 25%"
                              onChange={(v) => editRe(r.key, { written_pct: v })} />
                          </td>
                          <td className="pct">
                            <NumField suffix="%" value={r.signed_pct} readOnly={ro} aria-label="Signed share %" placeholder="e.g. 20%"
                              onChange={(v) => editRe(r.key, { signed_pct: v })} />
                          </td>
                          <td className="ref">
                            <input className="fi" value={r.reference} readOnly={ro} aria-label="Reference" placeholder="Market ref."
                              onChange={(e) => editRe(r.key, { reference: e.target.value })} />
                          </td>
                          <td>
                            <input className="fi" value={r.note} readOnly={ro} aria-label="Reinsurer note" placeholder="Optional"
                              onChange={(e) => editRe(r.key, { note: e.target.value })} />
                          </td>
                          <td className="rm">
                            {canEdit && (
                              <button type="button" className="shares-rm" disabled={busy} aria-label={`Remove ${r.name || 'reinsurer'}`} title="Remove"
                                onClick={() => remove(setReRows)(r.key)}>×</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {reRows.length === 0 && <tr><td colSpan="7" className="muted">No reinsurer shares yet{canEdit ? ' — add the panel below.' : '.'}</td></tr>}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan="2">Total</td>
                      <td className="r mono" data-testid="reinsurer-total-written">{fmtPct(totals.re.written)}</td>
                      <td className="r mono" data-testid="reinsurer-total-signed">{fmtPct(totals.re.signed)}</td>
                      <td colSpan="3" />
                    </tr>
                  </tfoot>
                </table>
                {canEdit && (
                  <div className="shares-add">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} data-testid="add-reinsurer"
                      onClick={add(setReRows, 'reinsurer', reRows.length ? {} : { role: 'lead' })}>+ Add reinsurer</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* The register's names, offered as the rows are typed. */}
      <datalist id="reinsurer-names">
        {reMarkets.map((m) => <option key={m.id} value={m.name}>{[m.domicile, m.rating].filter(Boolean).join(' · ')}</option>)}
      </datalist>
      <datalist id="broker-names">
        {!brokerMarkets.some((m) => m.name === HOUSE) && <option value={HOUSE}>This desk</option>}
        {brokerMarkets.map((m) => <option key={m.id} value={m.name}>{m.domicile || ''}</option>)}
      </datalist>

      {/* The floating dock: Back to the documents, Save, Save & done to the register. */}
      <WizardNav
        hasPrev onBack={back} backLabel="Documents"
        hasNext onNext={done} nextLabel="Contracts"
        nextText={canEdit ? 'Save & done: Contracts' : 'Done: Contracts'}
        nextDisabled={busy}
      >
        {canEdit && (
          <button type="button" className="wizard-dock-btn wizard-dock-btn--save" disabled={busy || !dirty} onClick={save} data-testid="save-shares">
            {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        )}
      </WizardNav>
    </div>
  );
}
