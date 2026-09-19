// Identify step (/broking/new): bad format, duplicate UMR, success, renewal copy.
import { test, expect } from '@playwright/test';
import { login, uniqueUmr, apiGet, SEED } from './helpers.js';

test.describe('Identify step', () => {
  test.beforeEach(async ({ page }) => { await login(page); await page.goto('/broking/new'); });

  test('pre-fills B + the Lloyd\'s broker number and rejects a badly formatted UMR', async ({ page }) => {
    const umr = page.locator('input#umr');
    await expect(umr).toHaveValue('B0621');
    await expect(page.getByTestId('umr-status')).toHaveText(/B \+ 4-digit broker no\. \+ up to 12 characters/);
    await expect(page.getByTestId('create-contract')).toBeDisabled();

    await umr.click();
    await umr.pressSequentially('dar 26-tr1');
    await expect(umr).toHaveValue('B0621DAR26-TR1');            // uppercased, spaces stripped
    const status = page.getByTestId('umr-status');
    await expect(status).toHaveClass(/is-bad/);
    await expect(status).toHaveText('Format: B + 4 digits + 1–12 letters or digits (max 17).');
    await umr.blur();
    await expect(page.getByTestId('create-contract')).toBeDisabled();

    // too long: the input caps at 17 characters
    await umr.fill('B0621ABCDEFGHIJKLMNOP');
    await expect(umr).toHaveValue('B0621ABCDEFGHIJKL');
  });

  test('flags a duplicate UMR with its owner and an Open it link', async ({ page }) => {
    const umr = page.locator('input#umr');
    await umr.fill(SEED.qss.umr);
    await umr.blur();
    const status = page.getByTestId('umr-status');
    await expect(status).toHaveText(/UMR B0621DAR26TR001 is already used by Kenya Re Quota Share & Surplus 2026 — open it or change the reference\./);
    await expect(status).toHaveClass(/is-bad/);
    await expect(page.getByTestId('create-contract')).toBeDisabled();
    const open = page.getByTestId('umr-open-link');
    await expect(open).toHaveAttribute('href', `/broking/${SEED.qss.contractId}/treaty-detail`);
    await open.click();
    await expect(page).toHaveURL(new RegExp(`/broking/${SEED.qss.contractId}/treaty-detail$`));
    await expect(page.getByTestId('umr-chip')).toHaveText(SEED.qss.umr);
  });

  test('creates a proportional contract from an available UMR', async ({ page }) => {
    const value = uniqueUmr('NEW');
    const umr = page.locator('input#umr');
    await umr.fill(value);
    await umr.blur();
    await expect(page.getByTestId('umr-status')).toHaveText(`✓ ${value} is available`);
    await expect(page.getByTestId('umr-status')).toHaveClass(/is-ok/);
    await expect(page.getByTestId('create-contract')).toBeEnabled();
    await page.getByTestId('create-contract').click();

    await expect(page).toHaveURL(/\/broking\/[0-9a-f-]{36}\/treaty-detail$/);
    const contractId = page.url().match(/\/broking\/([0-9a-f-]{36})\//)[1];
    await expect(page.getByTestId('umr-chip')).toHaveText(value);

    const bundle = await apiGet(page, `/api/broking/contracts/${contractId}`);
    expect(bundle).toMatchObject({ contractId, umr: value, businessType: 'PROPORTIONAL', status: 'DRAFT', parentContractId: null });

    // the identity is read-only afterwards; the UUID is shown in uuid style
    await page.goto(`/broking/${contractId}/identify`);
    await expect(page.getByTestId('uuid')).toHaveText(contractId);
    await expect(page.locator('input#umr')).toHaveCount(0);
    // and the list finds it by UMR prefix
    await page.goto('/broking');
    await page.getByLabel('Search contracts').fill(value.slice(0, 10));
    await expect(page.getByTestId('contract-row').filter({ hasText: value })).toHaveCount(1);
  });

  test('a non-proportional contract routes to Contract Details', async ({ page }) => {
    const value = uniqueUmr('NPX');
    await page.getByRole('radio', { name: 'Non-proportional' }).click();
    const umr = page.locator('input#umr');
    await umr.fill(value);
    await umr.blur();
    await expect(page.getByTestId('create-contract')).toBeEnabled();
    await page.getByTestId('create-contract').click();
    await expect(page).toHaveURL(/\/broking\/[0-9a-f-]{36}\/contract-details$/);
  });

  test('renewal copies the prior year header and details and locks the business type', async ({ page }) => {
    const value = uniqueUmr('REN');
    const search = page.getByLabel('Renewal of');
    await search.fill('B0621DAR26TR');
    const option = page.getByRole('option', { name: /B0621DAR26TR001/ });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.getByTestId('parent-umr')).toHaveText(SEED.qss.umr);
    await expect(page.getByRole('radio', { name: 'Proportional', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Non-proportional' })).toBeDisabled();

    const umr = page.locator('input#umr');
    await umr.fill(value);
    await umr.blur();
    await expect(page.getByTestId('create-contract')).toBeEnabled();
    await page.getByTestId('create-contract').click();
    await expect(page).toHaveURL(/\/broking\/[0-9a-f-]{36}\/treaty-detail$/);
    const contractId = page.url().match(/\/broking\/([0-9a-f-]{36})\//)[1];

    const bundle = await apiGet(page, `/api/broking/contracts/${contractId}`);
    expect(bundle.parentContractId).toBe(SEED.qss.contractId);
    expect(bundle.parentUmr).toBe(SEED.qss.umr);
    expect(bundle.header).toMatchObject({ cedantName: 'Kenya Re', treatyTypeName: 'Quota Share & Surplus', uwYear: 2027, inceptionDate: '2027-01-01', renewalDate: '2028-01-01', classNames: ['Fire', 'Engineering'] });
    expect(bundle.header.contractDescription).toBe('2027 Kenya Re Quota Share & Surplus (Fire, Engineering) KE');
    expect(bundle.propDetail.detail).toMatchObject({ qsLimit: 10000000, retentionPct: 30, cessionPct: 70, surplusMaxRetention: 3000000, numLines: 5, totalCapacity: 25000000 });
    expect(bundle.propDetail.commissions).toMatchObject({ mode: 'FIXED', fixedCommissionQSPct: 32.5, fixedCommissionSurplusPct: 30, profitCommissionPct: 15, lcfYears: 3 });

    await page.goto(`/broking/${contractId}/identify`);
    await expect(page.getByTestId('summary-bar')).toContainText('Kenya Re');
    await expect(page.getByTestId('summary-bar')).toContainText('Renewal of B0621DAR26TR001');
    await expect(page.getByTestId('summary-bar')).toContainText('Quota Share & Surplus');
  });
});
