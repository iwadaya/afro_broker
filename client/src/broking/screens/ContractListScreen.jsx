// /broking — the contract list with search by UMR prefix, cedant, UW year or status.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/Topbar';
import Badge from '../components/Badge';
import Button from '../components/Button';
import { api, errorBody } from '../../api';
import { firstCaptureStep } from '../steps';
import { formatDateTime } from '../lib/format';

export default function ContractListScreen() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [state, setState] = useState({ loading: true, error: '' });

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      setState((s) => ({ ...s, loading: true }));
      api.broking.listContracts(search).then((r) => { if (!cancelled) { setRows(Array.isArray(r) ? r : []); setState({ loading: false, error: '' }); } })
        .catch((e) => { if (!cancelled) setState({ loading: false, error: errorBody(e)?.error || e.message }); });
    }, search ? 250 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search]);

  const open = (c) => navigate(`/broking/${c.contractId}/${firstCaptureStep(c.businessType)}`);

  return (
    <div className="ab ab-app">
      <Topbar />
      <main className="ab-main">
        <span className="ab-pill">Broking: contracts</span>
        <div className="ab-list-toolbar">
          <input className="ab-in" type="search" placeholder="Search by UMR, cedant, UW year or status…" aria-label="Search contracts" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Button variant="primary" to="/broking/new">New contract</Button>
        </div>
        {state.error && <div className="ab-notice danger" role="alert">{state.error}</div>}
        <div className="ab-table-wrap">
          <table className="ab-table ab-list" aria-label="Contracts">
            <thead><tr><th>UMR</th><th>Cedant</th><th>Country</th><th>Treaty type</th><th>Business</th><th>UW year</th><th>Currency</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.contractId} tabIndex={0} onClick={() => open(c)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(c); } }} data-testid="contract-row">
                  <td className="ab-mono">{c.umr}</td><td>{c.cedantName || '—'}</td><td>{c.countryName || '—'}</td><td>{c.treatyTypeName || '—'}</td>
                  <td>{c.businessType === 'NON_PROPORTIONAL' ? 'Non-proportional' : 'Proportional'}</td><td>{c.uwYear || '—'}</td><td>{c.currencyCode || '—'}</td>
                  <td><Badge status={c.status} /></td><td>{formatDateTime(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!state.loading && rows.length === 0 && <div className="ab-empty">{search ? 'No contracts match that search.' : 'No contracts yet — create the first one.'}</div>}
          {state.loading && rows.length === 0 && <div className="ab-empty">Loading…</div>}
        </div>
      </main>
    </div>
  );
}
