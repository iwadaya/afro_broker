// Browser walkthroughs (prompt 09) at 1440 and 1280 wide in Daylight and Midnight:
//   A. new UMR → Quota Share & Surplus → save → reload
//   B. new UMR → CAT XL → 3 layers → save → reload
// Screenshots land in docs/broking/screenshots/walkthrough next to the matching
// design-system previews (PropTreatyCapture, NpContractDetails, NpStructure).
//
//   npm run screenshots
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { login, uniqueUmr, setTheme } from './helpers.js';
import { buildPreviewTokensCss } from './lib/previewTokens.js';

const ROOT = process.cwd();
const DS = path.join(ROOT, 'docs/broking/design-system');
const OUT = path.join(ROOT, 'docs/broking/screenshots/walkthrough');
mkdirSync(OUT, { recursive: true });
const tokensCss = buildPreviewTokensCss(path.join(DS, 'tokens.json'));
const bundleCss = readFileSync(path.join(DS, 'components/bundle.css'), 'utf8');
const WIDTHS = [1440, 1280];
const THEMES = [['daylight', 'light'], ['midnight', 'dark']];

async function shoot(page, name) {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const [theme] of THEMES) {
      await setTheme(page, theme);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `${name}.${w}.${theme}.png`), fullPage: true });
    }
  }
  await setTheme(page, 'daylight');
  await page.setViewportSize({ width: 1440, height: 900 });
}

