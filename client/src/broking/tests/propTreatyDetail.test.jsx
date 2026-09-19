// Proportional Treaty Detail — per treaty type (QS, QS & Surplus, First Surplus,
// Fac Oblig): field gating with "Not applicable for this treaty type", derived
// amounts, retention ⇄ cession pairing, required-field gating, commission mode
// dimming, LCF, loss participation, EPI split and the PUT payload shape.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import PropTreatyDetail from '../screens/PropTreatyDetail';
import { sliceFromBundle, payloadFromSlice } from '../lib/propSlice';

const CEDANTS = [{ id: 'ced-kre', name: 'Kenya Re', country_id: 'c-ke' }, { id: 'ced-zep', name: 'Zep Re', country_id: 'c-ke' }];
vi.mock('../../api', () => ({
  api: { listCedants: vi.fn(async () => CEDANTS), broking: {} },
  errorBody: (e) => e?.body || null,
}));

const LOOKUPS = {
  ready: true,
  countries: [{ id: 'c-ke', name: 'Kenya', code: 'KE' }, { id: 'c-za', name: 'South Africa', code: 'ZA' }],
  currencies: [{ id: 'cur-usd', code: 'USD', name: 'US Dollar' }, { id: 'cur-kes', code: 'KES', name: 'Kenyan Shilling' }],
  brokers: [{ id: 'b-1', name: 'Afro-Asian Re Brokers' }],
  treatyTypes: [
    { id: 'tt-qs', name: 'Quota Share', category: 'PROPORTIONAL' }, { id: 'tt-qss', name: 'Quota Share & Surplus', category: 'PROPORTIONAL' },
    { id: 'tt-1s', name: 'First Surplus', category: 'PROPORTIONAL' }, { id: 'tt-fo', name: 'Fac Oblig', category: 'PROPORTIONAL' },
    { id: 'tt-cat', name: 'CAT XL', category: 'NON_PROPORTIONAL' },
  ],
  classes: [{ id: 'cl-fire', name: 'Fire' }, { id: 'cl-eng', name: 'Engineering' }, { id: 'cl-mar', name: 'Marine' }],
};
const UUID = '3f2b9c1e-7a44-4c0e-9d1a-5b8e2f6c0a17';

function bundleFor(typeId, extra = {}) {
  const t = LOOKUPS.treatyTypes.find((x) => x.id === typeId);
  return {
    contractId: UUID, umr: 'B0621DAR26TR001', businessType: 'PROPORTIONAL', status: 'DRAFT', rowVersion: 1, parentUmr: null,
    header: { countryId: 'c-ke', countryName: 'Kenya', countryCode: 'KE', cedantId: 'ced-kre', cedantName: 'Kenya Re', brokerId: 'b-1', brokerName: 'Afro-Asian Re Brokers',
      currencyId: 'cur-usd', currencyCode: 'USD', treatyTypeId: typeId, treatyTypeName: t?.name || null, classIds: ['cl-fire', 'cl-eng'], classNames: ['Fire', 'Engineering'],
      inceptionDate: '2026-01-01', renewalDate: '2027-01-01', uwYear: 2026, experienceStartYear: 2016, altContractId: null, ...extra.header },
    propDetail: {
      detail: { triangulationsAvailable: true, qsLimit: 10000000, retentionPct: 30, cessionPct: 70, surplusMaxRetention: 3000000, numLines: 5, eventLimit: null, aal: null, quotaShareEpi: 18000000, surplusEpi: 6500000, brokeragePct: 10, taxesPct: 2, lossCapPct: null, ...extra.detail },
      commissions: { mode: 'FIXED', fixedCommissionQSPct: 32.5, fixedCommissionSurplusPct: 30, provisionalCommissionPct: null, slidingMinLossRatio: null, slidingMaxLossRatio: null, slidingMinCommission: null, slidingMaxCommission: null, mgmtExpensesPct: null, profitCommissionPct: 15, lcfYears: 3, lcfExtinction: false, slidingTable: [], ...extra.commissions },
      lossParticipation: { enabled: false, minLossRatioPct: null, maxLossRatioPct: null, reinsurerSharePct: null, slides: [], ...extra.lossParticipation },
      epiSplit: extra.epiSplit || [],
    },
  };
}
const EMPTY_BUNDLE = { contractId: UUID, umr: 'B0621NEW1', businessType: 'PROPORTIONAL', status: 'DRAFT', rowVersion: 1, header: { classIds: [], classNames: [] }, propDetail: { detail: {}, commissions: {}, lossParticipation: {}, epiSplit: [] } };

