import { Link } from 'react-router-dom';
import Topbar from '../../components/Topbar';
import { useAppState } from '../../context/AppContext';

export default function HomeScreen() {
  const { session, config, brokingEnabled } = useAppState();
  return (
    <div className="ab ab-app">
      <Topbar />
      <main className="ab-main ab-home">
        <span className="ab-pill">Afro_Asian_Business_Intelligence</span>
        <div className="ab-summary"><b>{session?.orgName || '—'}</b><span className="ab-sep">·</span><b>{session?.displayName || '—'}</b><span className="ab-sep">·</span><span>Lloyd's broker no. <b>{session?.lloydsBrokerNo || '—'}</b></span></div>
        <div className="ab-grid-2">
          <div className="ab-pane">
            <div className="ab-pane-head"><span className="ab-pane-title">Broking</span><span className="ab-tag">{brokingEnabled ? 'Enabled' : 'Off'}</span></div>
            <div className="ab-pane-body">
              {brokingEnabled ? (
                <>
                  <p className="ab-help">Capture treaty contracts keyed by UUID and UMR: identify, treaty detail or contract details, structure.</p>
                  <div className="ab-actions"><Link className="ab-btn ghost" to="/broking">Contract list</Link><Link className="ab-btn primary" to="/broking/new">New contract</Link></div>
                </>
              ) : (
                <p className="ab-help">{config ? 'The broking module is disabled on this server (BROKING_ENABLED). Ask an administrator to enable it.' : 'Loading configuration…'}</p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
