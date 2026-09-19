import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useScreenHead } from '../shell.jsx';
import ContractPicker from './servicing/ContractPicker.jsx';
import './servicing/servicing.css';
import './servicing/premium.css';
import './servicing/claims.css';

const root = '/claims-premiums/non-proportional';
const fmt = n => n == null || n === '' ? '—' : Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => Number(n).toLocaleString('en-GB', { maximumFractionDigits: 4 });
const fresh = p => ({ name: '', reference: '', description: '', loss_date: p.inception, cat_event: false, retained_loss: '', paid: '', outstanding: '' });
const cents = n => n === '' || n == null || !Number.isFinite(Number(n)) || Number(n) < 0 || Number(n) > 1e12 || Math.abs(Number(n) - Math.round(Number(n) * 100) / 100) > 1e-7 ? null : Math.round(Number(n) * 100);

function MoneyCell({ value, strong = false }) { return <td className="cw-money">{strong ? <b>{fmt(value)}</b> : fmt(value)}</td>; }
function CalculationRows({ rows, byMarket = false, label = 'Layer' }) {
  return <div className="pw-scroll"><table className="cw-figures"><thead><tr><th>{byMarket ? 'Reinsurer' : label}</th>{byMarket && <th>Signed</th>}<th>Total recovery</th><th>Paid recovery</th><th>Outstanding recovery</th><th>Reinstatement premium</th><th>Net total</th><th>Net paid</th><th>Net outstanding</th></tr></thead><tbody>
    {rows.map(r => <tr key={r.key || r.market_id}><td><b>{r.name || r.market_name}</b></td>{byMarket && <td>{pct(r.signed_pct)}%</td>}<MoneyCell value={r.recovery}/><MoneyCell value={r.paid_recovery}/><MoneyCell value={r.outstanding_recovery}/><MoneyCell value={r.reinstatement_premium}/><MoneyCell value={r.net} strong/><MoneyCell value={r.net_paid}/><MoneyCell value={r.net_outstanding}/></tr>)}
  </tbody></table></div>;
}

