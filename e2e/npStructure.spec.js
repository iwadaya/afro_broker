// Non-proportional: Contract Details (left pane) → Structure. CAT XL (covers
// locked, cascade, totals, save/reload), Risk & CAT XL (covers editable), Stop
// Loss (loss-ratio layout), Excel paste.
import { test, expect } from '@playwright/test';
import { login, uniqueUmr, apiGet } from './helpers.js';

async function csrfHeaders(page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'csrf_token')?.value || '';
  return { 'x-csrf-token': csrf, 'content-type': 'application/json' };
}
async function apiSend(page, method, path, data) {
  const res = await page.request.fetch(path, { method, headers: await csrfHeaders(page), data });
  expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}
/** Create an NP contract and fill its header through the API (the UI path is covered by the CAT XL test). */
async function seedNp(page, typeName, umr) {
  const [types, countries, currencies, brokers, classes] = await Promise.all([
    apiGet(page, '/api/treaty-types'), apiGet(page, '/api/ref/lists/country/items'), apiGet(page, '/api/ref/lists/currency/items'), apiGet(page, '/api/brokers'), apiGet(page, '/api/class-of-business'),
  ]);
  const ke = countries.find((c) => c.code === 'KE');
  const cedants = await apiGet(page, `/api/cedants?country_id=${ke.id}`);
  const created = await apiSend(page, 'POST', '/api/broking/contracts', { umr, businessType: 'NON_PROPORTIONAL' });
  await apiSend(page, 'PUT', `/api/broking/contracts/${created.contractId}/header`, { header: {
    countryId: ke.id, cedantId: cedants.find((c) => c.name === 'Kenya Re').id, treatyTypeId: types.find((t) => t.name === typeName).id,
    brokerId: brokers[0].id, currencyId: currencies.find((c) => c.code === 'USD').id, classIds: [classes.find((c) => c.name === 'Fire').id],
    inceptionDate: '2026-01-01', experienceStartYear: 2016,
  } });
  return created.contractId;
}

