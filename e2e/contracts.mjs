// Contracts: the launcher pill lands on two options — Proportional and
// Non-proportional. Proportional opens the Universe treaty detail (the 2×2
// grid: contract details, limit details, commissions, loss participation)
// with the lookups' dropdowns, the treaty-type gating, the derived amounts,
// the renewal default and the required-field hold; non-proportional opens
// the contract details pane only. A saved contract lands on its own URL,
// survives a reload, and is read by the register, the renewal calendar and
// the dashboard's calendar shelf.
import assert from 'node:assert/strict';
import { BASE, launch, login, makeStep, goHub, apiAs } from './lib.mjs';

const byLabel = (page, label) => page.locator(`[aria-label="${label}"]`).first();

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `ctr-${Date.now()}`;
  const cedantName = `Atlas Mutual ${tag}`;
  console.log('contracts: two options / proportional treaty detail / non-proportional left pane / register + calendar');

  let propUrl = '';
  let propId = '';
  let npId = '';

  try {
    const broker = await login(browser, 'broker', errors);
    // A cedant of our own, domiciled in GB, so the country → cedant filter
    // is deterministic.
    await apiAs(broker, 'POST', '/cedants', { name: cedantName, domicile: 'GB' });

    await step('the launcher\'s Contracts pill lands on the two options and the register', async () => {
      await goHub(broker, 'Contracts');
      await broker.waitForURL(/\/contracts$/, { timeout: 10000 });
      await broker.waitForSelector('[data-testid=contracts-proportional]');
      await broker.waitForSelector('[data-testid=contracts-non-proportional]');
      // The contracts already on the book, each with its basis.
      await broker.waitForSelector('[data-testid=contract-row]', { timeout: 15000 });
      const qs = broker.locator('[data-testid=contract-row]:has-text("IBER-27-MOT-QS")');
      assert.ok(await qs.locator('.pill:has-text("Proportional")').count() > 0, 'a quota share reads as proportional');
      const cat = broker.locator('[data-testid=contract-row]:has-text("GRV-27-PROP-CAT")');
      assert.ok(await cat.locator('.pill:has-text("Non-proportional")').count() > 0, 'a CAT XL reads as non-proportional');
      // The basis filter narrows the register.
      await broker.click('.segmini >> text="Proportional"');
      await broker.waitForTimeout(200);
      assert.equal(await broker.locator('[data-testid=contract-row] .pill:has-text("Non-proportional")').count(), 0, 'only proportional contracts remain');
      await broker.click('.segmini >> text="All"');
    });

    await step('proportional: the Universe treaty detail — four panes, the lookups\' dropdowns, proportional types only', async () => {
      await broker.click('[data-testid=contracts-proportional]');
      await broker.waitForURL(/\/contracts\/proportional$/, { timeout: 10000 });
      await broker.waitForSelector('[data-testid=prop-treaty-detail]');
      assert.equal(await broker.locator('[data-testid=prop-treaty-detail] .td-card--pane').count(), 4, 'contract details, limit details, commissions, loss participation');
      for (const id of ['contract-details', 'limit-details', 'commissions', 'loss-participation']) {
        assert.equal(await broker.locator(`[data-testid=${id}]`).count(), 1, `${id} pane`);
      }
      // The treaty types are the proportional ones only.
      const types = (await byLabel(broker, 'Treaty Type').locator('option').allTextContents()).map((t) => t.trim());
      assert.ok(types.includes('Quota Share') && types.includes('First Surplus') && types.includes('Fac Oblig'), `proportional types offered: ${types}`);
      assert.ok(!types.includes('CAT XL') && !types.includes('Risk XL'), 'no non-proportional type on the proportional page');
      // The country filters the cedant register.
      await byLabel(broker, 'Country').selectOption({ label: 'United Kingdom' });
      const cedant = byLabel(broker, 'Cedant Name');
      await cedant.locator(`option:has-text("${cedantName}")`).waitFor({ state: 'attached', timeout: 10000 });
      await cedant.selectOption({ label: cedantName });
      // The broker dropdown is the brokers lookup.
      const brokers = (await byLabel(broker, 'Broker').locator('option').allTextContents()).map((t) => t.trim());
      assert.ok(brokers.includes('Guy Carpenter') && brokers.includes('Aon'), 'the Broker dropdown is the brokers lookup');
      // Currency preselects USD.
      assert.equal((await byLabel(broker, 'Currency').locator('option:checked').textContent()).trim(), 'USD');
    });

    await step('quota share: the QS fields are live, the surplus ones are not; retention ⇄ cession and the amounts derive', async () => {
      await byLabel(broker, 'Treaty Type').selectOption({ label: 'Quota Share' });
      assert.ok(await byLabel(broker, 'Surplus Max Retention').isDisabled(), 'surplus max retention is not applicable');
      assert.equal(await byLabel(broker, 'Surplus Max Retention').getAttribute('title'), 'Not applicable for this treaty type');
      assert.ok(await byLabel(broker, 'Surplus EPI').isDisabled(), 'surplus EPI is not applicable');
      await byLabel(broker, 'QS 100% Limit').fill('1000000');
      assert.equal(await byLabel(broker, 'QS 100% Limit').inputValue(), '1,000,000', 'grouped as typed');
      await byLabel(broker, 'Retention %').fill('40');
      assert.equal(await byLabel(broker, 'Cession %').inputValue(), '60%', 'cession follows retention');
      assert.equal(await byLabel(broker, 'Retention Amount').inputValue(), '400,000');
      assert.equal(await byLabel(broker, 'Cession Amount').inputValue(), '600,000');
      assert.equal(await byLabel(broker, 'Total Treaty Capacity').inputValue(), '1,000,000', 'quota share capacity is the QS limit');
      await byLabel(broker, 'Cession %').fill('75');
      assert.equal(await byLabel(broker, 'Retention %').inputValue(), '25%', 'retention follows cession');
      // Quota Share & Surplus activates the surplus half; capacity adds it.
      await byLabel(broker, 'Treaty Type').selectOption({ label: 'Quota Share & Surplus' });
      assert.ok(!(await byLabel(broker, 'Surplus Max Retention').isDisabled()), 'surplus max retention is live');
      await byLabel(broker, 'Surplus Max Retention').fill('500000');
      await byLabel(broker, 'Number of Lines').fill('4');
      assert.equal(await byLabel(broker, 'Total Treaty Capacity').inputValue(), '3,000,000', 'QS limit + max retention × lines');
    });

    await step('dates and description: renewal = inception + 12 months until edited; UW year and the description derive', async () => {
      await byLabel(broker, 'Treaty Inception Date').fill('2027-01-31');
      assert.equal(await byLabel(broker, 'Treaty Renewal Date').inputValue(), '2028-01-31', 'renewal defaults to inception + 12 months');
      assert.equal(await byLabel(broker, 'UW Year').inputValue(), '2027');
      await broker.click('[data-testid=cob-button]');
      await broker.click('.cob-item:has-text("Property")');
      await broker.click('.cob-item:has-text("Motor")');
      await broker.click('button:has-text("Done")');
      const desc = await broker.locator('[data-testid=contract-description]').inputValue();
      assert.equal(desc, `2027 ${cedantName} Quota Share & Surplus (Property, Motor) GB`, desc);
      // Editing the renewal by hand stops the default following inception.
      await byLabel(broker, 'Treaty Renewal Date').fill('2027-12-31');
      await byLabel(broker, 'Treaty Inception Date').fill('2027-02-01');
      assert.equal(await byLabel(broker, 'Treaty Renewal Date').inputValue(), '2027-12-31', 'a hand-set renewal is kept');
      assert.equal(await byLabel(broker, 'UW Year').inputValue(), '2027');
    });

    await step('save is held until the required fields are in, then lands on the contract\'s own URL', async () => {
      await broker.click('[data-testid=save-treaty-detail]');
      await broker.waitForSelector('[data-testid=required-summary]', { timeout: 5000 });
      const summary = await broker.locator('[data-testid=required-summary]').textContent();
      for (const label of ['Broker', 'Experience Start Year', 'Quota Share EPI', 'Surplus EPI', 'Fixed QS Commission %', 'Fixed Surplus Commission %']) {
        assert.ok(summary.includes(label), `${label} is required (${summary})`);
      }
      assert.ok(await broker.locator('.fr-label--missing:has-text("Broker")').count() > 0, 'the missing field is marked');
      assert.ok(/\/contracts\/proportional$/.test(broker.url()), 'nothing was saved');
      await byLabel(broker, 'Broker').selectOption({ label: 'Guy Carpenter' });
      await byLabel(broker, 'Experience Start Year').selectOption('2020');
      await byLabel(broker, 'Quota Share EPI').fill('5000000');
      await byLabel(broker, 'Surplus EPI').fill('2000000');
      await byLabel(broker, 'QS Commission %').fill('30');
      await byLabel(broker, 'Surplus Commission %').fill('25');
      await byLabel(broker, 'Brokerage %').fill('2.5');
      await broker.click('[data-testid=save-treaty-detail]');
      await broker.waitForURL(/\/contracts\/proportional\/[0-9a-f-]{36}$/, { timeout: 20000 });
      propUrl = broker.url();
      propId = propUrl.split('/').pop();
      await broker.waitForSelector('.toast-text:has-text("Treaty detail saved.")', { timeout: 10000 });
    });

    await step('a reload reads the saved treaty detail back, terms and all', async () => {
      await broker.goto(propUrl, { waitUntil: 'networkidle' });
      await broker.waitForSelector('[data-testid=prop-treaty-detail]');
      await broker.waitForFunction(() => document.querySelector('[aria-label="QS 100% Limit"]')?.value === '1,000,000', null, { timeout: 10000 });
      assert.equal((await byLabel(broker, 'Treaty Type').locator('option:checked').textContent()).trim(), 'Quota Share & Surplus');
      assert.equal((await byLabel(broker, 'Cedant Name').locator('option:checked').textContent()).trim(), cedantName);
      assert.equal((await byLabel(broker, 'Country').locator('option:checked').textContent()).trim(), 'United Kingdom');
      assert.equal((await byLabel(broker, 'Broker').locator('option:checked').textContent()).trim(), 'Guy Carpenter');
      assert.equal(await byLabel(broker, 'Experience Start Year').inputValue(), '2020');
      assert.equal(await byLabel(broker, 'Retention %').inputValue(), '25%');
      assert.equal(await byLabel(broker, 'Cession %').inputValue(), '75%');
      assert.equal(await byLabel(broker, 'Surplus Max Retention').inputValue(), '500,000');
      assert.equal(await byLabel(broker, 'Number of Lines').inputValue(), '4');
      assert.equal(await byLabel(broker, 'Total Treaty Capacity').inputValue(), '3,000,000');
      assert.equal(await byLabel(broker, 'Quota Share EPI').inputValue(), '5,000,000');
      assert.equal(await byLabel(broker, 'QS Commission %').inputValue(), '30%');
      assert.equal(await byLabel(broker, 'Brokerage %').inputValue(), '2.5%');
      assert.equal(await byLabel(broker, 'Treaty Inception Date').inputValue(), '2027-02-01');
      assert.equal(await byLabel(broker, 'Treaty Renewal Date').inputValue(), '2027-12-31');
      assert.ok((await broker.locator('[data-testid=cob-button]').textContent()).includes('Property, Motor'), 'the classes are back');
      // The contract's reference is on the page, and the summary reads the contract.
      const ref = await broker.locator('[data-testid=contract-details] .contract-id .mono').textContent();
      assert.ok(/^UB-2027-/.test(ref), `a reference was assigned (${ref})`);
      const summary = await broker.locator('[data-testid=contract-summary]').innerText();
      assert.ok(summary.includes(cedantName) && summary.includes('Quota Share & Surplus') && summary.includes('Guy Carpenter'), summary);
      // The stored terms went on the placement's proportional structure, and
      // its quota-share / surplus layers carry the capacity and the EPI.
      const stored = await apiAs(broker, 'GET', `/placements/${propId}`);
      const prop = stored.quote_structures.find((s) => s.basis === 'PROP').prop;
      assert.equal(prop.qsLimit, '1000000');
      assert.equal(prop.commissionMode, 'fixed');
      assert.equal(prop.treatyType, 'Quota Share & Surplus');
      assert.equal(stored.class, 'Property / Motor Quota Share & Surplus');
      const qs = stored.layers.find((l) => l.type === 'QS');
      const surplus = stored.layers.find((l) => l.type === 'Surplus');
      assert.equal(Number(qs.limit_amt), 1000000);
      assert.equal(Number(qs.premium100), 5000000);
      assert.equal(Number(surplus.limit_amt), 2000000);
      assert.equal(Number(surplus.premium100), 2000000);
    });

    await step('sliding scale and loss participation: the toggles dim the inactive block, the modals keep their tables', async () => {
      await broker.click('[aria-label="Commission mode"] >> text="SLIDING SCALE"');
      assert.ok((await broker.locator('[data-testid=fixed-block]').getAttribute('class')).includes('is-off'), 'the fixed block dims');
      await broker.click('[data-testid=sliding-modal-button]');
      const table = broker.locator('[data-testid=sliding-table]');
      await table.waitFor();
      await broker.locator('.mod-modal [aria-label="Provisional Commission %"], .mod-modal .np-terms-grid input').first().fill('30');
      const rows = table.locator('tbody tr');
      await rows.nth(0).locator('input').nth(0).fill('65');
      await rows.nth(0).locator('input').nth(1).fill('30');
      await rows.nth(1).locator('input').nth(0).fill('80');
      await rows.nth(1).locator('input').nth(1).fill('25');
      await broker.click('[data-testid=save-sliding-table]');
      await broker.waitForSelector('[data-testid=sliding-block] .np-badge-count:has-text("2 row(s) · provisional 30%")', { timeout: 5000 });
      await byLabel(broker, 'Sliding Min Loss Ratio %').fill('40');
      await byLabel(broker, 'Sliding Max Loss Ratio %').fill('80');
      await byLabel(broker, 'Sliding Min Commission %').fill('20');
      await byLabel(broker, 'Sliding Max Commission %').fill('35');
      // Loss participation on: its scalars become required, its corridors are kept.
      await broker.click('[aria-label="Loss participation enabled"] >> text="YES"');
      await broker.click('[data-testid=save-treaty-detail]');
      await broker.waitForSelector('[data-testid=required-summary]:has-text("LP Min Loss Ratio %")', { timeout: 5000 });
      await byLabel(broker, 'LP Min Loss Ratio %').fill('70');
      await byLabel(broker, 'LP Max Loss Ratio %').fill('100');
      await byLabel(broker, 'LP Reinsurer Share %').fill('50');
      await broker.click('[data-testid=corridors-modal-button]');
      const lp = broker.locator('[data-testid=lp-slides-table] tbody tr');
      await lp.first().waitFor();
      await lp.nth(0).locator('input').nth(0).fill('70');
      await lp.nth(0).locator('input').nth(1).fill('85');
      await lp.nth(0).locator('input').nth(2).fill('40');
      await broker.click('[data-testid=save-lp-slides]');
      await broker.waitForSelector('[data-testid=lp-block] .np-badge-count:has-text("1 corridor(s)")', { timeout: 5000 });
      // The EPI split defaults to an equal share of the total.
      await broker.click('[data-testid=epi-split-button]');
      const split = broker.locator('[data-testid=epi-split-table]');
      await split.waitFor();
      assert.equal(await split.locator('tbody tr').count(), 2, 'one row per class');
      assert.equal(await split.locator('tbody tr').nth(0).locator('input').inputValue(), '3,500,000', 'an equal share of 7,000,000');
      await broker.click('[data-testid=save-epi-split]');
      await broker.waitForSelector('[data-testid=loss-participation] .np-badge-count:has-text("2 class(es)")', { timeout: 5000 });
      await broker.click('[data-testid=save-treaty-detail]');
      await broker.waitForSelector('.toast-text:has-text("Treaty detail saved.")', { timeout: 10000 });
      await broker.goto(propUrl, { waitUntil: 'networkidle' });
      await broker.waitForFunction(() => document.querySelector('[aria-label="Sliding Min Loss Ratio %"]')?.value === '40%', null, { timeout: 10000 });
      assert.ok((await broker.locator('[data-testid=fixed-block]').getAttribute('class')).includes('is-off'), 'the sliding scale is back');
      assert.ok(!(await broker.locator('[data-testid=lp-block]').getAttribute('class')).includes('is-off'), 'loss participation is on');
      await broker.waitForSelector('[data-testid=sliding-block] .np-badge-count:has-text("2 row(s) · provisional 30%")');
      await broker.waitForSelector('[data-testid=lp-block] .np-badge-count:has-text("1 corridor(s)")');
    });

    await step('the register and the top bar find the contract; the renewal calendar opens it on its basis', async () => {
      await goHub(broker, 'Contracts');
      await broker.waitForSelector('[data-testid=contract-row]', { timeout: 15000 });
      await broker.fill('input[aria-label="Search contracts"]', cedantName);
      await broker.waitForTimeout(600);
      const row = broker.locator('[data-testid=contract-row]');
      await broker.waitForFunction((n) => document.querySelectorAll('[data-testid=contract-row]').length === n, 1, { timeout: 10000 });
      assert.ok((await row.first().innerText()).includes('Quota Share & Surplus'), 'the treaty type is read from the class');
      assert.ok(await row.first().locator('.pill:has-text("Proportional")').count() > 0, 'and its basis');
      await row.first().locator('button:has-text("Open")').click();
      await broker.waitForURL(propUrl, { timeout: 10000 });
      // The top bar's search hands the query to the register.
      await broker.fill('.topbar-search input', cedantName);
      await broker.press('.topbar-search input', 'Enter');
      await broker.waitForURL(/\/contracts\?q=/, { timeout: 10000 });
      await broker.waitForSelector(`[data-testid=contract-row]:has-text("${cedantName}")`, { timeout: 10000 });
      // The renewal calendar: the contract incepts within a year, and its
      // reference opens the contract on its basis page.
      await broker.goto(`${BASE}/renewals`, { waitUntil: 'networkidle' });
      await broker.click('.segmini >> text="12 mo"');
      await broker.waitForSelector(`table.renewal-cal >> text=${cedantName}`, { timeout: 15000 });
      const calRow = broker.locator(`table.renewal-cal tr:has-text("${cedantName}")`).first();
      assert.ok((await calRow.innerText()).includes('QS + Surplus') || (await calRow.innerText()).includes('QS'), 'the treaty shape reads from the layers');
      await calRow.locator('button.refbtn').click();
      await broker.waitForURL(propUrl, { timeout: 15000 });
      await broker.waitForSelector('[data-testid=prop-treaty-detail]');
    });

    await step('non-proportional: the contract details pane only, with the NP treaty types', async () => {
      await goHub(broker, 'Contracts');
      await broker.click('[data-testid=contracts-non-proportional]');
      await broker.waitForURL(/\/contracts\/non-proportional$/, { timeout: 10000 });
      await broker.waitForSelector('[data-testid=np-contract-details]');
      assert.equal(await broker.locator('[data-testid=np-contract-details] .td-card--pane').count(), 1, 'the left pane only');
      assert.equal(await broker.locator('[data-testid=limit-details]').count(), 0, 'no limit details');
      assert.equal(await broker.locator('[data-testid=commissions]').count(), 0, 'no commissions');
      assert.ok(await broker.locator('.fr-label:has-text("Classes of Business")').count() > 0, 'the class picker is labelled Classes of Business');
      const types = (await byLabel(broker, 'Treaty Type').locator('option').allTextContents()).map((t) => t.trim());
      assert.ok(types.includes('CAT XL') && types.includes('Risk XL') && types.includes('Stop Loss') && types.includes('Aggregate XL'), `NP types offered: ${types}`);
      assert.ok(!types.includes('Quota Share'), 'no proportional type on the non-proportional page');
      await byLabel(broker, 'Country').selectOption({ label: 'United Kingdom' });
      const cedant = byLabel(broker, 'Cedant Name');
      await cedant.locator(`option:has-text("${cedantName}")`).waitFor({ state: 'attached', timeout: 10000 });
      await cedant.selectOption({ label: cedantName });
      await byLabel(broker, 'Treaty Type').selectOption({ label: 'CAT XL' });
      await broker.click('[data-testid=cob-button]');
      await broker.click('.cob-item:has-text("Property")');
      await broker.click('button:has-text("Done")');
      await byLabel(broker, 'Treaty Inception Date').fill('2027-03-01');
      assert.equal(await byLabel(broker, 'Treaty Renewal Date').inputValue(), '2028-03-01');
      assert.equal(await broker.locator('[data-testid=contract-description]').inputValue(), `2027 ${cedantName} CAT XL (Property) GB`);
      // Held until the required set is in.
      await broker.click('[data-testid=save-contract-details]');
      await broker.waitForSelector('[data-testid=required-summary]:has-text("Broker")', { timeout: 5000 });
      await byLabel(broker, 'Broker').selectOption({ label: 'Aon' });
      await byLabel(broker, 'Experience Start Year').selectOption('2018');
      await byLabel(broker, 'Alt. Contract ID').fill(`ALT-${tag}`);
      await broker.click('[data-testid=save-contract-details]');
      await broker.waitForURL(/\/contracts\/non-proportional\/[0-9a-f-]{36}$/, { timeout: 20000 });
      npId = broker.url().split('/').pop();
      await broker.waitForSelector('.toast-text:has-text("Contract details saved.")', { timeout: 10000 });
      await broker.reload({ waitUntil: 'networkidle' });
      await broker.waitForSelector('[data-testid=np-contract-details]');
      await broker.waitForFunction(() => document.querySelector('[aria-label="Alt. Contract ID"]')?.value?.startsWith('ALT-'), null, { timeout: 10000 });
      assert.equal((await byLabel(broker, 'Treaty Type').locator('option:checked').textContent()).trim(), 'CAT XL');
      assert.equal((await byLabel(broker, 'Broker').locator('option:checked').textContent()).trim(), 'Aon');
      assert.equal(await byLabel(broker, 'Experience Start Year').inputValue(), '2018');
      assert.equal(await byLabel(broker, 'Alt. Contract ID').inputValue(), `ALT-${tag}`);
      assert.equal(await broker.locator('[data-testid=np-contract-details] .td-card--pane').count(), 1, 'still the left pane only');
      const stored = await apiAs(broker, 'GET', `/placements/${npId}`);
      assert.equal(stored.class, 'Property CAT XL');
      assert.ok(stored.notes.includes('Broker: Aon') && stored.notes.includes('Experience from 2018') && stored.notes.includes(`Alt. Contract ID: ALT-${tag}`), stored.notes);
      // A contract by id opens on its basis page.
      await broker.goto(`${BASE}/contracts/${npId}`, { waitUntil: 'networkidle' });
      await broker.waitForURL(new RegExp(`/contracts/non-proportional/${npId}$`), { timeout: 10000 });
      await broker.goto(`${BASE}/placements/${propId}`, { waitUntil: 'networkidle' });
      await broker.waitForURL(new RegExp(`/contracts/proportional/${propId}$`), { timeout: 10000 });
    });

    await step('the dashboard keeps its book, its launcher has the four functions, and its calendar shelf opens the contract', async () => {
      await goHub(broker, 'Dashboard');
      await broker.waitForSelector('h2:has-text("Treaty renewal book")', { timeout: 10000 });
      const pills = (await broker.locator('.launcher a').allTextContents()).map((t) => t.trim());
      assert.deepEqual(pills, ['Contracts', 'Renewal calendar', 'Portfolio intelligence', 'Market intelligence']);
      await broker.waitForSelector('.kpi', { timeout: 10000 });
      assert.ok(await broker.locator('.kpi').count() >= 8, 'the headline metrics are there');
      await broker.waitForSelector('text=Renewal packs by cedant — Drafts');
      // The calendar shelf: filter to our cedant and open the contract.
      const shelf = broker.locator('section:has-text("Renewal calendar — next")').first();
      const cedantFilter = shelf.locator('select[aria-label="Filter by cedant"]');
      await cedantFilter.waitFor({ timeout: 15000 });
      const option = cedantFilter.locator('option', { hasText: cedantName });
      await option.waitFor({ state: 'attached', timeout: 10000 });
      assert.equal((await option.textContent()).trim(), `${cedantName} (2)`, 'both contracts renew in the window');
      await cedantFilter.selectOption(await option.getAttribute('value'));
      await shelf.locator(`tbody tr:has-text("${cedantName}")`).first().waitFor({ timeout: 10000 });
      await shelf.locator('tbody tr:has-text("Quota Share & Surplus") button:has-text("Open")').first().click();
      await broker.waitForURL(propUrl, { timeout: 15000 });
      // Recents in the top bar remember the contracts worked on.
      await broker.click('[aria-label="Recent contracts"]');
      await broker.waitForSelector('.topbar-recents .recent-item', { timeout: 5000 });
      assert.ok(await broker.locator(`.topbar-recents .recent-item:has-text("${cedantName}")`).count() > 0, 'the contract is in the recents');
    });
  } finally {
    await browser.close();
  }
  return errors;
}
