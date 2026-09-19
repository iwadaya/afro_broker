// NP Contract Details (left pane only) and NP Structure screens.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import NpContractDetails from '../screens/NpContractDetails';
import NpStructure from '../screens/NpStructure';

const CEDANTS = [{ id: 'ced-kre', name: 'Kenya Re', country_id: 'c-ke' }];
vi.mock('../../api', () => ({ api: { listCedants: vi.fn(async () => CEDANTS), broking: {} }, errorBody: (e) => e?.body || null }));

const LOOKUPS = {
  ready: true,
  countries: [{ id: 'c-ke', name: 'Kenya', code: 'KE' }], currencies: [{ id: 'cur-usd', code: 'USD', name: 'US Dollar' }], brokers: [{ id: 'b-1', name: 'Afro-Asian Re Brokers' }],
  treatyTypes: [{ id: 'tt-qs', name: 'Quota Share', category: 'PROPORTIONAL' }, { id: 'tt-risk', name: 'Risk XL', category: 'NON_PROPORTIONAL' }, { id: 'tt-cat', name: 'CAT XL', category: 'NON_PROPORTIONAL' }, { id: 'tt-rc', name: 'Risk & CAT XL', category: 'NON_PROPORTIONAL' }, { id: 'tt-sl', name: 'Stop Loss', category: 'NON_PROPORTIONAL' }, { id: 'tt-ax', name: 'Aggregate XL', category: 'NON_PROPORTIONAL' }],
  classes: [{ id: 'cl-fire', name: 'Fire' }, { id: 'cl-eng', name: 'Engineering' }],
};
const UUID = '00000000-0000-0000-0000-00000000c002';
const bundle = (typeName, over = {}) => ({
  contractId: UUID, umr: 'B0621DAR26CX002', businessType: 'NON_PROPORTIONAL', status: 'DRAFT', rowVersion: 1, parentUmr: null, createdAt: '2026-01-01T00:00:00Z',
  header: { countryId: 'c-ke', countryName: 'Kenya', countryCode: 'KE', cedantId: 'ced-kre', cedantName: 'Kenya Re', brokerId: 'b-1', brokerName: 'Afro-Asian Re Brokers', currencyId: 'cur-usd', currencyCode: 'USD',
    treatyTypeId: LOOKUPS.treatyTypes.find((t) => t.name === typeName)?.id || '', treatyTypeName: typeName, classIds: ['cl-fire'], classNames: ['Fire'], inceptionDate: '2026-01-01', renewalDate: '2027-01-01', uwYear: 2026, experienceStartYear: 2016 },
  npStructure: { programme: { deductible: 2500000, estGnpi: 80000000, xlType: 'Gross XL', accountingMethod: 'Losses Occurring', accounts: 'Quarterly', brokeragePct: 10 }, layers: [] },
  ...over,
});
const EMPTY = { contractId: UUID, umr: 'B0621NEW2', businessType: 'NON_PROPORTIONAL', status: 'DRAFT', rowVersion: 1, header: { classIds: [], classNames: [] }, npStructure: { programme: {}, layers: [] } };

function setup(Screen, b, over = {}) {
  const contract = { bundle: b, save: vi.fn(async () => ({ ok: true, bundle: b })), saving: false, savedAt: null, saveError: null, reload: vi.fn(), ...over };
  const stepRef = { current: null }; const markAttempted = vi.fn();
  render(<MemoryRouter initialEntries={[`/broking/${UUID}/x`]}><Routes>
    <Route path="/broking/:id/structure" element={<p>STRUCTURE ROUTE</p>} />
    <Route path="*" element={<Screen contract={contract} lookups={LOOKUPS} stepRef={stepRef} markAttempted={markAttempted} />} />
  </Routes></MemoryRouter>);
  return { contract, stepRef, markAttempted };
}
beforeEach(() => vi.clearAllMocks());