function setup(bundle, over = {}) {
  const contract = { bundle, save: vi.fn(async () => ({ ok: true, bundle })), saving: false, savedAt: null, saveError: null, reload: vi.fn(), ...over };
  const stepRef = { current: null };
  const markAttempted = vi.fn();
  const utils = render(<MemoryRouter><PropTreatyDetail contract={contract} lookups={LOOKUPS} stepRef={stepRef} markAttempted={markAttempted} /></MemoryRouter>);
  return { contract, stepRef, markAttempted, ...utils };
}
const field = (re, opts) => screen.getByLabelText(re, opts);
const naTitle = 'Not applicable for this treaty type';

beforeEach(() => { vi.clearAllMocks(); });

describe('sliceFromBundle / payloadFromSlice', () => {
  it('round-trips the seeded QS & Surplus contract', () => {
    const s = sliceFromBundle(bundleFor('tt-qss'));
    expect(s).toMatchObject({ countryId: 'c-ke', qsLimit: '10000000', retentionPct: '30', cessionPct: '70', numLines: '5', commissionMode: 'fixed', fixedCommissionQSPct: '32.5', lcfYears: '3', lossPartEnabled: false, _renewalManual: false });
    expect(s.lpSlides).toHaveLength(5);
    const p = payloadFromSlice(s);
    expect(p.header).toMatchObject({ countryId: 'c-ke', classIds: ['cl-fire', 'cl-eng'], inceptionDate: '2026-01-01', renewalDate: '2027-01-01', experienceStartYear: 2016 });
    expect(p.detail).toMatchObject({ qsLimit: 10000000, retentionPct: 30, cessionPct: 70, surplusMaxRetention: 3000000, numLines: 5, quotaShareEpi: 18000000, surplusEpi: 6500000, brokeragePct: 10, taxesPct: 2, lossCapPct: null });
    expect(p.commissions).toMatchObject({ mode: 'FIXED', fixedCommissionQSPct: 32.5, lcfYears: 3, lcfExtinction: false, slidingTable: [] });
    expect(p.lossParticipation).toEqual({ enabled: false, minLossRatioPct: null, maxLossRatioPct: null, reinsurerSharePct: null, slides: [] });
    // never opened the split → equal split of QS EPI + Surplus EPI across the classes (Universe)
    expect(p.epiSplit).toEqual([{ classId: 'cl-fire', premium: 12250000 }, { classId: 'cl-eng', premium: 12250000 }]);
  });
  it('maps LCF extinction, a manual renewal and the payload lists', () => {
    const s = sliceFromBundle(bundleFor('tt-qs', { header: { renewalDate: '2026-12-31' }, commissions: { lcfYears: null, lcfExtinction: true, mode: 'SLIDING', slidingTable: [{ lossRatioPct: 50, commissionPct: 35 }, { lossRatioPct: 60, commissionPct: 30 }] }, lossParticipation: { enabled: true, slides: [{ minLr: 70, maxLr: 100, share: 50 }] }, epiSplit: [{ classId: 'cl-fire', premium: 10000000 }] }));
    expect(s).toMatchObject({ lcfYears: 'extinction', _renewalManual: true, commissionMode: 'sliding', lossPartEnabled: true });
    expect(s.slidingTable).toEqual([{ lossRatioPct: '50', commissionPct: '35' }, { lossRatioPct: '60', commissionPct: '30' }]);
    expect(s.lpSlides[0]).toEqual({ minLr: '70', maxLr: '100', share: '50' });
    const p = payloadFromSlice(s);
    expect(p.commissions).toMatchObject({ mode: 'SLIDING', lcfYears: null, lcfExtinction: true, slidingTable: [{ lossRatioPct: 50, commissionPct: 35 }, { lossRatioPct: 60, commissionPct: 30 }] });
    expect(p.lossParticipation.slides).toEqual([{ minLr: 70, maxLr: 100, share: 50 }]);
    expect(p.epiSplit).toEqual([{ classId: 'cl-fire', premium: 10000000 }]);   // Engineering has no row: only entered rows are sent
  });
});

