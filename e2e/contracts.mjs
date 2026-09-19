// Contracts: the launcher pill lands on two options — Proportional and
// Non-proportional. Proportional opens the Universe treaty detail (the 2×2
// grid: contract details, limit details, commissions, loss participation)
// with the lookups' dropdowns, the treaty-type gating, the derived amounts,
// the renewal default and the required-field hold; non-proportional opens
// the contract details pane with the structure pane beside it. A saved
// contract lands on its own URL, survives a reload, and is read by the
// register, the renewal calendar and the dashboard's calendar shelf; the
// floating dock takes it on to the Documents step (the Universe layout) and
// the Shares step (the broker share and the reinsurer shares, written and
// signed).
import assert from 'node:assert/strict';
import { BASE, launch, login, makeStep, goHub, apiAs } from './lib.mjs';

const byLabel = (page, label) => page.locator(`[aria-label="${label}"]`).first();

/** Wake the floating dock (it fades when idle) before clicking into it. */
async function wakeDock(page) {
  await page.mouse.move(8, 8);
  await page.mouse.move(16, 16);
  await page.waitForSelector('[data-testid=wizard-dock]:not(.is-hidden)', { timeout: 5000 });
}

/** Upload one text file on the Documents step — pick the type, the file, a title if given, ↑ Upload — and wait for its row. */
async function uploadDocument(page, name, typeLabel, text, title) {
  await byLabel(page, 'Document Type').selectOption({ label: typeLabel });
  await page.setInputFiles('input[aria-label="Files"]', { name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await page.waitForSelector(`[data-testid=document-file-chip]:has-text("${name}")`);
  if (title) await byLabel(page, 'Document Title').fill(title);
  await page.click('[data-testid=document-upload-button]');
  const row = page.locator(`[data-testid=document-row]:has-text("${name}")`);
  await row.waitFor({ timeout: 15000 });
  return row;
}

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

    await step('the house heads every screen: the top bar carries the Afro-Asian Insurance Services logo, the tab its name', async () => {
      const logo = broker.locator('.topbar [data-testid=brand-logo]');
      await logo.waitFor({ timeout: 10000 });
      assert.match(await logo.getAttribute('alt'), /^Afro-Asian Insurance Services/);
      assert.equal(await logo.getAttribute('src'), '/brand/afro-asian/logo.png');
      assert.ok(await logo.evaluate((img) => img.complete && img.naturalWidth > 0), 'the image loaded');
      assert.ok((await logo.boundingBox()).height >= 40, 'large enough to read');
      // The old product name is gone: no wordmark beside the logo, the tab titled for the house.
      const barText = await broker.locator('.topbar').innerText();
      assert.ok(!barText.includes('BROKER·IQ') && !/\bIQ\b/.test(barText), `no wordmark: ${barText}`);
      assert.equal(await broker.locator('body:has-text("Universe Broking")').count(), 0, 'no old house name');
      assert.match(await broker.title(), /^Afro-Asian Insurance Services/);
    });

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

    await step('the dock floats: it fades when idle, returns on movement, and Save & next opens the Documents step', async () => {
      // No inline footer: Back, Save and Save & next live in the floating dock.
      assert.equal(await broker.locator('.contract-actions').count(), 0, 'no footer bar');
      const dock = broker.locator('[data-testid=wizard-dock]');
      assert.ok(await dock.locator('[data-testid=wizard-back]:has-text("Back: Contracts")').count() > 0);
      assert.ok(await dock.locator('[data-testid=save-treaty-detail]:has-text("Save")').count() > 0);
      assert.ok(await dock.locator('[data-testid=wizard-next]:has-text("Save & next: Documents")').count() > 0);
      // Left alone it fades; any movement brings it back.
      await broker.waitForSelector('[data-testid=wizard-dock].is-hidden', { timeout: 8000 });
      await wakeDock(broker);
      await broker.click('[data-testid=wizard-next]');
      await broker.waitForURL(new RegExp(`/contracts/proportional/${propId}/documents$`), { timeout: 20000 });
      await broker.waitForSelector('[data-testid=contract-documents]', { timeout: 10000 });
      await broker.waitForSelector('h2:has-text("Documents")');
      assert.ok((await broker.locator('[data-testid=contract-summary]').innerText()).includes(cedantName), 'the same contract heads the page');
    });

    await step('documents (proportional): the Universe layout — upload a slip with its title, view, download and delete it', async () => {
      await broker.waitForSelector('[data-testid=documents-count]:has-text("0 FILES")', { timeout: 10000 });
      assert.ok(await broker.locator('.docs-chip:has-text("Files for Treaty")').count() > 0, "the tool's header chip");
      assert.ok((await broker.locator('[data-testid=documents-contract-id]').innerText()).trim().length > 0, 'and the contract id');
      assert.ok(await broker.locator('.docs-dropzone:has-text("Drag & drop files here")').count() > 0, 'the dropzone');
      assert.ok(await broker.locator('button:has-text("+ Select Files")').count() > 0);
      assert.ok(await broker.locator('.docs-card-title:has-text("Uploaded Documents")').count() > 0);
      assert.ok(await broker.locator('button:has-text("↻ Reload")').count() > 0);
      // The title follows the document type, then the picked file while it is untouched; the description is optional.
      await byLabel(broker, 'Document Type').selectOption({ label: 'Final Slip' });
      assert.equal(await byLabel(broker, 'Document Title').inputValue(), 'Final Signed Slip');
      await byLabel(broker, 'Description').fill('From the cedant');
      const row = await uploadDocument(broker, `slip-${tag}.txt`, 'Final Slip', 'Slip wording for the treaty');
      const heads = (await broker.locator('.docs-table thead th').allTextContents()).map((t) => t.trim());
      assert.deepEqual(heads, ['File', 'Type', 'Title', 'Size', 'Uploaded', 'Actions']);
      assert.ok(await row.locator('.docs-type-pill:has-text("Final Slip")').count() > 0, 'the type is on the row');
      const text = await row.innerText();
      assert.ok(text.includes(`slip-${tag}`), 'and the title, after the file');
      assert.ok(text.includes('From the cedant'), 'and the description');
      assert.equal(await byLabel(broker, 'Document Title').inputValue(), 'Final Signed Slip', 'the form is ready for the next file');
      assert.equal(await byLabel(broker, 'Description').inputValue(), '');
      assert.ok(text.includes('Demo Broker'), 'and who uploaded it');
      await broker.waitForSelector('[data-testid=documents-count]:has-text("1 FILE")');
      // View opens the preview over the page; Close puts it away.
      await row.locator('button:has-text("View")').click();
      await broker.waitForSelector('[data-testid=document-preview]', { timeout: 10000 });
      assert.ok((await broker.locator('.docs-preview-name').innerText()).includes(`slip-${tag}.txt`));
      await broker.click('[data-testid=document-preview] button[aria-label="Close"]');
      await broker.waitForSelector('[data-testid=document-preview]', { state: 'detached' });
      // Download hands the browser the file under its own name.
      const [dl] = await Promise.all([broker.waitForEvent('download', { timeout: 15000 }), row.locator('button:has-text("Download")').click()]);
      assert.equal(dl.suggestedFilename(), `slip-${tag}.txt`);
      // The API holds it against the contract.
      const stored = await apiAs(broker, 'GET', `/placements/${propId}/contract-documents`);
      assert.equal(stored.length, 1);
      assert.equal(stored[0].doc_type, 'Final Slip');
      assert.equal(stored[0].title, `slip-${tag}`);
      assert.equal(stored[0].description, 'From the cedant');
      assert.equal(stored[0].size_bytes, 'Slip wording for the treaty'.length);
      // Delete (the confirm is accepted by the harness), and the list is empty again.
      await row.locator(`button[aria-label="Delete slip-${tag}.txt"]`).click();
      await broker.waitForSelector('[data-testid=documents-count]:has-text("0 FILES")', { timeout: 10000 });
      assert.equal(await broker.locator('[data-testid=document-row]').count(), 0);
      // The dock goes on to the shares; Back returns to the treaty detail.
      await wakeDock(broker);
      assert.ok(await broker.locator('[data-testid=wizard-next]:has-text("Next: Shares")').count() > 0);
      await broker.click('[data-testid=wizard-back]');
      await broker.waitForURL(propUrl, { timeout: 10000 });
      await broker.waitForSelector('[data-testid=prop-treaty-detail]');
    });

    await step('shares (proportional): the broker share and the reinsurer shares, written and signed, saved and read back', async () => {
      await broker.goto(`${BASE}/contracts/proportional/${propId}/documents`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('[data-testid=contract-documents]');
      await wakeDock(broker);
      await broker.click('[data-testid=wizard-next]');
      await broker.waitForURL(new RegExp(`/contracts/proportional/${propId}/shares$`), { timeout: 20000 });
      await broker.waitForSelector('[data-testid=reinsurer-shares]', { timeout: 10000 });
      await broker.waitForSelector('h2:has-text("Shares")');
      assert.ok((await broker.locator('[data-testid=contract-summary]').innerText()).includes(cedantName), 'the same contract heads the page');
      // Written and signed columns on the reinsurer table; order, placed order and the placement bar on the broker's.
      const reHeads = (await broker.locator('[data-testid=reinsurer-shares] thead th').allTextContents()).map((t) => t.trim());
      assert.ok(reHeads.includes('Written share') && reHeads.includes('Signed share'), reHeads.join(' | '));
      const brHeads = (await broker.locator('[data-testid=broker-shares] thead th').allTextContents()).map((t) => t.trim());
      assert.deepEqual(brHeads.filter(Boolean), ['Broker', 'Role', 'Order', 'Placed order', 'Placement', 'Note']);
      // This desk heads the broker share by default, with the whole order and nothing placed yet.
      const brokerRows = broker.locator('[data-testid=broker-shares] [data-testid=share-row]');
      assert.equal(await brokerRows.count(), 1);
      assert.equal(await brokerRows.first().locator('[aria-label="Broker"]').inputValue(), 'Afro-Asian Insurance Services');
      assert.equal(await brokerRows.first().locator('[aria-label="Broker role"]').inputValue(), 'lead');
      assert.equal(await brokerRows.first().locator('[aria-label="Order %"]').inputValue(), '100%');
      assert.equal(await brokerRows.first().locator('[aria-label="Signed share %"]').count(), 0, 'no signed column on the broker side');
      assert.equal((await brokerRows.first().locator('[data-testid=broker-placed]').innerText()).trim(), '0%');
      assert.ok((await brokerRows.first().locator('[data-testid=placement-bar]').innerText()).includes('nothing placed yet'));
      assert.equal(await brokerRows.first().locator('[role=progressbar]').getAttribute('aria-valuenow'), '0');
      // Two reinsurers off the register, the first leading; the rating reads through.
      await broker.click('[data-testid=add-reinsurer]');
      await broker.click('[data-testid=add-reinsurer]');
      const reRows = broker.locator('[data-testid=reinsurer-shares] [data-testid=share-row]');
      assert.equal(await reRows.count(), 2);
      await reRows.nth(0).locator('[aria-label="Reinsurer"]').fill('Swiss Re');
      await reRows.nth(0).locator('[data-testid=share-market-meta]').waitFor({ timeout: 10000 });
      assert.ok((await reRows.nth(0).locator('[data-testid=share-market-meta]').innerText()).includes('Rated AA-'));
      assert.ok(await reRows.nth(0).locator('[aria-label="Lead"]').isChecked(), 'the first reinsurer leads');
      await reRows.nth(0).locator('[aria-label="Written share %"]').fill('60');
      await reRows.nth(0).locator('[aria-label="Signed share %"]').fill('55');
      await reRows.nth(0).locator('[aria-label="Reference"]').fill('SR/27/1');
      await reRows.nth(1).locator('[aria-label="Reinsurer"]').fill('Munich Re');
      await reRows.nth(1).locator('[aria-label="Written share %"]').fill('50');
      await reRows.nth(1).locator('[aria-label="Signed share %"]').fill('45');
      await broker.waitForSelector('[data-testid=reinsurer-total-written]:has-text("110%")');
      await broker.waitForSelector('[data-testid=reinsurer-total-signed]:has-text("100%")');
      await broker.waitForSelector('[data-testid=placed-status]:has-text("Fully placed")');
      // The broker's placed order follows the reinsurers' signed total, and its placement bar fills.
      await broker.waitForSelector('[data-testid=broker-placed]:has-text("100%")');
      const bar = brokerRows.first().locator('[data-testid=placement-bar]');
      assert.ok((await bar.innerText()).includes('100% · fully placed'), await bar.innerText());
      assert.equal(await bar.locator('[role=progressbar]').getAttribute('aria-valuenow'), '100');
      await broker.waitForSelector('[data-testid=broker-total-placed]:has-text("100%")');
      // Sign Munich Re down to 25%: the order is 20% short, and the bar says so.
      await reRows.nth(1).locator('[aria-label="Signed share %"]').fill('25');
      await broker.waitForSelector('[data-testid=placement-bar]:has-text("80% · 20% short")');
      assert.equal(await bar.locator('[role=progressbar]').getAttribute('aria-valuenow'), '80');
      await reRows.nth(1).locator('[aria-label="Signed share %"]').fill('45');
      await broker.waitForSelector('[data-testid=placement-bar]:has-text("100% · fully placed")');
      // The Add buttons sit on the tables' right edge, in line with the remove buttons.
      for (const [table, add] of [['broker-shares', 'add-broker'], ['reinsurer-shares', 'add-reinsurer']]) {
        const addBox = await broker.locator(`[data-testid=${add}]`).boundingBox();
        const tableBox = await broker.locator(`[data-testid=${table}] .shares-table`).boundingBox();
        assert.ok(Math.abs((addBox.x + addBox.width) - (tableBox.x + tableBox.width)) < 2, `${add} is right-justified`);
      }
      // Save from the dock; a reload brings the table back.
      await wakeDock(broker);
      await broker.click('[data-testid=save-shares]');
      await broker.waitForSelector('[data-testid=save-shares]:has-text("Saved")', { timeout: 10000 });
      await broker.reload({ waitUntil: 'networkidle' });
      await broker.waitForSelector('[data-testid=reinsurer-shares] [data-testid=share-row]', { timeout: 10000 });
      assert.equal(await reRows.count(), 2);
      assert.equal(await reRows.nth(0).locator('[aria-label="Signed share %"]').inputValue(), '55%');
      assert.equal(await reRows.nth(0).locator('[aria-label="Reference"]').inputValue(), 'SR/27/1');
      const stored = await apiAs(broker, 'GET', `/placements/${propId}/shares`);
      assert.deepEqual(stored.broker.map((s) => [s.name, s.role, s.written_pct, s.signed_pct]), [['Afro-Asian Insurance Services', 'lead', 100, null]], 'the order; the placed order is derived');
      assert.deepEqual(stored.reinsurers.map((s) => [s.name, s.role, s.written_pct, s.signed_pct]), [['Swiss Re', 'lead', 60, 55], ['Munich Re', 'follow', 50, 45]]);
      assert.ok(stored.reinsurers[0].market_id, 'bound to the register');
      assert.equal(stored.reinsurers[0].market_rating, 'AA-');
      assert.deepEqual(stored.totals.reinsurers, { written_pct: 110, signed_pct: 100 });
      // Back returns to the documents.
      await wakeDock(broker);
      assert.ok(await broker.locator('[data-testid=wizard-back]:has-text("Back: Documents")').count() > 0);
      await broker.click('[data-testid=wizard-back]');
      await broker.waitForURL(new RegExp(`/contracts/proportional/${propId}/documents$`), { timeout: 10000 });
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

    await step('non-proportional: contract details on the left, the Universe structure pane on the right', async () => {
      await goHub(broker, 'Contracts');
      await broker.click('[data-testid=contracts-non-proportional]');
      await broker.waitForURL(/\/contracts\/non-proportional$/, { timeout: 10000 });
      await broker.waitForSelector('[data-testid=np-contract-details]');
      assert.equal(await broker.locator('[data-testid=np-contract-details] .td-card--pane').count(), 2, 'contract details and structure');
      assert.equal(await broker.locator('[data-testid=np-structure]').count(), 1, 'the STRUCTURE pane');
      assert.equal(await broker.locator('[data-testid=limit-details]').count(), 0, 'no proportional limit details');
      assert.equal(await broker.locator('[data-testid=commissions]').count(), 0, 'no proportional commissions');
      for (const label of ['Number of Layers', 'Expiring · Number of Layers', 'Deductible', 'Maximum Retention', 'Accounting Method', 'Type of XL', 'Accounts', 'Est. GNPI', 'Brokerage %', 'Taxes %', 'No Claims Bonus %', 'Profit Commission %']) {
        assert.equal(await broker.locator(`[data-testid=np-structure] [aria-label="${label}"]`).count(), 1, `${label} on the structure pane`);
      }
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
      // The structure terms, as the Universe right pane takes them.
      await byLabel(broker, 'Number of Layers').fill('3');
      await byLabel(broker, 'Expiring · Number of Layers').fill('2');
      await byLabel(broker, 'Deductible').fill('1000000');
      assert.equal(await byLabel(broker, 'Deductible').inputValue(), '1,000,000');
      await byLabel(broker, 'Maximum Retention').fill('5000000');
      await byLabel(broker, 'Accounting Method').selectOption({ label: 'Losses Occurring' });
      await byLabel(broker, 'Type of XL').selectOption({ label: 'Gross XL' });
      await byLabel(broker, 'Accounts').selectOption({ label: 'Quarterly' });
      await byLabel(broker, 'Est. GNPI').fill('50000000');
      await byLabel(broker, 'Brokerage %').fill('10');
      await byLabel(broker, 'Taxes %').fill('2');
      await byLabel(broker, 'No Claims Bonus %').fill('5');
      await byLabel(broker, 'Profit Commission %').fill('10');
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
      // The structure terms read back too.
      assert.equal(await byLabel(broker, 'Number of Layers').inputValue(), '3');
      assert.equal(await byLabel(broker, 'Expiring · Number of Layers').inputValue(), '2');
      assert.equal(await byLabel(broker, 'Deductible').inputValue(), '1,000,000');
      assert.equal(await byLabel(broker, 'Maximum Retention').inputValue(), '5,000,000');
      assert.equal(await byLabel(broker, 'Accounting Method').inputValue(), 'Losses Occurring');
      assert.equal(await byLabel(broker, 'Type of XL').inputValue(), 'Gross XL');
      assert.equal(await byLabel(broker, 'Accounts').inputValue(), 'Quarterly');
      assert.equal(await byLabel(broker, 'Est. GNPI').inputValue(), '50,000,000');
      assert.equal(await byLabel(broker, 'No Claims Bonus %').inputValue(), '5%');
      const stored = await apiAs(broker, 'GET', `/placements/${npId}`);
      assert.equal(stored.class, 'Property CAT XL');
      assert.ok(stored.notes.includes('Broker: Aon') && stored.notes.includes('Experience from 2018') && stored.notes.includes(`Alt. Contract ID: ALT-${tag}`), stored.notes);
      const np = stored.quote_structures.find((s) => s.basis === 'NP');
      assert.equal(np.npTreatyType, 'CAT XL');
      assert.equal(np.np.deductible, '1000000');
      assert.equal(np.np.xlType, 'Gross XL');
      assert.equal(np.np.estGnpi, '50000000');
      assert.equal(Number(stored.est_gwp), 50000000, 'Est. GNPI is the contract\'s estimated premium');
      // A contract by id opens on its basis page.
      await broker.goto(`${BASE}/contracts/${npId}`, { waitUntil: 'networkidle' });
      await broker.waitForURL(new RegExp(`/contracts/non-proportional/${npId}$`), { timeout: 10000 });
      await broker.goto(`${BASE}/placements/${propId}`, { waitUntil: 'networkidle' });
      await broker.waitForURL(new RegExp(`/contracts/proportional/${propId}$`), { timeout: 10000 });
    });

    await step('documents and shares (non-proportional): Save & next from the contract details, an upload, the shares, Save & done', async () => {
      await broker.goto(`${BASE}/contracts/non-proportional/${npId}`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('[data-testid=np-structure]');
      await wakeDock(broker);
      assert.ok(await broker.locator('[data-testid=wizard-next]:has-text("Save & next: Documents")').count() > 0);
      await broker.click('[data-testid=wizard-next]');
      await broker.waitForURL(new RegExp(`/contracts/non-proportional/${npId}/documents$`), { timeout: 20000 });
      await broker.waitForSelector('[data-testid=documents-count]:has-text("0 FILES")', { timeout: 10000 });
      const row = await uploadDocument(broker, `pack-${tag}.txt`, 'Renewal Pack', 'Renewal pack', 'Renewal pack 2027');
      assert.ok(await row.locator('.docs-type-pill:has-text("Renewal Pack")').count() > 0);
      assert.ok((await row.innerText()).includes('Renewal pack 2027'), 'the typed title');
      await broker.waitForSelector('[data-testid=documents-count]:has-text("1 FILE")');
      await wakeDock(broker);
      assert.ok(await broker.locator('[data-testid=wizard-back]:has-text("Back: Contract Details")').count() > 0);
      await broker.click('[data-testid=wizard-back]');
      await broker.waitForURL(new RegExp(`/contracts/non-proportional/${npId}$`), { timeout: 10000 });
      await broker.waitForSelector('[data-testid=np-structure]');
      // Next from the documents opens the shares; Save & done from there writes them and lands on the register.
      await broker.goto(`${BASE}/contracts/non-proportional/${npId}/documents`, { waitUntil: 'networkidle' });
      await broker.waitForSelector(`[data-testid=document-row]:has-text("pack-${tag}.txt")`, { timeout: 10000 });
      await wakeDock(broker);
      await broker.click('[data-testid=wizard-next]');
      await broker.waitForURL(new RegExp(`/contracts/non-proportional/${npId}/shares$`), { timeout: 10000 });
      await broker.waitForSelector('[data-testid=reinsurer-shares]', { timeout: 10000 });
      await broker.click('[data-testid=add-reinsurer]');
      const reRow = broker.locator('[data-testid=reinsurer-shares] [data-testid=share-row]').first();
      await reRow.locator('[aria-label="Reinsurer"]').fill('Hannover Re');
      await reRow.locator('[aria-label="Written share %"]').fill('100');
      await reRow.locator('[aria-label="Signed share %"]').fill('100');
      await wakeDock(broker);
      assert.ok(await broker.locator('[data-testid=wizard-next]:has-text("Save & done: Contracts")').count() > 0);
      await broker.click('[data-testid=wizard-next]');
      await broker.waitForURL(/\/contracts$/, { timeout: 10000 });
      const stored = await apiAs(broker, 'GET', `/placements/${npId}/shares`);
      assert.deepEqual(stored.reinsurers.map((s) => [s.name, s.role, s.written_pct, s.signed_pct]), [['Hannover Re', 'lead', 100, 100]]);
      assert.equal(stored.broker[0]?.name, 'Afro-Asian Insurance Services', 'this desk is the broker share by default');
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
