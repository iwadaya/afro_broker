// The Identify step AFTER creation: the identity is read-only (UMR only changes
// through the audited Amend UMR action); shows the renewal link and UMR history.
import Pane from '../components/Pane';
import FormRow from '../components/FormRow';
import ContractHeaderBar from './ContractHeaderBar';
import { formatDateTime } from '../lib/format';
import { firstCaptureStep } from '../steps';
import Button from '../components/Button';

export default function IdentifyStep({ contract }) {
  const { bundle, reload } = contract;
  if (!bundle) return null;
  return (
    <>
      <ContractHeaderBar bundle={bundle} step="identify" onAmended={() => reload()} />
      <div className="ab-grid-2">
        <Pane title="Identify contract" tag="Step 1">
          <FormRow label="UMR"><span className="ab-id"><span className="ab-id-k">UMR</span><span className="ab-id-v">{bundle.umr}</span></span></FormRow>
          <FormRow label="Business type"><span className="ab-toggle"><button type="button" className="is-on" disabled>{bundle.businessType === 'NON_PROPORTIONAL' ? 'Non-proportional' : 'Proportional'}</button></span></FormRow>
          <FormRow label="Renewal of">{bundle.parentUmr ? <span className="ab-id"><span className="ab-id-k">UMR</span><span className="ab-id-v">{bundle.parentUmr}</span></span> : <span className="ab-help">— (new business)</span>}</FormRow>
          <FormRow label="Contract ID"><span className="ab-uuid" data-testid="uuid">{bundle.contractId}</span></FormRow>
          <FormRow label="Created"><span className="ab-help">{formatDateTime(bundle.createdAt)}{bundle.createdBy ? ` by ${bundle.createdBy}` : ''}</span></FormRow>
          <div className="ab-actions"><Button variant="primary" to={`/broking/${bundle.contractId}/${firstCaptureStep(bundle.businessType)}`}>Continue capture</Button></div>
        </Pane>
        <Pane title="UMR history" tag={`${bundle.umrHistory?.length || 0} change(s)`}>
          {bundle.umrHistory?.length ? bundle.umrHistory.map((h, i) => (
            <div key={i} className="ab-notice"><b>{h.oldUmr}</b> → <b>{h.newUmr}</b><br /><span className="ab-help">{formatDateTime(h.changedAt)}{h.changedBy ? ` · ${h.changedBy}` : ''} · {h.reason}</span></div>
          )) : <p className="ab-help">The UMR has not been amended.</p>}
        </Pane>
      </div>
    </>
  );
}