export default function ClaimsWorkspace() {
  useScreenHead('Claims & premium / Non-Proportional', 'Claims workspace');
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const contract = params.get('contract') || '', selectedClaim = params.get('claim') || '';
  const [contracts, setContracts] = useState([]), [listLoading, setListLoading] = useState(true), [listError, setListError] = useState('');
  // The workspace opens on the question — which contract? — until one is in the URL.
  const [choosing, setChoosing] = useState(!contract);
  useEffect(() => { if (!contract) setChoosing(true); }, [contract]);
  const [data, setData] = useState(null), [wf, setWf] = useState(null), [input, setInput] = useState(null), [claimId, setClaimId] = useState('');
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0), [dirty, setDirty] = useState(false), [preview, setPreview] = useState(null), [reviewer, setReviewer] = useState(''), [reason, setReason] = useState('');
  useEffect(() => {
    let alive = true;
    api('GET', '/claims-workspace/contracts').then(r => { if (alive) { setContracts(r); setListError(''); } }).catch(e => { if (alive) setListError(e.message); }).finally(() => { if (alive) setListLoading(false); });
    return () => { alive = false; };
  }, [revision]);
  useEffect(() => {
    let alive = true; setData(null); setWf(null); setInput(null); setPreview(null); setDirty(false); setError(''); setReviewer(''); setReason('');
    if (!contract) { setLoading(false); return; }
    setLoading(true);
    (async () => {
      try {
        const d = await api('GET', `/claims-workspace/contracts/${contract}`);
        const w = selectedClaim ? await api('GET', `/claims-workspace/claims/${selectedClaim}`) : null;
        if (w && w.placement_id !== contract) throw new Error('This claim belongs to another contract. Select it from that contract’s register.');
        if (!alive) return;
        setData(d); setWf(w); setInput(w?.input || fresh(d.placement)); setClaimId(w?.loss_event_id || crypto.randomUUID()); setReviewer(w?.reviewer_id || '');
      } catch (e) { if (alive) setError(e.message); } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [contract, selectedClaim, revision]);
  const canPrepare = ['broker', 'senior_broker', 'admin'].includes(user.role);
  const locked = busy || !canPrepare || !!(wf && (wf.status !== 'draft' || wf.created_by !== user.id));
  const balance = input && [input.retained_loss, input.paid, input.outstanding].every(v => cents(v) != null) ? cents(input.retained_loss) - cents(input.paid) - cents(input.outstanding) : null;
  const balanced = balance === 0;
  const result = preview || (!dirty ? wf?.snapshot : null);
  const layers = wf && wf.status !== 'draft' ? wf.snapshot.layers : data?.layers || [];
  const markets = [...new Map(layers.flatMap(l => l.lines).map(m => [m.market_id, m])).values()];
  const change = (key, value) => { setInput(i => ({ ...i, [key]: value })); setDirty(true); setPreview(null); };
  const act = async fn => { setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const calculate = () => act(async () => { setPreview(await api('POST', `/claims-workspace/contracts/${contract}/preview`, { input, claim_id: claimId })); setNotice('Calculated at 100% and allocated at the actual signed shares.'); });
  const save = () => act(async () => {
    const w = await api('PUT', `/claims-workspace/claims/${claimId}`, { placement_id: contract, input, revision: wf?.revision || 0 });
    setWf(w); setInput(w.input); setPreview(w.snapshot); setDirty(false); setParams({ contract, claim: claimId }); setRevision(r => r + 1); setNotice('Claim saved with its paid and outstanding split. Review the calculation before submitting.');
  });
  const transition = (action, body) => act(async () => {
    await api('POST', `/claims-workspace/claims/${wf.loss_event_id}/${action}`, body);
    setRevision(r => r + 1); setNotice(action === 'approve' ? 'The claim calculation has been independently approved and recorded.' : action === 'submit' ? 'Submitted to the independent reviewer.' : action === 'reopen' ? 'Revision started. Previous approved figures remain in the history.' : 'Returned to the preparer for changes.');
  });
  return <div className="screen sv pw cw">
    <div className="sv-navigation"><Link className="sv-back" to={root}>← Non-Proportional dashboard</Link><span className="sv-context"><i/> CLAIMS SERVICING</span></div>
    <section className="pw-hero"><div><span className="sv-eyebrow">FROM RETAINED LOSS TO REINSURER RECOVERY</span><h1>One loss.<br/><em>Every layer accounted for.</em></h1><p>Reconcile the loss. Apply the treaty. See what each reinsurer owes.</p></div><div className="pw-hero-card"><span>THE RECONCILIATION</span><b>Paid + outstanding<br/>= retained loss at 100%</b><small>Layer recoveries, reinstatement premiums and net shares calculated together.</small></div></section>
    {choosing && <ContractPicker kicker="CLAIMS SERVICING" title="Which contract’s claims?" contracts={contracts} loading={listLoading} error={listError} currentId={contract} onChoose={id => { setChoosing(false); setParams({ contract: id }); setNotice(''); }} onClose={() => setChoosing(false)}/>}
    {!contract && <section className="pw-panel"><div className="pw-panel-head"><div><span className="sv-eyebrow">CHOOSE A CONTRACT</span><h2>Which contract’s claims?</h2></div><button className="sv-button" onClick={() => setChoosing(true)}>Choose a contract</button></div><p className="pw-formula">Pick the country, the cedant and the contract. Its claims register, placed structure and signed shares then open below.</p></section>}
    {loading && <div className="sv-loading" role="status">Loading the treaty structure, signing and claims register…</div>}
    {error && <div className="pw-error" role="alert">{error}</div>}{notice && <div className="pw-notice" role="status">{notice}</div>}
    {data && input && <>
      <div className="pw-treaty-heading"><div><span className="sv-eyebrow">{data.placement.reference}</span><h2>{data.placement.cedant_name}</h2><p>{data.placement.class_of_business} · {data.placement.inception} to {data.placement.expiry} · {data.source}</p></div><div className="pw-inline-actions"><button className="pw-outline" disabled={busy} onClick={() => setChoosing(true)}>Change contract</button><Link className="pw-outline" to={`${root}/premium?contract=${contract}`}>Open premium accounts ↗</Link></div></div>
      <ol className="pw-steps">{['Contract selected', 'Capture & calculate', 'Independent review', 'Approved calculation'].map((step, i) => <li key={step} className={i <= (wf?.status === 'approved' ? 3 : wf?.status === 'submitted' ? 2 : 1) ? 'done' : ''}><span>{String(i + 1).padStart(2, '0')}</span>{step}</li>)}</ol>
      <section className="pw-panel"><div className="pw-panel-head"><div><span className="sv-eyebrow">CLAIMS REGISTER</span><h2>{data.claims.length} recorded {data.claims.length === 1 ? 'claim' : 'claims'}</h2></div>{canPrepare && <button className="pw-outline" disabled={busy} onClick={() => { setParams({ contract }); setRevision(r => r + 1); setNotice(''); }}>+ New claim</button>}</div>
        <div className="cw-register">{data.claims.map(c => <div key={c.id} className={`cw-claim-row ${c.id === selectedClaim ? 'selected' : ''}`}><div><b>{c.reference || c.name}</b><small>{c.name} · {c.loss_date} · {c.status.replaceAll('_', ' ')}</small></div><b>{data.placement.currency} {fmt(c.gross_loss)}</b>{c.workspace_claim ? <button className="pw-download" disabled={busy} onClick={() => { setParams({ contract, claim: c.id }); setNotice(''); }}>Open claim →</button> : <Link className="pw-download" to={`/placements/${contract}/claims`}>Open existing loss exhibit ↗</Link>}</div>)}{!data.claims.length && <p className="pw-empty">Start the first claim for this contract below.</p>}</div>
      </section>
      <section className="pw-panel"><div className="pw-panel-head"><div><span className="sv-eyebrow">01 / THE PLACED STRUCTURE</span><h2>Limits, deductibles & premium</h2></div><span className="sv-count">Amounts at 100%</span></div><div className="pw-scroll"><table><thead><tr><th>Layer</th><th>Currency</th><th>Limit</th><th>Deductible</th><th>Annual aggregate deductible</th><th>Reinstatements</th><th>Annual premium</th><th>MDP</th><th>Cover</th></tr></thead><tbody>{layers.map(l => <tr key={l.key}><td><b>{l.name}</b></td><td>{l.currency}</td><MoneyCell value={l.limit_amt}/><MoneyCell value={l.attachment}/><MoneyCell value={l.aad || 0}/><td>{l.reinstatements == null || l.reinstatements === '' ? '0 · not recorded' : `${l.reinstatements} @ ${l.reinstatement_pct ?? 100}%`}</td><MoneyCell value={l.premium100}/><MoneyCell value={data.baseline[l.key]?.deposit_premium}/><td>{l.risk_cover !== false ? 'Risk' : ''}{l.risk_cover !== false && l.cat_cover !== false ? ' + ' : ''}{l.cat_cover !== false ? 'Cat' : ''}</td></tr>)}</tbody></table></div></section>
      <section className="pw-panel"><div className="pw-panel-head"><div><span className="sv-eyebrow">02 / SIGNING BY LAYER</span><h2>The reinsurer panel</h2></div><span className="pw-muted">Actual signed shares · not normalised</span></div><div className="pw-scroll"><table><thead><tr><th>Reinsurer</th>{layers.map(l => <th key={l.key}>{l.name}</th>)}</tr></thead><tbody>{markets.map(m => <tr key={m.market_id}><td><b>{m.market_name}</b></td>{layers.map(l => <td key={l.key}>{l.lines.some(x => x.market_id === m.market_id) ? `${pct(l.lines.find(x => x.market_id === m.market_id).signed_pct)}%` : '—'}</td>)}</tr>)}<tr className="pw-total-row"><td>Total signed</td>{layers.map(l => <td key={l.key}>{pct(l.lines.reduce((sum, m) => sum + Number(m.signed_pct), 0))}%</td>)}</tr></tbody></table></div></section>
      {wf?.stale && <div className="pw-error" role="alert">This saved calculation is out of date: the structure, signing or earlier claims have changed. {wf.status === 'approved' ? 'Reconcile the approved claim before relying on these figures.' : 'The preparer must recalculate and save before approval.'}{wf.stale_reason && <p>{wf.stale_reason}</p>}</div>}
      {wf?.return_reason && <div className="pw-notice"><b>Returned for changes:</b> {wf.return_reason}</div>}
      <section className="pw-panel"><div className="pw-panel-head"><div><span className="sv-eyebrow">03 / CAPTURE THE LOSS</span><h2>Retained loss at 100%</h2></div><span className="sv-count">{wf?.status || 'New claim'} · {data.placement.currency}</span></div>
        <p className="pw-formula">Enter the cedant’s retained loss entering this treaty, before applying its layer deductibles. Paid and outstanding are amounts in {data.placement.currency}, on the same 100% basis.</p>
        <fieldset className="cw-inputs" disabled={locked}><div className="pw-term-fields"><label><span>Claim / event name</span><input aria-label="Claim or event name" value={input.name} onChange={e => change('name', e.target.value)}/></label><label><span>Claim reference</span><input aria-label="Claim reference" value={input.reference || ''} onChange={e => change('reference', e.target.value)}/></label><label><span>Date of loss</span><input aria-label="Date of loss" type="date" min={data.placement.inception} max={data.placement.expiry} value={input.loss_date} onChange={e => change('loss_date', e.target.value)}/></label><label><span>Event type</span><select aria-label="Event type" value={input.cat_event ? 'cat' : 'risk'} onChange={e => change('cat_event', e.target.value === 'cat')}><option value="risk">Risk loss</option><option value="cat">Catastrophe loss</option></select></label></div>
          <div className="cw-loss-inputs">{[['retained_loss', 'Retained loss · 100%'], ['paid', 'Paid loss'], ['outstanding', 'Outstanding loss']].map(([key, label]) => <label key={key}><span>{label}</span><div><small>{data.placement.currency}</small><input aria-label={label} type="number" min="0" max="1000000000000" step="0.01" placeholder="0.00" value={input[key]} onChange={e => change(key, e.target.value)}/></div></label>)}</div>
          <label className="cw-description"><span>Loss description</span><textarea aria-label="Loss description" placeholder="Insured, cause and relevant claim details…" value={input.description || ''} onChange={e => change('description', e.target.value)}/></label>
        </fieldset>
        <div className={`cw-reconciliation ${balanced ? 'balanced' : ''}`} role="status"><span>{balanced ? '✓ Reconciled' : balance == null ? 'Complete the three loss amounts' : 'Amounts do not reconcile'}</span><b>{balance == null ? 'Paid + outstanding = retained loss' : balanced ? `${data.placement.currency} ${fmt(input.paid)} + ${fmt(input.outstanding)} = ${fmt(input.retained_loss)}` : `Difference: ${data.placement.currency} ${fmt(balance / 100)}`}</b></div>
        {!locked && <div className="pw-form-actions"><button className="pw-outline" disabled={!balanced || !input.name.trim()} onClick={calculate}>Calculate recoveries</button><button className="sv-button" disabled={!balanced || !input.name.trim()} onClick={save}>Save & calculate</button></div>}
      </section>
      {result && <>
        <div className="cw-summary">{[['Total layer recovery', result.totals.recovery, '100% · paid + outstanding'], ['Reinstatement premium', result.totals.reinstatement_premium, 'Deducted from recovery'], ['Net layer recovery', result.totals.net, '100% · after reinstatement'], ['Net signed recovery', result.placed_totals.net, 'Actual placed shares']].map(([label, value, hint]) => <div key={label}><span>{label}</span><b><small>{result.placement.currency}</small> {fmt(value)}</b><p>{hint}</p></div>)}</div>
        <section className="pw-panel"><div className="pw-panel-head"><div><span className="sv-eyebrow">04 / LOSS THROUGH THE LAYERS</span><h2>Recovery less reinstatement premium</h2></div><span className="sv-count">{result.placement.currency} · 100%</span></div>
          <p className="pw-formula">Paid recovery applies the deductible and limit to the paid loss. Outstanding recovery is the remaining incurred recovery. Reinstatement premium follows the existing pro-rata-to-amount, 100%-as-to-time basis. Net outstanding is a reserve, not a current payment request.</p>
          <CalculationRows rows={result.layers.filter(l => l.calculation).map(l => ({ key: l.key, name: l.name, ...l.calculation }))}/>
          <div className="cw-layer-context">{result.layers.map(l => <div key={l.key}><b>{l.name}</b>{l.excluded ? <span>{l.excluded}</span> : <span>Prior aggregate used: {fmt(l.calculation.consumed_before)} · AAD applied: {fmt(l.calculation.aad_applied)} · Reinstatement premium paid / outstanding: {fmt(l.calculation.paid_reinstatement_premium)} / {fmt(l.calculation.outstanding_reinstatement_premium)} · Aggregate remaining: {l.calculation.remaining_aggregate == null ? 'Unlimited' : fmt(l.calculation.remaining_aggregate)}</span>}</div>)}<p>{result.preceding_claims} earlier recorded claims considered, ordered by loss date then creation time. Claims in other layer currencies are excluded until a conversion basis is agreed.</p></div>
        </section>
        <section className="pw-panel"><div className="pw-panel-head"><div><span className="sv-eyebrow">05 / REINSURER ALLOCATION</span><h2>Every share, reconciled</h2></div><span className="sv-count">{result.placement.currency} · signed amounts</span></div>
          {result.layers.filter(l => l.calculation).map(l => <details className="pw-account-layer" key={l.key} open><summary>{l.name}<span>{pct(l.lines.reduce((sum, m) => sum + Number(m.signed_pct), 0))}% placed</span></summary><CalculationRows byMarket rows={l.calculation.markets}/></details>)}
          <div className="pw-panel-head"><h3>Reinsurer totals across all layers</h3></div><CalculationRows rows={result.markets} label="Reinsurer"/>
          <div className="cw-net-split"><div><span>Net paid recovery · signed</span><b>{result.placement.currency} {fmt(result.placed_totals.net_paid)}</b></div><div><span>Net outstanding reserve · signed</span><b>{result.placement.currency} {fmt(result.placed_totals.net_outstanding)}</b></div><div><span>Net incurred recovery · signed</span><b>{result.placement.currency} {fmt(result.placed_totals.net)}</b></div></div>
        </section>
      </>}
      {wf && <section className="pw-approval"><div><span className="sv-eyebrow">INDEPENDENT CONTROL</span><h2>{wf.status === 'approved' ? 'Calculation approved' : wf.status === 'submitted' ? 'Awaiting independent review' : 'Approve and submit for review'}</h2><p>The reviewer checks the retained loss, paid and outstanding split, layer recoveries and reinsurer allocations. Approval records and locks the calculation.</p>{wf.status === 'approved' && <p>Approved {String(wf.approved_at).slice(0, 10)}</p>}</div><div className="pw-approval-actions">
        {wf.status === 'draft' && wf.created_by === user.id && canPrepare && <><label><span>Independent approver</span><select aria-label="Independent approver" value={reviewer} onChange={e => setReviewer(e.target.value)}><option value="">Choose a different person</option>{data.reviewers.filter(r => r.id !== user.id).map(r => <option key={r.id} value={r.id}>{r.name} · {r.role.replaceAll('_', ' ')}</option>)}</select></label><button className="sv-button" disabled={busy || dirty || wf.stale || !reviewer} onClick={() => transition('submit', { reviewer_id: reviewer })}>Approve & submit</button>{dirty && <small>Save the updated calculation before submitting.</small>}</>}
        {wf.status === 'submitted' && wf.reviewer_id === user.id && <><button className="sv-button" disabled={busy || wf.stale} onClick={() => transition('approve', {})}>Approve claim calculation</button><textarea aria-label="Reason for return" placeholder="What needs to change?" value={reason} onChange={e => setReason(e.target.value)}/><button className="pw-outline" disabled={busy || reason.trim().length < 5} onClick={() => transition('return', { reason })}>Return for changes</button></>}
        {wf.status === 'submitted' && wf.reviewer_id !== user.id && <span className="pw-waiting">Assigned to {data.reviewers.find(r => r.id === wf.reviewer_id)?.name || 'the independent reviewer'}</span>}
        {wf.status === 'approved' && wf.created_by === user.id && canPrepare && <button className="pw-outline" disabled={busy} onClick={() => transition('reopen', {})}>Update claim · new revision</button>}
      </div></section>}
      {!!wf?.history?.length && <section className="pw-panel"><div className="pw-panel-head"><div><span className="sv-eyebrow">APPROVED HISTORY</span><h2>Every approved position, preserved</h2></div></div><div className="pw-scroll"><table><thead><tr><th>Revision</th><th>Approved by</th><th>Date</th><th>Retained loss</th><th>Paid</th><th>Outstanding</th><th>Net signed recovery</th></tr></thead><tbody>{wf.history.map(h => <tr key={h.revision}><td>v{h.revision}</td><td>{h.approver_name}</td><td>{String(h.approved_at).slice(0, 10)}</td><MoneyCell value={h.input.retained_loss}/><MoneyCell value={h.input.paid}/><MoneyCell value={h.input.outstanding}/><MoneyCell value={h.snapshot.placed_totals.net} strong/></tr>)}</tbody></table></div></section>}
    </>}
  </div>;
}