test('design-system screen previews for comparison', async ({ page }) => {
  for (const name of ['PropTreatyCapture', 'NpContractDetails', 'NpStructure']) {
    const raw = readFileSync(path.join(DS, `components/${name}/preview.html`), 'utf8');
    for (const [theme, id] of THEMES) {
      const html = raw.replace(/<link rel="stylesheet" href="https:\/\/fonts[^>]*>/, '').replace('</head>', `<style>${tokensCss}\n${bundleCss}</style></head>`).replace('<html lang="en">', `<html lang="en" data-theme="${id}">`);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.setContent(html, { waitUntil: 'load' });
      await page.screenshot({ path: path.join(OUT, `preview-${name}.1440.${theme}.png`), fullPage: true });
    }
  }
});

test('A. new UMR → Quota Share & Surplus → save → reload', async ({ page }) => {
  await login(page);
  await page.goto('/broking/new');
  await shoot(page, 'A1-identify');
  const umr = uniqueUmr('WKA');
  await page.locator('input#umr').fill(umr); await page.locator('input#umr').blur();
  await expect(page.getByTestId('umr-status')).toHaveClass(/is-ok/);
  await shoot(page, 'A2-identify-available');
  await page.getByTestId('create-contract').click();
  await expect(page).toHaveURL(/treaty-detail$/);
  await page.locator('#pt-country').selectOption({ label: 'Kenya' });
  await page.locator('#pt-cedant').selectOption({ label: 'Kenya Re' });
  await page.locator('#pt-type').selectOption({ label: 'Quota Share & Surplus' });
  await page.getByTestId('cob-button').click();
  await page.getByRole('dialog').getByLabel('Fire').check(); await page.getByRole('dialog').getByLabel('Engineering').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
  await page.locator('#pt-broker').selectOption({ label: 'Afro-Asian Re Brokers' });
  await page.locator('#pt-currency').selectOption({ label: 'USD' });
  await page.locator('#pt-inception').fill('2026-01-01');
  await page.locator('#pt-expyear').selectOption('2016');
  await page.locator('#pt-qslimit').fill('10000000'); await page.locator('#pt-retpct').fill('30'); await page.locator('#pt-retpct').blur();
  await page.locator('#pt-smr').fill('3000000'); await page.locator('#pt-lines').fill('5'); await page.locator('#pt-eventlimit').fill('25000000');
  await page.locator('#pt-fixqs').fill('32.5'); await page.locator('#pt-fixsurplus').fill('30'); await page.locator('#pt-pc').fill('15'); await page.locator('#pt-lcf').selectOption('3');
  await page.locator('#pt-qsepi').fill('18000000'); await page.locator('#pt-surplusepi').fill('6500000'); await page.locator('#pt-brokerage').fill('10'); await page.locator('#pt-taxes').fill('2'); await page.locator('#pt-taxes').blur();
  await shoot(page, 'A3-treaty-detail-filled');
  await page.getByTestId('save-treaty-detail').click();
  await expect(page.getByTestId('save-status')).toHaveText(/Draft saved/);
  await page.reload();
  await expect(page.locator('#pt-capacity')).toHaveValue('25,000,000');
  await shoot(page, 'A4-treaty-detail-reloaded');
});

test('B. new UMR → CAT XL → 3 layers → save → reload', async ({ page }) => {
  await login(page);
  await page.goto('/broking/new');
  await page.getByRole('radio', { name: 'Non-proportional' }).click();
  const umr = uniqueUmr('WKB');
  await page.locator('input#umr').fill(umr); await page.locator('input#umr').blur();
  await expect(page.getByTestId('umr-status')).toHaveClass(/is-ok/);
  await page.getByTestId('create-contract').click();
  await expect(page).toHaveURL(/contract-details$/);
  await page.locator('#np-country').selectOption({ label: 'Kenya' });
  await page.locator('#np-cedant').selectOption({ label: 'Kenya Re' });
  await page.locator('#np-type').selectOption({ label: 'CAT XL' });
  await page.getByTestId('cob-button').click();
  await page.getByRole('dialog').getByLabel('Fire').check(); await page.getByRole('dialog').getByLabel('Engineering').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Apply' }).click();
  await page.locator('#np-broker').selectOption({ label: 'Afro-Asian Re Brokers' });
  await page.locator('#np-currency').selectOption({ label: 'USD' });
  await page.locator('#np-inception').fill('2026-01-01');
  await page.locator('#np-expyear').selectOption('2016');
  await shoot(page, 'B1-contract-details');
  await page.getByTestId('save-and-next').click();
  await expect(page).toHaveURL(/structure$/);
  await page.locator('#np-deductible').fill('2500000'); await page.locator('#np-xltype').selectOption('Gross XL'); await page.locator('#np-accounting').selectOption('Losses Occurring');
  await page.locator('#np-accounts').selectOption('Quarterly'); await page.locator('#np-estgnpi').fill('80000000'); await page.locator('#np-brokerage').fill('10'); await page.locator('#np-brokerage').blur();
  const fill = async (n, limit, agg, rate, mdp, reinst) => {
    await page.getByLabel(`Layer ${n} limit`).fill(limit); await page.getByLabel(`Layer ${n} aggregate limit`).fill(agg);
    await page.getByLabel(`Layer ${n} rate`).fill(rate); await page.getByLabel(`Layer ${n} rate`).blur();
    await page.getByLabel(`Layer ${n} MDP`, { exact: true }).fill(mdp); await page.getByLabel(`Layer ${n} reinstatements`).selectOption(reinst);
    await page.getByLabel(`Layer ${n} reinstatement %`).fill('100'); await page.getByLabel(`Layer ${n} reinstatement %`).blur();
  };
  await fill(1, '5000000', '10000000', '1.8', '1200000', '1');
  await page.getByTestId('add-layer').click(); await fill(2, '10000000', '20000000', '1.35', '900000', '1');
  await page.getByTestId('add-layer').click(); await fill(3, '15000000', '30000000', '0.9', '600000', '2');
  await page.getByLabel('Layer 3 AAD', { exact: true }).check(); await page.getByLabel('Layer 3 AAD amount').fill('2000000');
  await shoot(page, 'B2-structure-3-layers');
  await page.getByTestId('save-structure').click();
  await expect(page.getByTestId('save-status')).toHaveText(/Draft saved/);
  await page.reload();
  await expect(page.getByLabel('Layer 3 deductible')).toHaveValue('17,500,000');
  await shoot(page, 'B3-structure-reloaded');
  await page.goto('/broking');
  await shoot(page, 'C-contract-list');
});
