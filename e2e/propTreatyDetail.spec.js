// Proportional Treaty Detail: new UMR → fill the Universe 2×2 screen → save →
// reload → every field, derived value and the summary bar survive the round trip.
import { test, expect } from '@playwright/test';
import { login, uniqueUmr, apiGet } from './helpers.js';

async function createProportional(page, umr) {
  await page.goto('/broking/new');
  const input = page.locator('input#umr');
  await input.fill(umr);
  await input.blur();
  await expect(page.getByTestId('create-contract')).toBeEnabled();
  await page.getByTestId('create-contract').click();
  await expect(page).toHaveURL(/\/broking\/[0-9a-f-]{36}\/treaty-detail$/);
  return page.url().match(/\/broking\/([0-9a-f-]{36})\//)[1];
}

test.describe('Proportional Treaty Detail', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('gates the save on required fields, then saves and reloads a Quota Share & Surplus treaty', async ({ page }) => {
    const umr = uniqueUmr('PTD');
    const contractId = await createProportional(page, umr);
    await expect(page.getByTestId('header-pill')).toHaveText('PROPORTIONAL TREATY: TREATY DETAIL');
    await expect(page.getByTestId('umr-chip')).toHaveText(umr);

    // 1. explicit save on the empty screen → error summary, sidebar dot, nothing PUT
    await page.getByTestId('save-treaty-detail').click();
    const summary = page.getByTestId('error-summary');
    await expect(summary).toContainText('Required: Country');
    await expect(summary).toContainText('Required: Treaty Inception Date');
    await expect(page.getByRole('button', { name: /Treaty Detail/ })).toHaveClass(/is-missing/);

    // 2. Contract Details
    await page.locator('#pt-country').selectOption({ label: 'Kenya' });
    await page.locator('#pt-cedant').selectOption({ label: 'Kenya Re' });
    await page.locator('#pt-type').selectOption({ label: 'Quota Share & Surplus' });
    await page.getByTestId('cob-button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Fire').check();
    await dialog.getByLabel('Engineering').check();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByTestId('cob-button')).toContainText('Fire, Engineering');
    await page.locator('#pt-broker').selectOption({ label: 'Afro-Asian Re Brokers' });
    await page.locator('#pt-currency').selectOption({ label: 'USD' });
    await page.locator('#pt-inception').fill('2026-04-01');
    await expect(page.locator('#pt-renewal')).toHaveValue('2027-04-01');
    await expect(page.locator('#pt-uwyear')).toHaveValue('2026');
    await page.locator('#pt-expyear').selectOption('2016');
    await expect(page.getByTestId('contract-description')).toHaveValue('2026 Kenya Re Quota Share & Surplus (Fire, Engineering) KE');

    // 3. Limit Details — derived amounts follow live
    await page.locator('#pt-qslimit').fill('10000000');
    await expect(page.locator('#pt-qslimit')).toHaveValue('10,000,000');
    await page.locator('#pt-retpct').fill('30');
    await page.locator('#pt-retpct').blur();
    await expect(page.locator('#pt-cespct')).toHaveValue('70%');
    await expect(page.locator('#pt-retamt')).toHaveValue('3,000,000');
    await expect(page.locator('#pt-cesamt')).toHaveValue('7,000,000');
    await page.locator('#pt-smr').fill('3000000');
    await page.locator('#pt-lines').fill('5');
    await expect(page.locator('#pt-capacity')).toHaveValue('25,000,000');
    await page.locator('#pt-eventlimit').fill('25000000');

    // 4. Commissions + LP/EPI/Brokerage
    await page.locator('#pt-fixqs').fill('32.5');
    await page.locator('#pt-fixsurplus').fill('30');
    await page.locator('#pt-pc').fill('15');
    await page.locator('#pt-lcf').selectOption('3');
    await page.locator('#pt-qsepi').fill('18000000');
    await page.locator('#pt-surplusepi').fill('6500000');
    await page.locator('#pt-brokerage').fill('10');
    await page.locator('#pt-taxes').fill('2');
    await page.locator('#pt-taxes').blur();
    await expect(summary).toHaveCount(0);

    // 5. Ctrl+S saves
    await page.keyboard.press('Control+s');
    await expect(page.getByTestId('save-status')).toHaveText(/Draft saved \d\d:\d\d/);
    await expect(page.getByRole('button', { name: /Treaty Detail/ })).toHaveClass(/is-done/);
    await expect(page.getByTestId('summary-bar')).toContainText('Kenya Re');
    await expect(page.getByTestId('summary-bar')).toContainText('Quota Share & Surplus');
    await expect(page.getByTestId('summary-bar')).toContainText('Fire, Engineering');

    // 6. server-side derived columns match the shared calcs
    const bundle = await apiGet(page, `/api/broking/contracts/${contractId}`);
    expect(bundle.header).toMatchObject({ uwYear: 2026, inceptionDate: '2026-04-01', renewalDate: '2027-04-01', contractDescription: '2026 Kenya Re Quota Share & Surplus (Fire, Engineering) KE', classNames: ['Fire', 'Engineering'] });
    expect(bundle.propDetail.detail).toMatchObject({ qsLimit: 10000000, retentionPct: 30, retentionAmt: 3000000, cessionPct: 70, cessionAmt: 7000000, surplusMaxRetention: 3000000, numLines: 5, totalCapacity: 25000000, eventLimit: 25000000, quotaShareEpi: 18000000, surplusEpi: 6500000, brokeragePct: 10, taxesPct: 2 });
    expect(bundle.propDetail.commissions).toMatchObject({ mode: 'FIXED', fixedCommissionQSPct: 32.5, fixedCommissionSurplusPct: 30, profitCommissionPct: 15, lcfYears: 3, lcfExtinction: false });
    expect(bundle.propDetail.epiSplit.map((r) => r.premium)).toEqual([12250000, 12250000]);

    // 7. reload → everything is back
    await page.reload();
    await expect(page.locator('#pt-qslimit')).toHaveValue('10,000,000');
    await expect(page.locator('#pt-retpct')).toHaveValue('30%');
    await expect(page.locator('#pt-cespct')).toHaveValue('70%');
    await expect(page.locator('#pt-retamt')).toHaveValue('3,000,000');
    await expect(page.locator('#pt-capacity')).toHaveValue('25,000,000');
    await expect(page.locator('#pt-cedant')).toHaveValue(bundle.header.cedantId);
    await expect(page.locator('#pt-type')).toHaveValue(bundle.header.treatyTypeId);
    await expect(page.locator('#pt-inception')).toHaveValue('2026-04-01');
    await expect(page.locator('#pt-expyear')).toHaveValue('2016');
    await expect(page.locator('#pt-fixqs')).toHaveValue('32.5%');
    await expect(page.locator('#pt-lcf')).toHaveValue('3');
    await expect(page.locator('#pt-qsepi')).toHaveValue('18,000,000');
    await expect(page.getByTestId('cob-button')).toContainText('Fire, Engineering');
    await expect(page.getByTestId('contract-description')).toHaveValue('2026 Kenya Re Quota Share & Surplus (Fire, Engineering) KE');
    await expect(page.getByRole('button', { name: /Treaty Detail/ })).toHaveClass(/is-done/);
  });

  test('sliding scale + loss participation corridors + EPI split persist through the modals', async ({ page }) => {
    const umr = uniqueUmr('PTS');
    const contractId = await createProportional(page, umr);
    await page.locator('#pt-country').selectOption({ label: 'Kenya' });
    await page.locator('#pt-cedant').selectOption({ label: 'Kenya Re' });
    await page.locator('#pt-type').selectOption({ label: 'Quota Share' });
    await page.getByTestId('cob-button').click();
    await page.getByRole('dialog').getByLabel('Fire').check();
    await page.getByRole('dialog').getByLabel('Marine').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    await page.locator('#pt-broker').selectOption({ index: 1 });
    await page.locator('#pt-currency').selectOption({ label: 'USD' });
    await page.locator('#pt-inception').fill('2026-07-01');
    await page.locator('#pt-expyear').selectOption('2018');
    await page.locator('#pt-qslimit').fill('5000000');
    await page.locator('#pt-retpct').fill('25');
    await page.locator('#pt-qsepi').fill('4000000');
    // surplus fields are not applicable for a Quota Share
    await expect(page.locator('#pt-smr')).toBeDisabled();
    await expect(page.locator('#pt-smr')).toHaveAttribute('title', 'Not applicable for this treaty type');

    // sliding scale via the modal
    await page.getByRole('radio', { name: 'SLIDING SCALE' }).click();
    await page.locator('#pt-slminlr').fill('40');
    await page.locator('#pt-slmaxlr').fill('80');
    await page.locator('#pt-slmincomm').fill('20');
    await page.locator('#pt-slmaxcomm').fill('35');
    await page.getByTestId('sliding-modal-button').click();
    let dialog = page.getByRole('dialog');
    await dialog.locator('#slide-prov').fill('30');
    await dialog.getByLabel('Row 1 loss ratio').fill('50');
    await dialog.getByLabel('Row 1 commission').fill('35');
    await dialog.getByLabel('Row 2 loss ratio').fill('60');
    await dialog.getByLabel('Row 2 commission').fill('30');
    await dialog.getByLabel('Row 3 loss ratio').fill('70');
    await dialog.getByLabel('Row 3 commission').fill('25');
    await dialog.getByRole('button', { name: /^Save/ }).click();
    await expect(page.getByText(/3 row\(s\) · provisional 30%/)).toBeVisible();

    // loss participation corridors
    await page.getByRole('radiogroup', { name: 'Loss participation enabled' }).getByRole('radio', { name: 'YES' }).click();
    await page.locator('#pt-lpminlr').fill('70');
    await page.locator('#pt-lpmaxlr').fill('100');
    await page.locator('#pt-lpshare').fill('50');
    await page.getByTestId('corridors-modal-button').click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Corridor 1 minimum loss ratio').fill('70');
    await dialog.getByLabel('Corridor 1 maximum loss ratio').fill('90');
    await dialog.getByLabel('Corridor 1 reinsurer share').fill('50');
    await dialog.getByLabel('Corridor 2 minimum loss ratio').fill('90');
    await dialog.getByLabel('Corridor 2 maximum loss ratio').fill('120');
    await dialog.getByLabel('Corridor 2 reinsurer share').fill('75');
    await dialog.getByRole('button', { name: 'Save corridors' }).click();
    await expect(page.getByText('✓ 2 corridor(s)')).toBeVisible();

    // EPI split with a mismatch → amber confirm
    await page.getByTestId('epi-split-button').click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Fire premium')).toHaveValue('2,000,000');
    await dialog.getByLabel('Marine premium').fill('1500000');
    await expect(dialog.getByRole('alert')).toContainText("doesn't match EPI total");
    await dialog.getByTestId('epi-split-save').click();
    await expect(dialog.getByTestId('epi-split-save')).toHaveText('Save anyway');
    await dialog.getByTestId('epi-split-save').click();
    await expect(page.getByText('2 class(es)')).toBeVisible();

    await page.getByTestId('save-treaty-detail').click();
    await expect(page.getByTestId('save-status')).toHaveText(/Draft saved/);
    const bundle = await apiGet(page, `/api/broking/contracts/${contractId}`);
    expect(bundle.propDetail.commissions).toMatchObject({ mode: 'SLIDING', provisionalCommissionPct: 30, slidingMinLossRatio: 40, slidingMaxLossRatio: 80, slidingMinCommission: 20, slidingMaxCommission: 35 });
    expect(bundle.propDetail.commissions.slidingTable).toEqual([{ lossRatioPct: 50, commissionPct: 35 }, { lossRatioPct: 60, commissionPct: 30 }, { lossRatioPct: 70, commissionPct: 25 }]);
    expect(bundle.propDetail.lossParticipation).toMatchObject({ enabled: true, minLossRatioPct: 70, maxLossRatioPct: 100, reinsurerSharePct: 50 });
    expect(bundle.propDetail.lossParticipation.slides).toEqual([{ minLr: 70, maxLr: 90, share: 50 }, { minLr: 90, maxLr: 120, share: 75 }]);
    expect(bundle.propDetail.epiSplit.map((r) => [r.className, r.premium])).toEqual([['Fire', 2000000], ['Marine', 1500000]]);
    expect(bundle.propDetail.detail).toMatchObject({ retentionAmt: 1250000, cessionAmt: 3750000, totalCapacity: 5000000, surplusMaxRetention: null });

    await page.reload();
    await expect(page.getByRole('radio', { name: 'SLIDING SCALE' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(/3 row\(s\) · provisional 30%/)).toBeVisible();
    await expect(page.getByText('✓ 2 corridor(s)')).toBeVisible();
    await expect(page.getByText('2 class(es)')).toBeVisible();
    await expect(page.locator('#pt-fixqs')).toBeDisabled();       // fixed block dimmed in sliding mode
  });

  test('leaving the step autosaves a draft; the draft comes back on return', async ({ page }) => {
    const umr = uniqueUmr('PTA');
    const contractId = await createProportional(page, umr);
    await page.locator('#pt-country').selectOption({ label: 'Kenya' });
    await page.locator('#pt-cedant').selectOption({ label: 'Kenya Re' });
    await page.locator('#pt-qslimit').fill('7500000');
    // sidebar navigation to Identify triggers the unmount autosave (draft, no gate)
    await page.getByRole('button', { name: /Identify/ }).click();
    await expect(page).toHaveURL(new RegExp(`/broking/${contractId}/identify$`));
    await expect.poll(async () => (await apiGet(page, `/api/broking/contracts/${contractId}`)).propDetail.detail.qsLimit).toBe(7500000);
    await page.getByRole('button', { name: /Treaty Detail/ }).click();
    await expect(page.locator('#pt-qslimit')).toHaveValue('7,500,000');
    await expect(page.locator('#pt-cedant')).toHaveValue(/.+/);
  });
});
