// IdentityField states (design system components/IdentityField/README.md):
// idle → invalid format → checking → taken (owner + Open it) / available → create.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import IdentityField, { umrStatus } from '../components/IdentityField';

class HttpError extends Error { constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; } }
const available = () => Promise.reject(new HttpError(404, { code: 'UMR_AVAILABLE', error: 'available' }));

function setup(over = {}) {
  const props = { lloydsBrokerNo: '0621', onCheck: vi.fn(available), onCreate: vi.fn(async (p) => ({ contractId: 'c-1', umr: p.umr, businessType: p.businessType })), onCreated: vi.fn(), onSearch: vi.fn(async () => []), ...over };
  render(<MemoryRouter><IdentityField {...props} /></MemoryRouter>);
  return props;
}

describe('umrStatus', () => {
  it('idle for the bare prefix, names the format rule, and reports the check result', () => {
    expect(umrStatus('B0621', null).kind).toBe('idle');
    expect(umrStatus('B0621', null).text).toMatch(/B \+ 4-digit broker no\./);
    expect(umrStatus('B0621-X', null)).toMatchObject({ kind: 'bad' });
    expect(umrStatus('X0621ABC', null).text).toBe('A UMR starts with B.');
    expect(umrStatus('B0621ABC', null).text).toBe('Format OK — checking on leave');
    expect(umrStatus('B0621ABC', { umr: 'B0621ABC', state: 'available' })).toMatchObject({ kind: 'ok', text: '✓ B0621ABC is available' });
    expect(umrStatus('B0621ABC', { umr: 'B0621ABC', state: 'taken', owner: { cedant: 'Kenya Re', treatyType: 'CAT XL', uwYear: 2026 } }).text)
      .toBe('UMR B0621ABC is already used by Kenya Re CAT XL 2026 — open it or change the reference.');
    // a stale check for a different value is ignored
    expect(umrStatus('B0621ABCD', { umr: 'B0621ABC', state: 'available' }).kind).toBe('idle');
  });
});

describe('IdentityField', () => {
  it('pre-fills B + broker number, normalises as typed and keeps Create disabled until available', async () => {
    const props = setup();
    const input = screen.getByLabelText(/UMR/);
    expect(input).toHaveValue('B0621');
    expect(screen.getByTestId('create-contract')).toBeDisabled();
    await userEvent.type(input, 'dar 26tr9');
    expect(input).toHaveValue('B0621DAR26TR9');
    expect(screen.getByTestId('umr-status')).toHaveTextContent('Format OK — checking on leave');
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId('umr-status')).toHaveTextContent('✓ B0621DAR26TR9 is available'));
    expect(props.onCheck).toHaveBeenCalledWith('B0621DAR26TR9');
    expect(screen.getByTestId('umr-status')).toHaveClass('is-ok');
    expect(screen.getByTestId('create-contract')).toBeEnabled();
    await userEvent.click(screen.getByTestId('create-contract'));
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith({ contractId: 'c-1', umr: 'B0621DAR26TR9', businessType: 'PROPORTIONAL' }));
    expect(props.onCreate).toHaveBeenCalledWith({ umr: 'B0621DAR26TR9', businessType: 'PROPORTIONAL', parentContractId: null });
  });

  it('names the format rule while typing an invalid reference and never checks it', async () => {
    const props = setup();
    const input = screen.getByLabelText(/UMR/);
    await userEvent.type(input, 'ab-c');
    expect(input).toHaveValue('B0621AB-C');
    expect(screen.getByTestId('umr-status')).toHaveClass('is-bad');
    expect(screen.getByTestId('umr-status')).toHaveTextContent('Format: B + 4 digits + 1–12 letters or digits (max 17).');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.blur(input);
    expect(props.onCheck).not.toHaveBeenCalled();
    expect(screen.getByTestId('create-contract')).toBeDisabled();
  });

  it('shows the owner and an Open it link when the UMR is taken', async () => {
    const props = setup({ onCheck: vi.fn(async () => ({ contractId: 'owner-1', cedant: 'Kenya Re', treatyType: 'Quota Share & Surplus', uwYear: 2026, businessType: 'PROPORTIONAL' })) });
    const input = screen.getByLabelText(/UMR/);
    await userEvent.type(input, 'DAR26TR001');
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId('umr-status')).toHaveTextContent('already used by Kenya Re Quota Share & Surplus 2026'));
    expect(screen.getByTestId('umr-status')).toHaveClass('is-bad');
    expect(screen.getByTestId('umr-open-link')).toHaveAttribute('href', '/broking/owner-1/treaty-detail');
    expect(screen.getByTestId('create-contract')).toBeDisabled();
    expect(props.onCreate).not.toHaveBeenCalled();
  });

  it('turns a 409 on create into the taken state', async () => {
    const props = setup({ onCreate: vi.fn(async () => { throw new HttpError(409, { code: 'UMR_TAKEN', error: 'taken', contractId: 'owner-2', cedant: 'Sanlam Re', treatyType: 'CAT XL', uwYear: 2025 }); }) });
    const input = screen.getByLabelText(/UMR/);
    await userEvent.type(input, 'RACE1');
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId('create-contract')).toBeEnabled());
    await userEvent.click(screen.getByTestId('create-contract'));
    await waitFor(() => expect(screen.getByTestId('umr-status')).toHaveTextContent('already used by Sanlam Re CAT XL 2025'));
    expect(screen.getByTestId('umr-open-link')).toHaveAttribute('href', '/broking/owner-2/treaty-detail');
    expect(props.onCreated).not.toHaveBeenCalled();
  });

  it('a renewal parent locks the business type and is sent as parentContractId', async () => {
    const parent = { contractId: 'p-1', umr: 'B0621DAR25CX002', cedantName: 'Kenya Re', treatyTypeName: 'CAT XL', uwYear: 2025, businessType: 'NON_PROPORTIONAL' };
    const props = setup({ onSearch: vi.fn(async () => [parent]) });
    await userEvent.type(screen.getByLabelText(/Renewal of/), 'kenya');
    const option = await screen.findByRole('option', { name: /B0621DAR25CX002/ });
    fireEvent.mouseDown(option);
    expect(screen.getByTestId('parent-umr')).toHaveTextContent('B0621DAR25CX002');
    expect(screen.getByRole('radio', { name: 'Non-proportional' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Proportional' })).toBeDisabled();
    const input = screen.getByLabelText(/UMR/);
    await userEvent.type(input, 'DAR26CX002');
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByTestId('create-contract')).toBeEnabled());
    await userEvent.click(screen.getByTestId('create-contract'));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith({ umr: 'B0621DAR26CX002', businessType: 'NON_PROPORTIONAL', parentContractId: 'p-1' }));
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith(expect.objectContaining({ businessType: 'NON_PROPORTIONAL' })));
  });
});