describe('PropTreatyDetail — treaty modes', () => {
  it('Quota Share: surplus fields are not applicable; capacity = QS limit; amounts derived', async () => {
    setup(bundleFor('tt-qs'));
    expect(screen.getByTestId('header-pill')).toHaveTextContent('PROPORTIONAL TREATY: TREATY DETAIL');
    expect(field(/^QS 100% Limit/)).toBeEnabled();
    expect(field(/^QS 100% Limit/)).toHaveValue('10,000,000');
    expect(field(/^Surplus Max Retention/)).toBeDisabled();
    expect(field(/^Surplus Max Retention/)).toHaveAttribute('title', naTitle);
    expect(field(/^Number of Lines/)).toBeDisabled();
    expect(field(/^Surplus Commission %/)).toBeDisabled();
    expect(field(/^Surplus EPI/)).toBeDisabled();
    expect(field(/^Retention Amount/)).toHaveValue('3,000,000');
    expect(field(/^Cession Amount/)).toHaveValue('7,000,000');
    expect(field(/^Total Treaty Capacity/)).toHaveValue('10,000,000');
    expect(field(/^Total Treaty Capacity/)).toHaveAttribute('tabindex', '-1');
    expect(field(/^UW Year/)).toHaveValue('2026');
    expect(screen.getByTestId('contract-description')).toHaveValue('2026 Kenya Re Quota Share (Fire, Engineering) KE');
  });

  it('Quota Share & Surplus: everything applies; capacity = QS + MR × N; retention ⇄ cession pair to 100', async () => {
    setup(bundleFor('tt-qss'));
    expect(field(/^Surplus Max Retention/)).toBeEnabled();
    expect(field(/^Number of Lines/)).toBeEnabled();
    expect(field(/^Total Treaty Capacity/)).toHaveValue('25,000,000');
    const ret = field(/^Retention %/);
    await userEvent.clear(ret);
    await userEvent.type(ret, '40');
    expect(field(/^Cession %/)).toHaveValue('60%');      // PctInput idle display
    expect(field(/^Retention Amount/)).toHaveValue('4,000,000');
    expect(field(/^Cession Amount/)).toHaveValue('6,000,000');
    const ces = field(/^Cession %/);
    await userEvent.clear(ces);
    await userEvent.type(ces, '75');
    fireEvent.blur(ces);
    expect(field(/^Retention %/)).toHaveValue('25%');
    const lines = field(/^Number of Lines/);
    await userEvent.clear(lines);
    await userEvent.type(lines, '10');
    expect(field(/^Total Treaty Capacity/)).toHaveValue('40,000,000');
  });

  it('First Surplus: QS fields are not applicable; capacity = MR + MR × N', () => {
    setup(bundleFor('tt-1s'));
    expect(field(/^QS 100% Limit/)).toBeDisabled();
    expect(field(/^QS 100% Limit/)).toHaveAttribute('title', naTitle);
    expect(field(/^Retention %/)).toBeDisabled();
    expect(field(/^Cession %/)).toBeDisabled();
    expect(field(/^QS Commission %/)).toBeDisabled();
    expect(field(/^Quota Share EPI/)).toBeDisabled();
    expect(field(/^Retention Amount/)).toHaveValue('');
    expect(field(/^Total Treaty Capacity/)).toHaveValue('18,000,000');   // 3m + 3m × 5
  });

  it('Fac Oblig behaves as a surplus treaty', () => {
    setup(bundleFor('tt-fo'));
    expect(field(/^QS 100% Limit/)).toBeDisabled();
    expect(field(/^Surplus Max Retention/)).toBeEnabled();
    expect(field(/^Total Treaty Capacity/)).toHaveValue('18,000,000');
    expect(screen.getByTestId('contract-description')).toHaveValue('2026 Kenya Re Fac Oblig (Fire, Engineering) KE');
  });

  it('only proportional treaty types are offered', () => {
    setup(bundleFor('tt-qs'));
    const options = within(field(/^Treaty Type/)).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Select treaty type…', 'Quota Share', 'Quota Share & Surplus', 'First Surplus', 'Fac Oblig']);
  });
});

