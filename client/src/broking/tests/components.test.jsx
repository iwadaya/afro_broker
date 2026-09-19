// Component tests for the broking shell (design system components README states).
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import FormRow, { NA_TYPE } from '../components/FormRow';
import TogglePill from '../components/TogglePill';
import NumericInput from '../components/NumericInput';
import Badge, { STATUS_LABEL } from '../components/Badge';
import Button from '../components/Button';
import SlideTable, { corridorErrors, completeSlideRows } from '../components/SlideTable';
import SummaryBar from '../components/SummaryBar';
import WizardShell from '../components/WizardShell';
import Pane from '../components/Pane';
import ErrorSummary from '../components/ErrorSummary';

const inRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('FormRow', () => {
  it('shows the required asterisk and the missing state', () => {
    const { container } = render(<FormRow label="Retention %" htmlFor="ret" required missing><input id="ret" /></FormRow>);
    expect(container.querySelector('.ab-fr')).toHaveClass('is-missing');
    expect(container.querySelector('.ab-req')).toHaveTextContent('*');
    expect(screen.getByLabelText(/Retention %/)).toBeInTheDocument();
  });
  it('wraps a not-applicable control with the tooltip', () => {
    const { container } = render(<FormRow label="Number of Lines" disabledReason={NA_TYPE}><input disabled /></FormRow>);
    expect(container.querySelector('span[title]')).toHaveAttribute('title', 'Not applicable for this treaty type');
  });
});

