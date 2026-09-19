// /broking/new — the Identify step: UMR + business type (+ optional renewal parent).
// Wires IdentityField to the broking API and routes to the first capture step
// (Treaty Detail for proportional, Contract Details for non-proportional).
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Topbar from '../../components/Topbar';
import IdentityField from '../components/IdentityField';
import Button from '../components/Button';
import { api } from '../../api';
import { firstCaptureStep } from '../steps';

export default function IdentifyScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.broking.settings().then((s) => { if (!cancelled) setSettings(s); }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  const initialType = params.get('type') === 'NON_PROPORTIONAL' ? 'NON_PROPORTIONAL' : 'PROPORTIONAL';

  return (
    <div className="ab ab-app">
      <Topbar />
      <main className="ab-main">
        <div className="ab-list-toolbar" style={{ marginTop: 0 }}>
          <span className="ab-pill">Identify contract</span>
          <span className="ab-right" style={{ marginLeft: 'auto' }}><Button to="/broking">Back to contracts</Button></span>
        </div>
        {error && <div className="ab-notice danger" role="alert">Could not load the broking settings: {error}</div>}
        <div className="ab-grid-2">
          {settings ? (
            <IdentityField
              lloydsBrokerNo={settings.lloydsBrokerNo || ''}
              initialBusinessType={initialType}
              onCheck={(umr) => api.broking.byUmr(umr)}
              onCreate={(payload) => api.broking.create(payload)}
              onSearch={(term) => api.broking.listContracts(term)}
              onCreated={(r) => navigate(`/broking/${r.contractId}/${firstCaptureStep(r.businessType)}`)}
            />
          ) : <p className="ab-help">Loading…</p>}
          <section className="ab-pane" aria-label="About the UMR">
            <div className="ab-pane-head"><span className="ab-pane-title">About the UMR</span></div>
            <div className="ab-pane-body">
              <p className="ab-help">The Lloyd's Unique Market Reference identifies the placement across the market: <b>B</b>, the broker's 4-digit Lloyd's number, then 1–12 letters or digits. It is normalised (uppercase, no spaces) as you type, checked for format live and for uniqueness when you leave the field.</p>
              <p className="ab-help">After creation the UMR is read-only and can only be changed through the audited <b>Amend UMR</b> action in the summary bar. The system UUID is assigned on create and never typed.</p>
              <p className="ab-help"><b>Renewal of</b> copies the prior year's header, classes and details onto the new contract and rolls the inception date forward 12 months.</p>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
