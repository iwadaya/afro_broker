// /broking/:contractId/:step — the capture frame: WizardShell + the active step
// screen, the 409 dialog, Ctrl+S, and draft autosave when leaving a step.
import { useCallback, useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';
import Topbar from '../../components/Topbar';
import WizardShell from '../components/WizardShell';
import StaleWriteDialog from '../components/StaleWriteDialog';
import { useBrokingContract } from '../hooks/useBrokingContract';
import { useLookups } from '../hooks/useLookups';
import { stepsWithState, isValidStep, firstCaptureStep } from '../steps';

const IdentifyStep = lazy(() => import('./IdentifyStep'));
const PropTreatyDetail = lazy(() => import('./PropTreatyDetail'));
const NpContractDetails = lazy(() => import('./NpContractDetails'));
const NpStructure = lazy(() => import('./NpStructure'));

export default function CaptureScreen() {
  const { contractId, step } = useParams();
  const navigate = useNavigate();
  const contract = useBrokingContract(contractId);
  const lookups = useLookups();
  const { bundle, loading, error, conflict, resolveConflict } = contract;
  const [attempted, setAttempted] = useState(() => new Set());
  const stepRef = useRef(null);          // the active step's { save({draft}) }

  const markAttempted = useCallback((key, missing) => {
    setAttempted((cur) => { const n = new Set(cur); if (missing) n.add(key); else n.delete(key); return n; });
  }, []);

  const steps = useMemo(() => stepsWithState(bundle, attempted), [bundle, attempted]);

  // Ctrl+S saves the active step explicitly (validation on).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') { e.preventDefault(); stepRef.current?.save?.({ draft: false }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = useCallback((target) => { navigate(`/broking/${contractId}/${target.key}`); }, [navigate, contractId]);

  if (error) {
    return (<div className="ab ab-app"><Topbar /><main className="ab-main"><div className="ab-notice danger" role="alert">{error.status === 404 ? 'Contract not found (or it belongs to another organisation).' : `Could not load the contract: ${error.message}`}</div></main></div>);
  }
  if (bundle && !isValidStep(bundle.businessType, step)) return <Navigate to={`/broking/${contractId}/${firstCaptureStep(bundle.businessType)}`} replace />;

  const common = { contract, lookups, stepRef, markAttempted };
  let content = null;
  if (loading && !bundle) content = <p className="ab-help">Loading contract…</p>;
  else if (step === 'identify') content = <IdentifyStep {...common} />;
  else if (step === 'treaty-detail') content = <PropTreatyDetail {...common} />;
  else if (step === 'contract-details') content = <NpContractDetails {...common} />;
  else if (step === 'structure') content = <NpStructure {...common} />;

  return (
    <div className="ab ab-app">
      <Topbar />
      <WizardShell steps={steps} activeStep={step} onNavigate={go}>
        <Suspense fallback={<p className="ab-help">Loading…</p>}>{content}</Suspense>
      </WizardShell>
      <StaleWriteDialog conflict={conflict} onResolve={resolveConflict} />
    </div>
  );
}
