// The header pill + SummaryBar every capture step renders, with the Amend UMR action.
import { useState } from 'react';
import SummaryBar from '../components/SummaryBar';
import AmendUmrDialog from '../components/AmendUmrDialog';
import { headerPill } from '../steps';

export default function ContractHeaderBar({ bundle, step, extra = null, onAmended, facts }) {
  const [amending, setAmending] = useState(false);
  if (!bundle) return null;
  const h = bundle.header || {};
  const defaultFacts = [h.cedantName, h.countryName, h.brokerName, h.currencyCode, h.treatyTypeName, (h.classNames || []).join(', ')];
  return (
    <>
      <span className="ab-pill" data-testid="header-pill">{headerPill(bundle.businessType, step)}</span>
      <SummaryBar facts={facts || defaultFacts} umr={bundle.umr} contractId={bundle.contractId} status={bundle.status} parentUmr={bundle.parentUmr} extra={extra} onAmendUmr={() => setAmending(true)} />
      {amending && (
        <AmendUmrDialog open contractId={bundle.contractId} currentUmr={bundle.umr} onClose={() => setAmending(false)}
          onAmended={(r) => { setAmending(false); onAmended?.(r); }} />
      )}
    </>
  );
}