test.describe('Non-proportional capture', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('CAT XL: contract details (left pane) → structure with locked covers, cascade, totals, save and reload', async ({ page }) => {
    const umr = uniqueUmr('CAT');
    await page.goto('/broking/new');
    await page.getByRole('radio', { name: 'Non-proportional' }).click();
    await page.locator('input#umr').fill(umr);
    await page.locator('input#umr').blur();
    await page.getByTestId('create-contract').click();
    await expect(page).toHaveURL(/\/contract-details$/);
    const contractId = page.url().match(/\/broking\/([0-9a-f-]{36})\//)[1];
    await expect(page.getByTestId('header-pill')).toHaveText('NON-PROPORTIONAL TREATY: CONTRACT DETAILS');
    await expect(page.getByText('Classes of Business')).toBeVisible();
    await expect(page.locator('#pt-qslimit')).toHaveCount(0);                     // left pane only: no limit details here

    await page.locator('#np-country').selectOption({ label: 'Kenya' });
    await page.locator('#np-cedant').selectOption({ label: 'Kenya Re' });
    await page.locator('#np-type').selectOption({ label: 'CAT XL' });
    await page.getByTestId('cob-button').click();
    await page.getByRole('dialog').getByLabel('Fire').check();
    await page.getByRole('dialog').getByLabel('Engineering').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
    await page.locator('#np-broker').selectOption({ index: 1 });
    await page.locator('#np-currency').selectOption({ label: 'USD' });
    await page.locator('#np-inception').fill('2026-01-01');
    await expect(page.locator('#np-renewal')).toHaveValue('2027-01-01');
    await page.locator('#np-expyear').selectOption('2016');
    await expect(page.getByTestId('contract-description')).toHaveValue('2026 Kenya Re CAT XL (Fire, Engineering) KE');
    await page.getByTestId('save-and-next').click();
    await expect(page).toHaveURL(new RegExp(`/broking/${contractId}/structure$`));
    await expect(page.getByTestId('header-pill')).toHaveText('NON-PROPORTIONAL TREATY: STRUCTURE');
    await expect(page.getByTestId('pill-cat')).toHaveAttribute('data-on', 'true');
    await expect(page.getByTestId('pill-risk')).toHaveAttribute('data-on', 'false');

    // programme strip
    await page.locator('#np-deductible').fill('2500000');
    await page.locator('#np-xltype').selectOption('Gross XL');
    await page.locator('#np-accounting').selectOption('Losses Occurring');
    await page.locator('#np-accounts').selectOption('Quarterly');
    await page.locator('#np-estgnpi').fill('80000000');
    await page.locator('#np-brokerage').fill('10');
    await page.locator('#np-brokerage').blur();
    await expect(page.getByLabel('Layer 1 EGNPI')).toHaveValue('80,000,000');
    await expect(page.getByLabel('Layer 1 deductible')).toHaveValue('2,500,000');

    // three layers
    const fill = async (n, { limit, agg, rate, mdp, reinst }) => {
      await page.getByLabel(`Layer ${n} limit`).fill(limit);
      await page.getByLabel(`Layer ${n} aggregate limit`).fill(agg);
      await page.getByLabel(`Layer ${n} rate`).fill(rate);
      await page.getByLabel(`Layer ${n} rate`).blur();
      await page.getByLabel(`Layer ${n} MDP`, { exact: true }).fill(mdp);
      await page.getByLabel(`Layer ${n} reinstatements`).selectOption(reinst);
      await page.getByLabel(`Layer ${n} reinstatement %`).fill('100');
      await page.getByLabel(`Layer ${n} reinstatement %`).blur();
    };
    await fill(1, { limit: '5000000', agg: '10000000', rate: '1.8', mdp: '1200000', reinst: '1' });
    await page.getByTestId('add-layer').click();
    await fill(2, { limit: '10000000', agg: '20000000', rate: '1.35', mdp: '900000', reinst: '1' });
    await page.getByTestId('add-layer').click();
    await fill(3, { limit: '15000000', agg: '30000000', rate: '0.9', mdp: '600000', reinst: '2' });
    await expect(page.getByLabel('Layer 3 AAD amount')).toBeDisabled();
    await page.getByLabel('Layer 3 AAD', { exact: true }).check();
    await page.getByLabel('Layer 3 AAD amount').fill('2000000');

    // derived
    await expect(page.getByLabel('Layer 2 deductible')).toHaveValue('7,500,000');
    await expect(page.getByLabel('Layer 3 deductible')).toHaveValue('17,500,000');
    await expect(page.getByLabel('Layer 1 earned premium')).toHaveValue('1,440,000');
    await expect(page.getByLabel('Layer 2 earned premium')).toHaveValue('1,080,000');
    await expect(page.getByLabel('Layer 3 earned premium')).toHaveValue('720,000');
    await expect(page.getByLabel('Layer 1 ROL')).toHaveValue('28.8%');
    await expect(page.getByLabel('Layer 3 MDP%')).toHaveValue('83.33%');
    const totals = page.getByTestId('layer-totals');
    await expect(totals.locator('[data-col="limit"]')).toHaveText('30,000,000');
    await expect(totals.locator('[data-col="earnedPremium"]')).toHaveText('3,240,000');
    await expect(totals.locator('[data-col="rol"]')).toHaveText('10.8%');
    await expect(totals.locator('[data-col="reinstatements"]')).toHaveText('2');
    // CAT XL: covers locked
    await expect(page.getByLabel('Layer 1 cat')).toBeChecked();
    await expect(page.getByLabel('Layer 1 cat')).toBeDisabled();
    await expect(page.getByLabel('Layer 1 risk')).not.toBeChecked();
    await expect(page.getByLabel('Layer 1 risk')).toBeDisabled();
    // derived cells are not tabbable
    await expect(page.getByLabel('Layer 1 deductible')).toHaveAttribute('tabindex', '-1');

    await page.getByTestId('save-structure').click();
    await expect(page.getByTestId('save-status')).toHaveText(/Draft saved/);
    const bundle = await apiGet(page, `/api/broking/contracts/${contractId}`);
    expect(bundle.npStructure.programme).toMatchObject({ numberOfLayers: 3, deductible: 2500000, xlType: 'Gross XL', accountingMethod: 'Losses Occurring', accounts: 'Quarterly', estGnpi: 80000000, brokeragePct: 10 });
    const L = bundle.npStructure.layers;
    expect(L.map((l) => l.attachment)).toEqual([2500000, 7500000, 17500000]);
    expect(L.map((l) => l.earnedPremium)).toEqual([1440000, 1080000, 720000]);
    expect(L.map((l) => l.perilScope)).toEqual(['CAT', 'CAT', 'CAT']);
    expect(L[2]).toMatchObject({ aad: true, aadAmount: 2000000, numReinstatements: 2, reinstatementPct: 100, mdp: 600000 });
    expect(L[0].rol).toBeCloseTo(0.288, 6);
    expect(L[0].mdpPct).toBeCloseTo(1200000 / 1440000, 6);

    await page.reload();
    await expect(page.getByLabel('Layer 3 limit')).toHaveValue('15,000,000');
    await expect(page.getByLabel('Layer 3 deductible')).toHaveValue('17,500,000');
    await expect(page.getByLabel('Layer 3 AAD amount')).toHaveValue('2,000,000');
    await expect(page.getByLabel('Layer 2 rate')).toHaveValue('1.35%');
    await expect(page.getByLabel('Layer 3 reinstatements')).toHaveValue('2');
    await expect(page.locator('#np-deductible')).toHaveValue('2,500,000');
    await expect(page.getByRole('button', { name: /Layers/ })).toHaveClass(/is-done/);
    // delete down to one layer → the server removes the rows above the new count
    await page.getByTestId('delete-layer').click();
    await page.getByTestId('delete-layer').click();
    await expect(page.getByTestId('delete-layer')).toBeDisabled();
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await apiGet(page, `/api/broking/contracts/${contractId}`)).npStructure.layers.length).toBe(1);
  });

  test('Risk & CAT XL: covers editable per layer; Excel paste fills across the row', async ({ page }) => {
    const contractId = await seedNp(page, 'Risk & CAT XL', uniqueUmr('RCX'));
    await page.goto(`/broking/${contractId}/structure`);
    await expect(page.getByTestId('pill-risk')).toHaveAttribute('data-on', 'true');
    await expect(page.getByTestId('pill-cat')).toHaveAttribute('data-on', 'true');
    await expect(page.getByLabel('Layer 1 cat')).toBeEnabled();
    await page.locator('#np-deductible').fill('1000000');
    await page.getByTestId('add-layer').click();
    // paste a 2×5 block from "Excel" starting in Layer 1 Limit
    await page.getByLabel('Layer 1 limit').focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '4,000,000\t8,000,000\t60,000,000\t2.5\t500,000\n6,000,000\t12,000,000\t60,000,000\t1.5\t300,000');
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.getByLabel('Layer 1 limit')).toHaveValue('4,000,000');
    await expect(page.getByLabel('Layer 1 rate')).toHaveValue('2.5%');
    await expect(page.getByLabel('Layer 1 earned premium')).toHaveValue('1,500,000');
    await expect(page.getByLabel('Layer 2 limit')).toHaveValue('6,000,000');
    await expect(page.getByLabel('Layer 2 deductible')).toHaveValue('5,000,000');
    await expect(page.getByLabel('Layer 2 MDP', { exact: true })).toHaveValue('300,000');
    await page.getByLabel('Layer 1 cat').uncheck();
    await page.getByLabel('Layer 2 risk').uncheck();
    await page.getByTestId('save-structure').click();
    await expect(page.getByTestId('save-status')).toHaveText(/Draft saved/);
    const bundle = await apiGet(page, `/api/broking/contracts/${contractId}`);
    expect(bundle.npStructure.layers.map((l) => l.perilScope)).toEqual(['RISK', 'CAT']);
    expect(bundle.npStructure.layers.map((l) => l.limit)).toEqual([4000000, 6000000]);
    await page.reload();
    await expect(page.getByLabel('Layer 1 cat')).not.toBeChecked();
    await expect(page.getByLabel('Layer 2 risk')).not.toBeChecked();
  });

  test('Stop Loss: loss-ratio layout with resolved limit and attachment', async ({ page }) => {
    const contractId = await seedNp(page, 'Stop Loss', uniqueUmr('SLX'));
    await page.goto(`/broking/${contractId}/structure`);
    const table = page.getByRole('table', { name: 'Stop loss layers' });
    await expect(table).toBeVisible();
    await expect(table).toContainText('Attach LR %');
    await expect(table).toContainText('Limit LR %');
    await expect(table).toContainText('EPI (USD)');
    await expect(table).toContainText('Resolved · limit');
    await expect(page.getByRole('table', { name: 'Layers', exact: true })).toHaveCount(0);
    await page.getByLabel('Layer 1 EPI').fill('50000000');
    await page.getByLabel('Layer 1 attach LR %').fill('80');
    await page.getByLabel('Layer 1 limit LR %').fill('30');
    await page.getByLabel('Layer 1 limit LR %').blur();
    await expect(page.getByLabel('Layer 1 resolved limit')).toHaveValue('15,000,000');
    await expect(page.getByLabel('Layer 1 resolved attachment')).toHaveValue('40,000,000');
    await page.getByTestId('save-structure').click();
    await expect(page.getByTestId('save-status')).toHaveText(/Draft saved/);
    const bundle = await apiGet(page, `/api/broking/contracts/${contractId}`);
    expect(bundle.npStructure.layers[0]).toMatchObject({ epi: 50000000, attachLrPct: 80, limitLrPct: 30, limit: 15000000, attachment: 40000000 });
    await page.reload();
    await expect(page.getByLabel('Layer 1 resolved limit')).toHaveValue('15,000,000');
  });
});
