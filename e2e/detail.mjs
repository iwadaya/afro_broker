// Treaty detail on the placement page: Country and Cedant are dropdowns in
// the creation wizard's style (country filters the cedant register, and
// moving the cedant persists), the dropdowns are the Universe modelling
// tool's reference lookups bound by row id, and the date fields carry an
// explicit calendar button that opens the native picker.
import assert from 'node:assert/strict';
import { launch, login, makeStep, BASE } from './lib.mjs';

const fr = (page, label) => page
  .locator('.fr', { has: page.locator('.fr-label', { hasText: label }) }).first();

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `det-${Date.now()}`;
  console.log('detail: treaty-detail dropdowns + calendar dates');

  try {
    const broker = await login(browser, 'broker', errors);

    // Seed two cedants in different countries and a placement on the first.
    const seeded = await broker.evaluate(async ({ t }) => {
      const token = localStorage.getItem('ub_token');
      const call = async (method, path, body) => {
        const r = await fetch(`/api${path}`, {
          method,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
        return r.json();
      };
      const uk = await call('POST', '/cedants', { name: `UK Mutual ${t}`, domicile: 'UK' });
      const ke = await call('POST', '/cedants', { name: `Nairobi Re ${t}`, domicile: 'Kenya' });
      const p = await call('POST', '/placements', {
        cedant_id: uk.id, class: 'Property QS', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD',
      });
      return { pid: p.id, ukName: `UK Mutual ${t}`, keName: `Nairobi Re ${t}` };
    }, { t: tag });

    await step('country and cedant render as dropdowns holding the stored values', async () => {
      await broker.goto(`${BASE}/placements/${seeded.pid}`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('.td-card');
      const country = fr(broker, 'Country').locator('select');
      assert.equal(await country.count(), 1, 'Country is a dropdown');
      // The stored domicile "UK" resolves to the United Kingdom lookup row,
      // and the dropdown holds that row's id as the modelling tool's does.
      await broker.waitForFunction(() =>
        [...document.querySelectorAll('.fr select')].some((s) => s.selectedOptions[0]?.textContent.trim() === 'United Kingdom'));
      assert.equal((await country.locator('option:checked').textContent()).trim(), 'United Kingdom');
      assert.match(await country.inputValue(), /^[0-9a-f-]{36}$/, 'bound by row id');
      const cedant = fr(broker, 'Cedant Name').locator('select');
      assert.equal(await cedant.count(), 1, 'Cedant is a dropdown');
      const selText = await cedant.locator('option:checked').textContent();
      assert.equal(selText.trim(), seeded.ukName, 'the stored cedant is selected');
    });

    await step('changing the country filters the register, and the move saves', async () => {
      const country = fr(broker, 'Country').locator('select');
      const cedant = fr(broker, 'Cedant Name').locator('select');
      await country.selectOption({ label: 'Kenya' });
      assert.equal(await cedant.inputValue(), '', 'the cedant resets with the country');
      await cedant.locator(`option:has-text("${seeded.keName}")`).waitFor({ state: 'attached' });
      const options = await cedant.locator('option').allTextContents();
      assert.ok(options.some((o) => o.includes(seeded.keName)), 'Kenya cedants offered');
      assert.ok(!options.some((o) => o.includes(seeded.ukName)), 'UK cedants filtered out');
      await cedant.selectOption({ label: seeded.keName });
      await broker.click('button:has-text("Save details")');
      await broker.waitForTimeout(800);
      await broker.goto(`${BASE}/placements/${seeded.pid}`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('.td-summary');
      const summary = await broker.locator('.td-summary').innerText();
      assert.ok(summary.includes(seeded.keName), 'the new cedant heads the summary');
      assert.ok(summary.includes('Kenya'), 'and its country with it');
    });

    await step('the date fields carry a calendar button and still save', async () => {
      assert.equal(await broker.locator('.td-card .date-field-btn').count(), 2,
        'inception and renewal both offer the calendar');
      await fr(broker, 'Treaty Inception Date').locator('input').fill('2027-02-01');
      await broker.click('button:has-text("Save details")');
      await broker.waitForTimeout(800);
      await broker.reload({ waitUntil: 'networkidle' });
      await broker.waitForSelector('.td-card');
      assert.equal(await fr(broker, 'Treaty Inception Date').locator('input').inputValue(), '2027-02-01');
      // UW year follows the inception date.
      assert.equal(await fr(broker, 'UW Year').locator('input').inputValue(), '2027');
    });

    await step('the dropdowns are the Universe lookups, bound by row id', async () => {
      const page = await login(browser, 'broker', errors);
      // The tool's lookup endpoints, in its shapes.
      const lookups = await page.evaluate(async () => {
        const token = localStorage.getItem('ub_token');
        const get = async (path) => {
          const r = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${token}` } });
          if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
          return r.json();
        };
        return {
          brokers: await get('/brokers'),
          treatyTypes: await get('/treaty-types'),
          classes: await get('/class-of-business'),
          countries: await get('/ref/lists/country/items'),
          currencies: await get('/ref/lists/currency/items'),
        };
      });
      assert.ok(lookups.brokers.some((b) => b.name === 'Guy Carpenter'), 'brokers come from the brokers table');
      assert.ok(lookups.treatyTypes.some((t) => t.name === 'CAT XL' && t.category === 'NON_PROPORTIONAL'));
      assert.ok(lookups.classes.some((c) => c.name === 'Property' && c.code === 'PROP'));
      const gb = lookups.countries.find((c) => c.code === 'GB');
      assert.equal(gb.name, 'United Kingdom');
      assert.ok(lookups.currencies.some((c) => c.code === 'SAR'));

      await page.goto(`${BASE}/placements/new`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.td-card');
      const brokerSel = fr(page, 'Broker').locator('select');
      await brokerSel.locator('option:has-text("Guy Carpenter")').waitFor({ state: 'attached' });
      const brokerLabels = (await brokerSel.locator('option').allTextContents()).map((t) => t.trim()).filter((t) => t && !t.startsWith('Select'));
      assert.deepEqual(brokerLabels, lookups.brokers.map((b) => b.name), 'the Broker dropdown is the brokers lookup');
      const countrySel = fr(page, 'Country').locator('select');
      assert.equal(await countrySel.locator(`option[value="${gb.id}"]`).textContent(), 'United Kingdom',
        'a country option is the lookup row, bound by its id');
      assert.equal(await countrySel.locator('option').count(), lookups.countries.length + 1);
      const treatySel = fr(page, 'Treaty Type').locator('select');
      const catXl = lookups.treatyTypes.find((t) => t.name === 'CAT XL');
      assert.equal(await treatySel.locator(`optgroup[label="Non-proportional"] option[value="${catXl.id}"]`).count(), 1,
        'treaty types are grouped by the tool\'s category');
      const currencySel = fr(page, 'Currency').locator('select');
      assert.equal((await currencySel.locator('option:checked').textContent()).trim(), 'USD', 'USD is preselected');

      // Picks read as the rows' names, and the placement stores those names.
      await countrySel.selectOption(gb.id);
      await treatySel.selectOption(catXl.id);
      await page.click('.cob-trigger');
      await page.click('.cob-item:has-text("Property")');
      await page.click('button:has-text("Done")');
      const summary = await page.locator('.td-summary').innerText();
      assert.ok(summary.includes('United Kingdom') && summary.includes('CAT XL') && summary.includes('Property'), summary);
      assert.ok((await page.locator('.td-contract').innerText()).includes('CAT XL (Property) United Kingdom'));
    });

    await step('an underwriter reads the dropdowns but cannot move them', async () => {
      const uw = await login(browser, 'uw', errors);
      await uw.goto(`${BASE}/placements/${seeded.pid}`, { waitUntil: 'networkidle' });
      await uw.waitForSelector('.td-card');
      assert.ok(await fr(uw, 'Country').locator('select').isDisabled(), 'country locked');
      assert.ok(await fr(uw, 'Cedant Name').locator('select').isDisabled(), 'cedant locked');
      assert.ok(await uw.locator('.td-card .date-field-btn').first().isDisabled(), 'calendar locked');
    });
  } finally {
    await browser.close();
  }
  return errors;
}