describe('TogglePill', () => {
  const opts = [{ value: 'FIXED', label: 'FIXED COMMISSION' }, { value: 'SLIDING', label: 'SLIDING SCALE' }];
  it('renders a radiogroup with roving tabindex and reacts to arrow keys', async () => {
    const onChange = vi.fn();
    render(<TogglePill options={opts} value="FIXED" onChange={onChange} ariaLabel="Commission mode" />);
    const group = screen.getByRole('radiogroup', { name: 'Commission mode' });
    const [fixed, sliding] = within(group).getAllByRole('radio');
    expect(fixed).toHaveAttribute('aria-checked', 'true');
    expect(fixed).toHaveAttribute('tabindex', '0');
    expect(sliding).toHaveAttribute('tabindex', '-1');
    fixed.focus();
    fireEvent.keyDown(fixed, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('SLIDING');
    fireEvent.keyDown(fixed, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('SLIDING');
    fireEvent.keyDown(fixed, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('FIXED');
    await userEvent.click(sliding);
    expect(onChange).toHaveBeenLastCalledWith('SLIDING');
  });
  it('ignores keys when disabled', () => {
    const onChange = vi.fn();
    render(<TogglePill options={opts} value="FIXED" onChange={onChange} ariaLabel="x" disabled />);
    fireEvent.keyDown(screen.getAllByRole('radio')[0], { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('NumericInput', () => {
  it('money: groups thousands while typing and reports the raw digits', async () => {
    const onChange = vi.fn();
    render(<NumericInput kind="money" value="" onChange={onChange} currency="USD" aria-label="QS Limit" />);
    const input = screen.getByLabelText('QS Limit');
    await userEvent.type(input, '1234567');
    expect(input).toHaveValue('1,234,567');
    expect(onChange).toHaveBeenLastCalledWith('1234567');
    expect(screen.getByText('USD')).toBeInTheDocument();
  });
  it('derived: read-only, not tabbable, formatted', () => {
    render(<NumericInput kind="derived" value={3000000} currency="USD" aria-label="Retention Amount" />);
    const input = screen.getByLabelText('Retention Amount');
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveValue('3,000,000');
    expect(input).toHaveClass('is-derived');
  });
  it('derived pct: formats a 0–1 fraction with % suffix (Universe fmtPctMaybe)', () => {
    render(<NumericInput kind="derived" format="pct" value={0.125} aria-label="MDP %" />);
    expect(screen.getByLabelText('MDP %')).toHaveValue('12.5%');
  });
  it('pct: clamps to max on blur (Universe PctInput)', async () => {
    const seen = [];
    function Host() { const [v, setV] = useState(''); return <NumericInput kind="pct" value={v} onChange={(x) => { seen.push(x); setV(x); }} max={100} aria-label="Retention %" />; }
    render(<Host />);
    const input = screen.getByLabelText('Retention %');
    await userEvent.type(input, '150');
    fireEvent.blur(input);
    expect(seen.at(-1)).toBe('100');
    expect(input).toHaveValue('100%');
  });
});

describe('Badge / Button / Pane / ErrorSummary', () => {
  it('maps statuses to words and variants', () => {
    render(<><Badge status="FIRM_ORDER" /><Badge status="NTU" /><Badge status="DRAFT" /></>);
    expect(screen.getByText(STATUS_LABEL.FIRM_ORDER)).toHaveClass('warn');
    expect(screen.getByText('NTU')).toHaveClass('danger');
    expect(screen.getByText('Draft').className.trim()).toBe('ab-badge');
  });
  it('renders a link button when given `to`', () => {
    inRouter(<Button variant="primary" to="/broking/new">New contract</Button>);
    expect(screen.getByRole('link', { name: 'New contract' })).toHaveAttribute('href', '/broking/new');
    expect(screen.getByRole('link')).toHaveClass('ab-btn', 'primary');
  });
  it('Pane shows an uppercase title and tag; ErrorSummary lists "Required: <label>"', () => {
    render(<Pane title="Contract Details" tag="Step 2"><ErrorSummary missing={['Cedant', 'Treaty Type']} /></Pane>);
    expect(screen.getByText('Contract Details')).toHaveClass('ab-pane-title');
    expect(screen.getByText('Step 2')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Required: Cedant');
    expect(screen.getByRole('alert')).toHaveTextContent('Required: Treaty Type');
  });
});

describe('SlideTable', () => {
  it('sliding: needs at least two complete rows before saving', async () => {
    const onSave = vi.fn();
    render(<SlideTable kind="sliding" rows={[{ lossRatioPct: '40', commissionPct: '35' }]} provisional="30" onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('at least 2 complete rows');
    expect(completeSlideRows([{ lossRatioPct: '40', commissionPct: '35' }, { lossRatioPct: '', commissionPct: '20' }])).toHaveLength(1);
  });
  it('corridors: max must exceed min', () => {
    expect(corridorErrors([{ minLr: '70', maxLr: '60', share: '50' }])).toEqual(['Corridor 1: Max LR % must be greater than Min LR %']);
    expect(corridorErrors([{ minLr: '70', maxLr: '', share: '50' }])[0]).toMatch(/enter Min LR %/);
    expect(corridorErrors([{ minLr: '70', maxLr: '100', share: '50' }, { minLr: '', maxLr: '', share: '' }])).toEqual([]);
  });
});

describe('SummaryBar', () => {
  it('copies the UMR on click and shows the short UUID and status', async () => {
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<SummaryBar facts={['Kenya Re', 'Quota Share & Surplus', '2026']} umr="B0621DAR26TR001" contractId="3f2b9c1e-7a44-4c0e-9d1a-5b8e2f6c0a17" status="DRAFT" parentUmr="B0621DAR25TR001" onAmendUmr={() => {}} />);
    expect(screen.getByText('Kenya Re')).toBeInTheDocument();
    expect(screen.getByText(/Renewal of B0621DAR25TR001/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /UMR B0621DAR26TR001/ }));
    expect(write).toHaveBeenCalledWith('B0621DAR26TR001');
    expect(screen.getByTestId('umr-chip')).toHaveTextContent('Copied');
    expect(screen.getByText('3f2b9c1e…0a17')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Contract actions' }));
    expect(screen.getByText('Amend UMR…')).toBeInTheDocument();
    write.mockRestore();
  });
});

describe('WizardShell', () => {
  it('renders grouped steps with state dots and navigates on click', async () => {
    const onNavigate = vi.fn();
    const steps = [
      { key: 'identify', label: 'Identify', group: 'Capture', state: 'done' },
      { key: 'treaty-detail', label: 'Treaty Detail', group: 'Capture', state: 'missing' },
      { key: 'placement', label: 'Placement', group: 'Placement', disabled: true },
    ];
    render(<WizardShell steps={steps} activeStep="identify" onNavigate={onNavigate}><p>content</p></WizardShell>);
    expect(screen.getByRole('button', { name: /Identify/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: /Treaty Detail/ })).toHaveClass('is-missing');
    expect(screen.getByRole('button', { name: /Placement/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /Treaty Detail/ }));
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ key: 'treaty-detail' }));
    expect(screen.getByText('content')).toBeInTheDocument();
  });
});