describe('NpContractDetails', () => {
  it('shows the left pane only, NP treaty types, the "Classes of Business" label and the identity pane', () => {
    setup(NpContractDetails, bundle('CAT XL'));
    expect(screen.getByTestId('header-pill')).toHaveTextContent('NON-PROPORTIONAL TREATY: CONTRACT DETAILS');
    const options = within(screen.getByLabelText(/^Treaty Type/)).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Select treaty type…', 'Risk XL', 'CAT XL', 'Risk & CAT XL', 'Stop Loss', 'Aggregate XL']);
    expect(screen.getByText(/^Classes of Business/)).toBeInTheDocument();
    expect(screen.queryByText(/QS 100% Limit/)).toBeNull();
    expect(screen.queryByText(/Alt\. Contract ID/)).toBeNull();
    expect(screen.getByTestId('uuid')).toHaveTextContent(UUID);
    expect(screen.getByTestId('contract-description')).toHaveValue('2026 Kenya Re CAT XL (Fire) KE');
    expect(screen.getByText(/Structure surface: Layer table — CAT XL/)).toBeInTheDocument();
  });

  it('gates the save on the NP required set and PUTs the header; Save & next routes to Structure', async () => {
    const { contract, markAttempted } = setup(NpContractDetails, EMPTY);
    await userEvent.click(screen.getByTestId('save-and-next'));
    expect(contract.save).not.toHaveBeenCalled();
    const summary = screen.getByTestId('error-summary');
    for (const l of ['Country', 'Cedant Name', 'Treaty Type', 'Classes of Business', 'Broker', 'Currency', 'Treaty Inception Date', 'Experience Start Year']) expect(summary).toHaveTextContent(`Required: ${l}`);
    expect(markAttempted).toHaveBeenCalledWith('contract-details', true);
    await userEvent.selectOptions(screen.getByLabelText(/^Country/), 'c-ke');
    await waitFor(() => expect(within(screen.getByLabelText(/^Cedant Name/)).getByRole('option', { name: 'Kenya Re' })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText(/^Cedant Name/), 'ced-kre');
    await userEvent.selectOptions(screen.getByLabelText(/^Treaty Type/), 'tt-sl');
    await userEvent.click(screen.getByTestId('cob-button'));
    await userEvent.click(within(screen.getByRole('dialog')).getByLabelText('Engineering'));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply' }));
    await userEvent.selectOptions(screen.getByLabelText(/^Broker\*?$/), 'b-1');
    await userEvent.selectOptions(screen.getByLabelText(/^Currency/), 'cur-usd');
    fireEvent.change(screen.getByLabelText(/^Treaty Inception Date/), { target: { value: '2026-07-01' } });
    expect(screen.getByLabelText(/^Treaty Renewal Date/)).toHaveValue('2027-07-01');
    expect(screen.getByLabelText(/^UW Year/)).toHaveValue('2026');
    await userEvent.selectOptions(screen.getByLabelText(/^Experience Start Year/), '2018');
    expect(screen.queryByTestId('error-summary')).toBeNull();
    await userEvent.click(screen.getByTestId('save-and-next'));
    await waitFor(() => expect(contract.save).toHaveBeenCalledTimes(1));
    const [kind, payload] = contract.save.mock.calls[0];
    expect(kind).toBe('header');
    expect(payload.header).toEqual({ countryId: 'c-ke', cedantId: 'ced-kre', brokerId: 'b-1', currencyId: 'cur-usd', treatyTypeId: 'tt-sl', classIds: ['cl-eng'], altContractId: null, inceptionDate: '2026-07-01', renewalDate: '2027-07-01', experienceStartYear: 2018 });
    await screen.findByText('STRUCTURE ROUTE');
    expect(markAttempted).toHaveBeenLastCalledWith('contract-details', false);
  });
});

describe('NpStructure', () => {
  it('CAT XL: programme strip, locked covers, cascade and totals; saves programme + layers', async () => {
    const { contract } = setup(NpStructure, bundle('CAT XL'));
    expect(screen.getByTestId('header-pill')).toHaveTextContent('NON-PROPORTIONAL TREATY: STRUCTURE');
    expect(screen.getByTestId('pill-cat')).toHaveAttribute('data-on', 'true');
    expect(screen.getByTestId('pill-risk')).toHaveAttribute('data-on', 'false');
    expect(screen.getByLabelText(/^Deductible/)).toHaveValue('2,500,000');
    expect(screen.getByLabelText(/^Type of XL/)).toHaveValue('Gross XL');
    // one blank layer to start, EGNPI defaulted, covers locked
    expect(screen.getByLabelText('Layer 1 EGNPI')).toHaveValue('80,000,000');
    expect(screen.getByLabelText('Layer 1 cat')).toBeChecked();
    expect(screen.getByLabelText('Layer 1 cat')).toBeDisabled();
    expect(screen.getByLabelText('Layer 1 risk')).not.toBeChecked();
    expect(screen.getByLabelText('Layer 1 deductible')).toHaveValue('2,500,000');
    expect(screen.getByLabelText('Layer 1 deductible')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByLabelText('Layer 1 AAD amount')).toBeDisabled();
    // required: a limit
    await userEvent.click(screen.getByTestId('save-structure'));
    expect(contract.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('error-summary')).toHaveTextContent('Required: Layer 1 Limit');
    await userEvent.type(screen.getByLabelText('Layer 1 limit'), '5000000');
    await userEvent.type(screen.getByLabelText('Layer 1 rate'), '1.8');
    fireEvent.blur(screen.getByLabelText('Layer 1 rate'));
    await userEvent.type(screen.getByLabelText('Layer 1 MDP'), '1200000');
    expect(screen.getByLabelText('Layer 1 earned premium')).toHaveValue('1,440,000');
    expect(screen.getByLabelText('Layer 1 ROL')).toHaveValue('28.8%');
    expect(screen.getByLabelText('Layer 1 MDP%')).toHaveValue('83.33%');
    await userEvent.click(screen.getByTestId('add-layer'));
    expect(screen.getByLabelText('Layer 2 deductible')).toHaveValue('7,500,000');
    expect(screen.getByLabelText('Layer 2 EGNPI')).toHaveValue('80,000,000');
    await userEvent.type(screen.getByLabelText('Layer 2 limit'), '10000000');
    await userEvent.click(screen.getByLabelText('Layer 2 AAD'));
    expect(screen.getByLabelText('Layer 2 AAD amount')).toBeEnabled();
    await userEvent.type(screen.getByLabelText('Layer 2 AAD amount'), '2000000');
    await userEvent.selectOptions(screen.getByLabelText('Layer 2 reinstatements'), 'UNLIMITED');
    const totals = screen.getByTestId('layer-totals');
    expect(within(totals).getByText('15,000,000')).toBeInTheDocument();
    expect(totals.querySelector('[data-col="reinstatements"]')).toHaveTextContent('Unlimited');
    expect(totals.querySelector('[data-col="rol"]')).toHaveTextContent('9.6%');          // 1,440,000 / 15,000,000
    // programme deductible re-cascades
    const ded = screen.getByLabelText(/^Deductible/);
    await userEvent.clear(ded); await userEvent.type(ded, '3000000');
    expect(screen.getByLabelText('Layer 2 deductible')).toHaveValue('8,000,000');
    await userEvent.click(screen.getByTestId('save-structure'));
    await waitFor(() => expect(contract.save).toHaveBeenCalledTimes(1));
    const [kind, payload] = contract.save.mock.calls[0];
    expect(kind).toBe('np-structure');
    expect(payload.programme).toMatchObject({ deductible: 3000000, estGnpi: 80000000, xlType: 'Gross XL' });
    expect(payload.layers).toHaveLength(2);
    expect(payload.layers[0]).toMatchObject({ layerNumber: 1, limit: 5000000, rate: 1.8, mdp: 1200000, riskCover: false, catCover: true, aad: false, aadAmount: null });
    expect(payload.layers[1]).toMatchObject({ layerNumber: 2, limit: 10000000, aad: true, aadAmount: 2000000, numReinstatements: 'UNLIMITED' });
    expect(payload.layers[0]).not.toHaveProperty('earnedPremium');
  });

  it('Risk & CAT XL: covers are editable; Delete Layer never goes below 1', async () => {
    setup(NpStructure, bundle('Risk & CAT XL'));
    expect(screen.getByTestId('pill-risk')).toHaveAttribute('data-on', 'true');
    expect(screen.getByLabelText('Layer 1 cat')).toBeEnabled();
    await userEvent.click(screen.getByLabelText('Layer 1 cat'));
    expect(screen.getByLabelText('Layer 1 cat')).not.toBeChecked();
    expect(screen.getByTestId('delete-layer')).toBeDisabled();
  });

  it('arrow keys move between cells and an Excel paste fills across the row', async () => {
    setup(NpStructure, bundle('Risk XL'));
    await userEvent.click(screen.getByTestId('add-layer'));
    const limit1 = screen.getByLabelText('Layer 1 limit');
    limit1.focus();
    fireEvent.keyDown(limit1, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByLabelText('Layer 2 limit'));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });            // skips the derived deductible cell
    expect(document.activeElement).toBe(screen.getByLabelText('Layer 2 aggregate limit'));
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByLabelText('Layer 1 aggregate limit'));
    const clip = '5,000,000\t10,000,000\t80,000,000\t1.8\t1,200,000\n10,000,000\t20,000,000\t80,000,000\t1.35\t900,000';
    fireEvent.paste(limit1, { clipboardData: { getData: () => clip } });
    expect(screen.getByLabelText('Layer 1 limit')).toHaveValue('5,000,000');
    expect(screen.getByLabelText('Layer 1 rate')).toHaveValue('1.8%');
    expect(screen.getByLabelText('Layer 1 earned premium')).toHaveValue('1,440,000');
    expect(screen.getByLabelText('Layer 2 limit')).toHaveValue('10,000,000');
    expect(screen.getByLabelText('Layer 2 deductible')).toHaveValue('7,500,000');
    expect(screen.getByLabelText('Layer 2 MDP')).toHaveValue('900,000');
  });

  it('Stop Loss and Aggregate XL swap in the Universe variants', async () => {
    const { contract } = setup(NpStructure, bundle('Stop Loss'));
    expect(screen.getByRole('table', { name: 'Stop loss layers' })).toBeInTheDocument();
    expect(screen.getByText('Attach LR %')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Layer 1 EPI'), '50000000');
    await userEvent.type(screen.getByLabelText('Layer 1 attach LR %'), '80');
    await userEvent.type(screen.getByLabelText('Layer 1 limit LR %'), '30');
    expect(screen.getByLabelText('Layer 1 resolved limit')).toHaveValue('15,000,000');
    expect(screen.getByLabelText('Layer 1 resolved attachment')).toHaveValue('40,000,000');
    await userEvent.click(screen.getByTestId('save-structure'));
    await waitFor(() => expect(contract.save).toHaveBeenCalled());
    expect(contract.save.mock.calls[0][1].layers[0]).toMatchObject({ epi: 50000000, attachLrPct: 80, limitLrPct: 30, limit: null });
  });
  it('Aggregate XL columns', () => {
    setup(NpStructure, bundle('Aggregate XL'));
    expect(screen.getByRole('table', { name: 'Aggregate XL layers' })).toBeInTheDocument();
    expect(screen.getByLabelText('Layer 1 aggregate deductible')).toBeInTheDocument();
    expect(screen.getByLabelText('Layer 1 deductible')).toBeEnabled();      // per-layer, editable here
  });
});
