// /broking/gallery — every shell component in the states its design-system
// preview.html shows, so the screenshot harness (e2e/previews.shots.js) can put
// the app's rendering next to the preview in both themes.
import { useState } from 'react';
import Topbar from '../../components/Topbar';
import Pane from '../components/Pane';
import FormRow, { NA_TYPE } from '../components/FormRow';
import NumericInput from '../components/NumericInput';
import TogglePill from '../components/TogglePill';
import Button from '../components/Button';
import Badge from '../components/Badge';
import SlideTable from '../components/SlideTable';
import SummaryBar from '../components/SummaryBar';
import WizardShell from '../components/WizardShell';
import IdentityField from '../components/IdentityField';

function Section({ name, subtitle, children, width }) {
  return (
    <section data-gallery={name} style={{ padding: 18, background: 'var(--bg0)', maxWidth: width || 'none' }}>
      <div className="ab-help" style={{ marginBottom: 8 }}><b>{name}</b>{subtitle ? ` — ${subtitle}` : ''}</div>
      {children}
    </section>
  );
}

const STATUSES = ['DRAFT', 'SUBMITTED', 'QUOTED', 'FIRM_ORDER', 'BOUND', 'SIGNED', 'NTU', 'CANCELLED'];
const TAKEN = { B0621DAR26TR001: { contractId: '00000000-0000-0000-0000-00000000c001', cedant: 'Kenya Re', treatyType: 'QS', uwYear: 2026, businessType: 'PROPORTIONAL' } };
class NotFound extends Error { constructor() { super('available'); this.status = 404; this.body = { code: 'UMR_AVAILABLE' }; } }