describe('PropTreatyDetail — required fields, save and modals', () => {
  it('blocks an explicit save on an empty contract and lists "Required: <label>"; a draft save never blocks', async () => {
    const { contract, markAttempted, stepRef } = setup(EMPTY_BUNDLE);
    expect(screen.queryByTestId('error-summary')).toBeNull();
    await userEvent.click(screen.getByTestId('save-treaty-detail'));
    expect(contract.save).not.toHaveBeenCalled();
    const summary = screen.getByTestId('error-summary');
    for (const label of ['Country', 'Cedant Name', 'Treaty Type', 'Line of Business', 'Broker', 'Currency', 'Treaty Inception Date', 'Experience Start Year']) {
      expect(summary).toHaveTextContent(`Required: ${label}`);
    }
    expect(field(/^Country/).closest('.ab-fr')).toHaveClass('is-missing');
    expect(markAttempted).toHaveBeenCalledWith('treaty-detail', true);
    // Ctrl+S is wired through stepRef; a draft save skips the gate
    await stepRef.current.save({ draft: true });
    expect(contract.save).toHaveBeenCalledTimes(1);
    expect(contract.save.mock.calls[0][0]).toBe('prop-detail');
    expect(contract.save.mock.calls[0][2]).toEqual({ draft: true });
  });

  it('fills a QS & Surplus contract and PUTs the Universe payload; the missing list shrinks as fields are filled', async () => {
    const { contract, markAttempted } = setup(EMPTY_BUNDLE);
    await userEvent.click(screen.getByTestId('save-treaty-detail'));
    await userEvent.selectOptions(field(/^Country/), 'c-ke');
    await waitFor(() => expect(within(field(/^Cedant Name/)).getByRole('option', { name: 'Kenya Re' })).toBeInTheDocument());
    await userEvent.selectOptions(field(/^Cedant Name/), 'ced-kre');
    await userEvent.selectOptions(field(/^Treaty Type/), 'tt-qss');
    expect(screen.getByTestId('error-summary')).not.toHaveTextContent('Required: Country');
    expect(screen.getByTestId('error-summary')).toHaveTextContent('Required: QS 100% Limit');
    expect(screen.getByTestId('error-summary')).toHaveTextContent('Required: Surplus EPI');
    // Line of Business through the checkbox modal (first = primary)
    await userEvent.click(screen.getByTestId('cob-button'));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Fire'));
    await userEvent.click(within(dialog).getByLabelText('Engineering'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(screen.getByTestId('cob-button')).toHaveTextContent('Fire, Engineering');
    await userEvent.selectOptions(field(/^Broker\*?$/), 'b-1');
    await userEvent.selectOptions(field(/^Currency/), 'cur-usd');
    fireEvent.change(field(/^Treaty Inception Date/), { target: { value: '2026-04-01' } });
    expect(field(/^Treaty Renewal Date/)).toHaveValue('2027-04-01');    // inception + 12 months
    expect(field(/^UW Year/)).toHaveValue('2026');
    await userEvent.selectOptions(field(/^Experience Start Year/), '2016');
    await userEvent.type(field(/^QS 100% Limit/), '10000000');
    await userEvent.type(field(/^Retention %/), '30');
    await userEvent.type(field(/^Surplus Max Retention/), '3000000');
    await userEvent.type(field(/^Number of Lines/), '5');
    await userEvent.type(field(/^QS Commission %/), '32.5');
    await userEvent.type(field(/^Surplus Commission %/), '30');
    await userEvent.type(field(/^Profit Commission %/), '15');
    await userEvent.selectOptions(field(/^Loss Carry Forward/), 'extinction');
    await userEvent.type(field(/^Quota Share EPI/), '18000000');
    await userEvent.type(field(/^Surplus EPI/), '6500000');
    await userEvent.type(field(/^Brokerage %/), '10');
    expect(screen.queryByTestId('error-summary')).toBeNull();
    expect(screen.getByTestId('contract-description')).toHaveValue('2026 Kenya Re Quota Share & Surplus (Fire, Engineering) KE');
    expect(field(/^Total Treaty Capacity/)).toHaveValue('25,000,000');

    await userEvent.click(screen.getByTestId('save-treaty-detail'));
    await waitFor(() => expect(contract.save).toHaveBeenCalledTimes(1));
    const [kind, payload, opts] = contract.save.mock.calls[0];
    expect(kind).toBe('prop-detail');
    expect(opts).toEqual({ draft: false });
    expect(payload.header).toMatchObject({ countryId: 'c-ke', cedantId: 'ced-kre', treatyTypeId: 'tt-qss', classIds: ['cl-fire', 'cl-eng'], brokerId: 'b-1', currencyId: 'cur-usd', inceptionDate: '2026-04-01', renewalDate: '2027-04-01', experienceStartYear: 2016 });
    expect(payload.detail).toMatchObject({ qsLimit: 10000000, retentionPct: 30, cessionPct: 70, surplusMaxRetention: 3000000, numLines: 5, quotaShareEpi: 18000000, surplusEpi: 6500000, brokeragePct: 10 });
    expect(payload.detail).not.toHaveProperty('retentionAmt');                    // derived values are never sent
    expect(payload.commissions).toMatchObject({ mode: 'FIXED', fixedCommissionQSPct: 32.5, fixedCommissionSurplusPct: 30, profitCommissionPct: 15, lcfYears: null, lcfExtinction: true });
    expect(payload.epiSplit).toEqual([{ classId: 'cl-fire', premium: 12250000 }, { classId: 'cl-eng', premium: 12250000 }]);
    expect(markAttempted).toHaveBeenLastCalledWith('treaty-detail', false);
  });

  it('SLIDING SCALE dims the fixed block and requires the slide table (≥2 rows) via the modal', async () => {
    const { contract } = setup(bundleFor('tt-qs'));
    expect(screen.getByTestId('sliding-block')).toHaveClass('ab-dim');
    await userEvent.click(screen.getByRole('radio', { name: 'SLIDING SCALE' }));
    expect(screen.getByTestId('fixed-block')).toHaveClass('ab-dim');
    expect(field(/^QS Commission %/)).toBeDisabled();
    expect(field(/^Min Loss Ratio %/, { selector: '#pt-slminlr' })).toBeEnabled();
    await userEvent.click(screen.getByTestId('save-treaty-detail'));
    expect(contract.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('error-summary')).toHaveTextContent('Required: Sliding Min Loss Ratio %');
    expect(screen.getByTestId('error-summary')).toHaveTextContent('Required: Sliding Scale table (need ≥2 complete rows)');

    await userEvent.click(screen.getByTestId('sliding-modal-button'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Sliding Scale Commission Table')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/^Provisional Commission %/), '30');
    await userEvent.type(within(dialog).getByLabelText('Row 1 loss ratio'), '50');
    await userEvent.type(within(dialog).getByLabelText('Row 1 commission'), '35');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Save/ }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('at least 2 complete rows');
    await userEvent.type(within(dialog).getByLabelText('Row 2 loss ratio'), '60');
    await userEvent.type(within(dialog).getByLabelText('Row 2 commission'), '30');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Save/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/2 row\(s\) · provisional 30%/)).toBeInTheDocument();
    expect(screen.getByTestId('error-summary')).not.toHaveTextContent('Sliding Scale table');
  });

  it('Loss participation YES requires the corridor scalars; the corridors modal validates max > min', async () => {
    const { contract } = setup(bundleFor('tt-qs'));
    expect(screen.getByTestId('lp-block')).toHaveClass('ab-dim');
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Loss participation enabled' })).getByRole('radio', { name: 'YES' }));
    expect(screen.getByTestId('lp-block')).not.toHaveClass('ab-dim');
    await userEvent.click(screen.getByTestId('save-treaty-detail'));
    expect(contract.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('error-summary')).toHaveTextContent('Required: LP Min Loss Ratio %');
    await userEvent.click(screen.getByTestId('corridors-modal-button'));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Corridor 1 minimum loss ratio'), '100');
    await userEvent.type(within(dialog).getByLabelText('Corridor 1 maximum loss ratio'), '80');
    await userEvent.type(within(dialog).getByLabelText('Corridor 1 reinsurer share'), '50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save corridors' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Max LR % must be greater than Min LR %');
    await userEvent.clear(within(dialog).getByLabelText('Corridor 1 maximum loss ratio'));
    await userEvent.type(within(dialog).getByLabelText('Corridor 1 maximum loss ratio'), '120');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save corridors' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('✓ 1 corridor(s)')).toBeInTheDocument();
  });

  it('EPI split pre-fills an equal split and warns (amber, confirm) when the total is off by more than 1', async () => {
    setup(bundleFor('tt-qss'));
    await userEvent.click(screen.getByTestId('epi-split-button'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Fire premium')).toHaveValue('12,250,000');
    expect(within(dialog).getByTestId('epi-split-total')).toHaveTextContent('24,500,000');
    const eng = within(dialog).getByLabelText('Engineering premium');
    await userEvent.clear(eng);
    await userEvent.type(eng, '12000000');
    expect(within(dialog).getByRole('alert')).toHaveTextContent("Split total (24,250,000) doesn't match EPI total (24,500,000).");
    await userEvent.click(within(dialog).getByTestId('epi-split-save'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();                       // first click only asks
    expect(within(dialog).getByTestId('epi-split-save')).toHaveTextContent('Save anyway');
    await userEvent.click(within(dialog).getByTestId('epi-split-save'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('2 class(es)')).toBeInTheDocument();
  });

  it('a manual renewal date survives inception edits; the Triangulations toggle lives in the summary bar', async () => {
    setup(bundleFor('tt-qs'));
    fireEvent.change(field(/^Treaty Renewal Date/), { target: { value: '2026-12-31' } });
    fireEvent.change(field(/^Treaty Inception Date/), { target: { value: '2026-02-01' } });
    expect(field(/^Treaty Renewal Date/)).toHaveValue('2026-12-31');
    expect(field(/^UW Year/)).toHaveValue('2026');
    const tri = screen.getByRole('radiogroup', { name: 'Triangulations available' });
    expect(within(tri).getByRole('radio', { name: 'YES' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(tri).getByRole('radio', { name: 'NO' }));
    expect(within(tri).getByRole('radio', { name: 'NO' })).toHaveAttribute('aria-checked', 'true');
  });

  it('Enter moves to the next field and from the last field of a pane into the next pane', () => {
    setup(bundleFor('tt-qss'));
    const country = field(/^Country/);
    country.focus();
    fireEvent.keyDown(country, { key: 'Enter' });
    expect(document.activeElement).toBe(field(/^Cedant Name/));
    const desc = field(/^Experience Start Year/);
    desc.focus();
    fireEvent.keyDown(desc, { key: 'Enter' });
    expect(document.activeElement).toBe(field(/^QS 100% Limit/));           // description is derived (tabindex -1) → next pane
  });

  it('shows server validation details after a rejected save', async () => {
    const save = vi.fn(async () => ({ ok: false, message: 'Validation failed', fields: [{ path: 'detail.lossCapPct', message: 'must be ≤ 1000' }] }));
    setup(bundleFor('tt-qs'), { save });
    await userEvent.click(screen.getByTestId('save-treaty-detail'));
    await waitFor(() => expect(screen.getByTestId('error-summary')).toHaveTextContent('Validation failed — detail.lossCapPct: must be ≤ 1000'));
  });
});