export default function GalleryScreen() {
  const [comm, setComm] = useState('FIXED');
  const [lp, setLp] = useState('NO');
  const [bt, setBt] = useState('PROPORTIONAL');
  const [tri, setTri] = useState('YES');
  const [limit, setLimit] = useState('10000000');
  const [ret, setRet] = useState('30');
  const retentionAmt = Math.round(Number(limit || 0) * Math.min(100, Math.max(0, Number(ret || 0))) / 100);
  const wizardSteps = [
    { key: 'identify', label: 'Identify', group: 'Setup', state: 'done' },
    { key: 'contract-details', label: 'Contract Details', group: 'Setup', state: 'done' },
    { key: 'structure', label: 'Layers', group: 'Structure', state: 'missing' },
    { key: 'placement', label: 'Documents', group: 'Placement' },
  ];
  return (
    <div className="ab ab-app">
      <Topbar />
      <main className="ab-main">
        <span className="ab-pill">Component gallery</span>
        <p className="ab-help" style={{ margin: '10px 0 0' }}>Design-system states rendered by the app's components (Daylight/Midnight via the theme switcher).</p>

        <Section name="Badge" subtitle="Status">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{STATUSES.map((s) => <Badge key={s} status={s} />)}</div>
        </Section>

        <Section name="Button">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button variant="primary">Save &amp; next</Button><Button>Back</Button>
            <Button size="sm">+ Add Layer</Button><Button size="sm" disabled>Delete Layer</Button>
            <Button variant="warn">Enter slide manually</Button>
          </div>
        </Section>

        <Section name="FormRow" width={556}>
          <Pane title="" className="ab-gallery-pane">
            <FormRow label="Country" htmlFor="g-country" required><select id="g-country" className="ab-sel" defaultValue="KE"><option value="KE">Kenya</option></select></FormRow>
            <FormRow label="Cedant Name" htmlFor="g-cedant" required missing><select id="g-cedant" className="ab-sel" defaultValue=""><option value="">Select cedant…</option></select></FormRow>
            <FormRow label="Surplus Max Retention" htmlFor="g-smr" disabledReason={NA_TYPE}><NumericInput id="g-smr" kind="money" value="" disabled placeholder="Not applicable" title={NA_TYPE} /></FormRow>
            <FormRow label="UW Year" htmlFor="g-uwy"><input id="g-uwy" className="ab-in is-derived" readOnly tabIndex={-1} value="2026" /></FormRow>
            <FormRow label="Alt. Contract ID" htmlFor="g-alt"><input id="g-alt" className="ab-in" placeholder="External system reference…" /></FormRow>
          </Pane>
        </Section>

        <Section name="NumericInput" width={556}>
          <Pane title="" className="ab-gallery-pane">
            <FormRow label="QS 100% Limit" htmlFor="g-lim"><NumericInput id="g-lim" kind="money" value={limit} onChange={setLimit} currency="USD" /></FormRow>
            <FormRow label="Retention %" htmlFor="g-ret"><NumericInput id="g-ret" kind="pct" value={ret} onChange={setRet} /></FormRow>
            <FormRow label="Retention Amount" htmlFor="g-ramt"><NumericInput id="g-ramt" kind="derived" value={retentionAmt} currency="USD" /></FormRow>
          </Pane>
        </Section>

        <Section name="Pane" width={596}>
          <Pane title="Limit details" tag="Capacity">
            <FormRow label="Event Limit" htmlFor="g-ev"><NumericInput id="g-ev" kind="money" value="25000000" currency="USD" /></FormRow>
            <div className="ab-mini">Brokerage &amp; taxes</div>
            <FormRow label="Brokerage %" htmlFor="g-brk"><NumericInput id="g-brk" kind="pct" value="10" /></FormRow>
          </Pane>
        </Section>

        <Section name="SlideTable" width={496}>
          <Pane title="Sliding scale" tag="Manual">
            <SlideTable kind="sliding" provisional="30" rows={[[50, 35], [55, 33], [60, 31], [65, 29], [70, 27]].map(([l, c]) => ({ lossRatioPct: String(l), commissionPct: String(c) }))} onSave={() => {}} />
          </Pane>
        </Section>

        <Section name="SummaryBar">
          <span className="ab-pill">Proportional treaty: treaty detail</span>
          <SummaryBar facts={['Kenya Re', 'Kenya', 'Afro-Asian Re Brokers', 'USD', 'Quota Share & Surplus', 'Fire, Engineering']} parentUmr="B0621DAR25TR004"
            umr="B0621DAR26TR001" contractId="3f2b9c1e-7a44-4c0e-9d1a-5b8e2f6c0a17" status="DRAFT" onAmendUmr={() => {}} />
          <div className="ab-summary" style={{ justifyContent: 'space-between' }}><span>Triangulations available</span>
            <TogglePill options={[{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }]} value={tri} onChange={setTri} ariaLabel="Triangulations available" /></div>
        </Section>

        <Section name="TogglePill">
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
            <TogglePill options={[{ value: 'FIXED', label: 'Fixed commission' }, { value: 'SLIDING', label: 'Sliding scale' }]} value={comm} onChange={setComm} ariaLabel="Commission mode" />
            <TogglePill options={[{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }]} value={lp} onChange={setLp} ariaLabel="Loss participation" />
            <TogglePill options={[{ value: 'PROPORTIONAL', label: 'Proportional' }, { value: 'NON_PROPORTIONAL', label: 'Non-proportional' }]} value={bt} onChange={setBt} ariaLabel="Business type" />
          </div>
        </Section>

        <Section name="WizardShell">
          <div style={{ height: 320, overflow: 'hidden', border: '1px solid var(--hairline)' }}>
            <WizardShell steps={wizardSteps} activeStep="structure" onNavigate={() => {}}>
              <span className="ab-pill">Non-proportional treaty: structure</span>
              <SummaryBar facts={['Sanlam Re', 'South Africa', 'CAT XL']} umr="B0621DAR26CX002" />
              <p className="ab-help">The screen renders here.</p>
            </WizardShell>
          </div>
        </Section>

        <Section name="IdentityField" width={596}>
          <IdentityField lloydsBrokerNo="0621" onCheck={async (u) => { if (TAKEN[u]) return TAKEN[u]; throw new NotFound(); }} onCreate={async (p) => ({ contractId: '3f2b9c1e-7a44-4c0e-9d1a-5b8e2f6c0a17', ...p })} onSearch={async () => []} />
        </Section>
      </main>
    </div>
  );
}
