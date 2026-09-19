// Expiring structure & terms: the proportional / non-proportional selection
// must stay live everywhere the expiring structure is — a new placement's
// Expiring Structure tab (new business, and a renewal where the basis is
// auto-populated but not locked), a saved placement's — and the chosen basis
// must survive a save. /placements/new and /placements/:id are one screen.
import assert from 'node:assert/strict';
import { launch, login, makeStep, BASE } from './lib.mjs';

/** The expiring card: the structure card on the Expiring Structure tab. */
const expiringCard = (page) => page.locator('.np-struct-card').first();

/** The expiring basis pills: the tab's Basis row — the first pill group. */
const basisPills = (page) => page.locator('.np-type-pills').first();

/** The tabs carry a data-tab key — "Structure" is a substring of "Expiring
    Structure", so text matching no longer picks one out. */
async function openExpiring(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('.wizard-tab[data-tab=expiring]');
  await page.waitForSelector('text=Expiring Structure & Terms');
}
const openWizardExpiring = (page) => openExpiring(page, `${BASE}/placements/new`);

/** Click a basis pill and report what the expiring card switched to. */
async function pickBasis(card, label) {
  const page = card.page();
  const pill = basisPills(page).locator(`button:has-text("${label}")`).first();
  assert.equal(await pill.isDisabled(), false, `${label} pill must be clickable`);
  await pill.click();
  await page.waitForTimeout(250);
  return {
    selected: (await basisPills(page).locator('.np-type-pill.is-on').first().textContent()).trim(),
    // The 2 × 2 grid carries the active basis; 1 while proportional.
    terms: await card.locator('.exp-grid[data-basis=PROP]').count(),
    layerRows: await card.locator('.np-layer-table tbody tr, table tbody tr').count(),
  };
}

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  console.log('structures: expiring basis selection');

  try {
    const broker = await login(browser, 'broker', errors);

    await step('new business: expiring basis switches between prop and NP', async () => {
      await openWizardExpiring(broker);
      const card = expiringCard(broker);
      // Two bases only, one or the other.
      const labels = (await basisPills(broker).locator('button').allTextContents()).map((t) => t.trim());
      assert.deepEqual(labels, ['Proportional', 'Non-Proportional']);
      const prop = await pickBasis(card, 'Proportional');
      assert.equal(prop.selected, 'Proportional');
      assert.equal(prop.terms, 1, 'proportional activates the grid');
      assert.equal(await card.locator('.np-type-pills:not(.np-type-pills--mini)').count(), 0, 'the card header carries no second selector');
      // The 2 × 2 grid: three proportional cards first, the non-proportional
      // STRUCTURE card last; the other basis sits dimmed.
      const kinds = await card.locator('.exp-grid > .exp-card').evaluateAll((els) => els.map((e) => e.className.match(/exp-card--(\w+)/)[1]));
      assert.deepEqual(kinds, ['limits', 'commissions', 'lp', 'np']);
      assert.equal(await card.locator('.exp-grid > .exp-card.is-on').count(), 3, 'the proportional cards are active');
      assert.equal(await card.locator('.exp-card--np.is-off').count(), 1, 'the STRUCTURE card is dimmed');
      assert.equal(await card.locator('.exp-card--layers.is-off').count(), 1, 'the expiring layers are dimmed');
      const np = await pickBasis(card, 'Non-Proportional');
      assert.equal(np.selected, 'Non-Proportional');
      assert.equal(np.terms, 0, 'non-proportional deactivates the proportional cards');
      assert.equal(await card.locator('.exp-grid > .exp-card.is-off').count(), 3, 'the proportional cards are dimmed');
      assert.equal(await card.locator('.exp-card--np.is-on').count(), 1, 'the STRUCTURE card is active');
      assert.equal(await card.locator('table').count(), 2, 'the layer table and COB table are shown');
      // A click on a dimmed card switches the basis to it.
      await card.locator('.exp-card--limits').click({ position: { x: 20, y: 20 } });
      await broker.waitForTimeout(200);
      assert.equal((await basisPills(broker).locator('.np-type-pill.is-on').first().textContent()).trim(), 'Proportional',
        'clicking an inactive proportional card activates proportional');
    });

    await step('new business: the basis follows the treaty type until chosen by hand', async () => {
      const fr = (label) => broker.locator('.fr', { has: broker.locator('.fr-label', { hasText: label }) }).first();
      await broker.goto(`${BASE}/placements/new`, { waitUntil: 'networkidle' });
      await fr('Treaty Type').locator('select').selectOption({ label: 'Quota Share' });
      const detailProp = (await fr('Treaty Type').locator('select optgroup[label="Proportional"] option').allTextContents())
        .map((t) => t.trim());
      await broker.click('.wizard-tab[data-tab=expiring]');
      await broker.waitForSelector('text=Expiring Structure & Terms');
      let on = (await basisPills(broker).locator('.np-type-pill.is-on').first().textContent()).trim();
      assert.equal(on, 'Proportional', 'a Quota Share treaty defaults the expiring basis to proportional');
      assert.match(await broker.locator('.td-hint').first().innerText(), /Defaulted from the Quota Share treaty type/);
      // The LIMIT DETAILS card's treaty type offers the Treaty Detail's
      // proportional types, defaulted to the Treaty Detail's own.
      const propType = broker.locator('.exp-card--limits .fr', { has: broker.locator('.fr-label:text-is("Treaty Type")') })
        .locator('select');
      assert.equal(await propType.inputValue(), 'Quota Share', 'defaults to the Treaty Detail treaty type');
      const propOptions = (await propType.locator('option').allTextContents()).map((t) => t.trim()).filter((t) => !t.startsWith('Select'));
      assert.deepEqual([...propOptions].sort(), [...detailProp].sort(), 'the same proportional types as Treaty Detail');
      assert.ok(propOptions.includes('Fac Oblig') && !propOptions.includes('Risk XL'), 'proportional types only');
      // A surplus type switches the limit fields: the surplus half opens, the QS half closes.
      await propType.selectOption('First Surplus');
      const limitRow = (label) => broker.locator('.exp-card--limits .fr', { has: broker.locator(`.fr-label:text-is("${label}")`) }).locator('input');
      assert.equal(await limitRow('Number of Lines').isDisabled(), false, 'surplus lines open');
      assert.equal(await limitRow('Retention %').isDisabled(), true, 'the QS retention closes');
      await limitRow('Surplus Max Retention (USD)').fill('1000000');
      await limitRow('Number of Lines').fill('5');
      await limitRow('Number of Lines').press('Tab');
      assert.equal(await limitRow('Total Treaty Capacity').inputValue(), '6,000,000', 'capacity = max retention + max retention × lines');
      await propType.selectOption('Quota Share');

      // Structure 1 to quote, proportional, offers the same list.
      await broker.click('.wizard-tab[data-tab=structure]');
      await broker.waitForSelector('text=Structures to Quote');
      const s1prop = broker.locator('.np-struct-card').filter({ has: broker.locator('.qss-header', { hasText: 'Structure 1' }) }).first();
      await s1prop.locator('.np-type-pill', { hasText: /^Proportional$/ }).click();
      const qType = s1prop.locator('.np-term-label:text-is("Treaty Type")').locator('..').locator('select');
      assert.equal(await qType.inputValue(), 'Quota Share', 'structure 1 defaults to the Treaty Detail treaty type');
      const qOptions = (await qType.locator('option').allTextContents()).map((t) => t.trim()).filter((t) => !t.startsWith('Select'));
      assert.deepEqual([...qOptions].sort(), [...detailProp].sort(), 'the same proportional types on a structure to quote');

      await broker.click('.wizard-tab[data-tab=detail]');
      await fr('Treaty Type').locator('select').selectOption({ label: 'Risk XL' });
      // Read while on Treaty Detail — the expiring tab has Treaty Type rows of its own.
      const detailNp = (await fr('Treaty Type').locator('select optgroup[label="Non-proportional"] option').allTextContents())
        .map((t) => t.trim());
      await broker.click('.wizard-tab[data-tab=expiring]');
      on = (await basisPills(broker).locator('.np-type-pill.is-on').first().textContent()).trim();
      assert.equal(on, 'Non-Proportional', 'a Risk XL treaty defaults it to non-proportional');
      // The STRUCTURE card's treaty type offers the Treaty Detail's
      // non-proportional types, defaulted to the Treaty Detail's own.
      const npType = broker.locator('.exp-card--np .fr', { has: broker.locator('.fr-label:text-is("Treaty Type")') })
        .locator('select');
      assert.equal(await npType.inputValue(), 'Risk XL', 'defaults to the Treaty Detail treaty type');
      const npOptions = (await npType.locator('option').allTextContents()).map((t) => t.trim()).filter((t) => !t.startsWith('Select'));
      assert.ok(detailNp.length >= 4, 'Treaty Detail offers the non-proportional types');
      assert.deepEqual([...npOptions].sort(), [...detailNp].sort(), 'the same non-proportional types as Treaty Detail');
      assert.ok(!npOptions.includes('Quota Share'), 'no proportional type is offered');
      await npType.selectOption('Stop Loss');
      assert.equal(await npType.inputValue(), 'Stop Loss', 'a picked type sticks');

      // Picked by hand, the basis stops tracking the treaty type.
      await pickBasis(expiringCard(broker), 'Proportional');
      await broker.click('.wizard-tab[data-tab=detail]');
      await fr('Treaty Type').locator('select').selectOption({ label: 'CAT XL' });
      await broker.click('.wizard-tab[data-tab=expiring]');
      on = (await basisPills(broker).locator('.np-type-pill.is-on').first().textContent()).trim();
      assert.equal(on, 'Proportional', 'a hand-picked basis survives a treaty type change');
    });

    await step('a saved placement carries the same screen: its own Expiring Structure tab', async () => {
      await broker.goto(`${BASE}/placements`, { waitUntil: 'networkidle' });
      await broker.locator('table tbody tr a').first().click();
      await broker.waitForSelector('.wizard-tab[data-tab=expiring]');
      // The full section rail, on a new and a saved placement alike.
      // A tab reads "32 Quoting Stage", plus a lock glyph while the pack is unapproved.
      const tabs = (await broker.locator('.wizard-tab').allInnerTexts()).map((t) => t.replace(/^\d+\s*/, '').replace(/🔒/g, '').trim());
      for (const label of ['Treaty Detail', 'Expiring Structure', 'Quote Structure', 'Retentions', 'Data', 'Renewal Pack', 'Pack Approval', 'Quoting Stage', 'Final Quote', 'Final Placement']) {
        assert.ok(tabs.includes(label), `${label} tab on a saved placement`);
      }
      assert.ok(tabs.length > 7, 'the modelling screens sit between Retentions and Data');
      await broker.click('.wizard-tab[data-tab=expiring]');
      await broker.waitForSelector('text=Expiring Structure & Terms');
      const labels = (await basisPills(broker).locator('button').allTextContents()).map((t) => t.trim());
      assert.deepEqual(labels, ['Proportional', 'Non-Proportional']);
      const prop = await pickBasis(expiringCard(broker), 'Proportional');
      assert.equal(prop.selected, 'Proportional');
      assert.equal(prop.terms, 1, 'the proportional terms grid is shown');
    });

    await step('a new placement carries the full section rail, not a shorter one', async () => {
      await broker.goto(`${BASE}/placements/new`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('.wizard-tab[data-tab=expiring]');
      const tabs = (await broker.locator('.wizard-tab').allInnerTexts()).map((t) => t.replace(/^\d+\s*/, '').trim());
      for (const label of ['Treaty Detail', 'Expiring Structure', 'Quote Structure', 'Retentions', 'Data', 'Renewal Pack', 'Pack Approval', 'Quoting Stage', 'Final Quote', 'Final Placement']) {
        assert.ok(tabs.includes(label), `${label} tab on a new placement`);
      }
      assert.ok(tabs.length > 7, 'the modelling screens are on the rail before creation');
      // A section that needs the placement to exist says so instead of failing.
      await broker.click('.wizard-tab[data-tab=pack]');
      await broker.waitForSelector('text=CREATE THE PLACEMENT FIRST');
      assert.equal(await broker.locator('button:has-text("Create Placement")').isDisabled(), true,
        'Create Placement waits for the treaty detail');
    });

    await step('renewal: an auto-populated expiring structure stays editable', async () => {
      await broker.goto(`${BASE}/placements/new`, { waitUntil: 'networkidle' });
      const sourceSel = broker.locator('.fr', { has: broker.locator('.fr-label', { hasText: 'Renewal of' }) })
        .first().locator('select');
      await sourceSel.waitFor();
      await sourceSel.locator('option').nth(1).waitFor({ state: 'attached' });
      const options = await sourceSel.locator('option').allTextContents();
      assert.ok(options.length > 1, 'a source placement must exist to renew from');
      await sourceSel.selectOption({ index: 1 });
      await broker.waitForTimeout(800);
      await broker.click('.wizard-tab[data-tab=expiring]');
      await broker.waitForSelector('text=Expiring Structure & Terms');
      const card = expiringCard(broker);
      const prop = await pickBasis(card, 'Proportional');
      assert.equal(prop.selected, 'Proportional');
      assert.equal(prop.terms, 1, 'the loaded expiring structure can still be switched');
    });

    await step('non-proportional layer terms survive placement creation', async () => {
      const fr = (label) => broker.locator('.fr', { has: broker.locator('.fr-label', { hasText: label }) }).first();
      await broker.goto(`${BASE}/placements/new`, { waitUntil: 'networkidle' });
      await fr('Country').locator('select').selectOption({ label: 'United Kingdom' });
      await fr('Cedant Name').locator('select').selectOption({ index: 1 });
      await fr('Treaty Type').locator('select').selectOption({ label: 'Risk XL' });
      await broker.click('.cob-trigger');
      await broker.click('.cob-item:has-text("Property")');
      await broker.click('button:has-text("Done")');
      await fr('Treaty Inception Date').locator('input').fill('2026-04-01');
      await broker.click('.wizard-tab[data-tab=structure]');
      await broker.waitForSelector('text=Structures to Quote');
      assert.equal(await broker.locator('text=Expiring Structure & Terms').count(), 0,
        'the expiring structure has its own tab now');

      // The structure's own section — by its header, since the count row's
      // "Copy expiring → structure 1" button would match on text.
      const structure1 = broker.locator('.np-struct-card')
        .filter({ has: broker.locator('.qss-header', { hasText: 'Structure 1' }) }).first();
      const row = structure1.locator('tbody tr').first();
      const cell = (col) => row.locator(`[data-col=${col}]`);
      await cell('name').fill('Layer 1 xs');
      // A layer can be restricted to a geographic region (worldwide otherwise).
      await cell('region').selectOption('GCC');
      await cell('limit').fill('10000000');
      await cell('attachment').fill('5000000');
      await cell('reinstatements').selectOption('UNLIMITED');
      await cell('reinstatementPct').fill('125');
      await cell('egnpi').fill('40000000');
      await cell('rate').fill('3.75');
      await cell('aad').fill('250000');
      await cell('premium').fill('1500000');

      const headers = (await structure1.locator('thead th').allTextContents()).map((h) => h.trim());
      for (const col of ['REINSTATEMENTS', 'REINST. %', 'RATE %']) {
        assert.ok(headers.includes(col), `${col} column is present`);
      }
      assert.ok(headers.some((h) => h.startsWith('EGNPI')), 'EGNPI column is present');
      assert.ok(headers.some((h) => h.startsWith('AAD')), 'AAD column is present');
      // Values read back grouped, with a % on the rate columns.
      await broker.locator('body').click({ position: { x: 5, y: 5 } });
      assert.equal(await cell('limit').inputValue(), '10,000,000');
      assert.equal(await cell('egnpi').inputValue(), '40,000,000');
      assert.equal(await cell('rate').inputValue(), '3.75%');
      assert.equal(await cell('reinstatementPct').inputValue(), '125%');
      assert.equal(await cell('order').inputValue(), '100%');
      // Editing keeps the grouped form: a separator typed by hand is dropped
      // rather than corrupting the value.
      await cell('limit').click();
      await broker.keyboard.press('End');
      await broker.keyboard.type('0');
      assert.equal(await cell('limit').inputValue(), '100,000,000');
      await broker.keyboard.press('Backspace');
      assert.equal(await cell('limit').inputValue(), '10,000,000');
      await broker.locator('body').click({ position: { x: 5, y: 5 } });

      const options = await row.locator('select').nth(1).locator('option').allTextContents();
      assert.deepEqual(
        options.map((o) => o.trim()),
        ['—', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Unlimited'],
      );

      await broker.click('button:has-text("Create Placement")');
      await broker.waitForURL(/\/placements\/[0-9a-f-]{36}$/, { timeout: 30000 });
      const url = broker.url();
      await broker.goto(url, { waitUntil: 'networkidle' });
      await broker.click('.wizard-tab[data-tab=structure]');
      await broker.waitForSelector('text=Structures to Quote');
      const saved = broker.locator('.np-struct-card')
        .filter({ has: broker.locator('.qss-header', { hasText: 'Structure 1' }) }).first()
        .locator('tbody tr').first();
      const savedCell = (col) => saved.locator(`[data-col=${col}]`);
      assert.equal(await savedCell('reinstatements').inputValue(), 'UNLIMITED');
      assert.equal(await savedCell('region').inputValue(), 'GCC', 'the region survives creation');
      // Values render grouped (and percentages carry a %), so compare numbers.
      for (const [col, want] of Object.entries({
        limit: 10_000_000, attachment: 5_000_000, reinstatementPct: 125,
        egnpi: 40_000_000, rate: 3.75, aad: 250_000, premium: 1_500_000,
      })) {
        const shown = await savedCell(col).inputValue();
        assert.equal(Number(shown.replace(/[^0-9.]/g, '')), want, `${col} survived creation (shown "${shown}")`);
      }
    });

    await step('placement page: the chosen basis is saved', async () => {
      await broker.goto(`${BASE}/placements`, { waitUntil: 'networkidle' });
      await broker.locator('table tbody tr a').first().click();
      await broker.waitForSelector('.wizard-tab[data-tab=expiring]');
      await broker.click('.wizard-tab[data-tab=expiring]');
      await broker.waitForSelector('text=Expiring Structure & Terms');
      const url = broker.url();
      const before = await pickBasis(expiringCard(broker), 'Proportional');
      assert.equal(before.selected, 'Proportional');
      await broker.click('button:has-text("Save expiring structure")');
      await broker.waitForTimeout(1200);
      await broker.goto(url, { waitUntil: 'networkidle' });
      await broker.click('.wizard-tab[data-tab=expiring]');
      await broker.waitForSelector('text=Expiring Structure & Terms');
      const after = (await basisPills(broker).locator('.np-type-pill.is-on').first().textContent()).trim();
      assert.equal(after, 'Proportional', 'the expiring basis survives a reload');
    });

    await step('non-proportional: stop loss goes on a loss-ratio basis, participation follows the underwriting limit', async () => {
      const fr = (label) => broker.locator('.fr', { has: broker.locator('.fr-label', { hasText: label }) }).first();
      await broker.goto(`${BASE}/placements/new`, { waitUntil: 'networkidle' });
      await fr('Country').locator('select').selectOption({ label: 'United Kingdom' });
      await fr('Cedant Name').locator('select').selectOption({ index: 1 });
      await fr('Treaty Type').locator('select').selectOption({ label: 'Stop Loss' });
      await broker.click('.cob-trigger');
      await broker.click('.cob-item:has-text("Property")');
      await broker.click('button:has-text("Done")');
      await fr('Treaty Inception Date').locator('input').fill('2026-04-01');

      // Expiring: the STRUCTURE card's treaty type is Stop Loss, so the layers
      // card is the loss-ratio table and there is no per-class participation.
      await broker.click('.wizard-tab[data-tab=expiring]');
      await broker.waitForSelector('.exp-card--layers');
      const layersCard = broker.locator('.exp-card--layers');
      assert.match(await layersCard.innerText(), /EXPIRING STOP LOSS/);
      await layersCard.locator('button:has-text("Add layer")').click();
      const heads = (await layersCard.locator('thead th').allTextContents()).map((h) => h.trim());
      for (const h of ['ATTACH LR %', 'LIMIT LR %', 'RATE %', 'ROL %', 'RESOLVED · LIMIT', 'RESOLVED · ATTACH']) {
        assert.ok(heads.includes(h), `${h} column`);
      }
      assert.equal(await expiringCard(broker).locator('.np-struct-sub-h:has-text("Classes of Business")').count(), 0,
        'a stop loss has no per-class participation');
      const row = layersCard.locator('tbody tr').first();
      const cell = (col) => row.locator(`[data-col=${col}]`);
      await cell('attachLrPct').fill('80');
      await cell('limitLrPct').fill('120');
      await cell('egnpi').fill('10000000');
      await cell('rate').fill('5');
      // Blur with Tab — a click at the page's top-left lands on the top bar.
      await cell('rate').press('Tab');
      assert.equal(await cell('resolvedLimit').inputValue(), '12,000,000', 'limit = EPI × limit LR');
      assert.equal(await cell('resolvedAttachment').inputValue(), '8,000,000', 'attachment = EPI × attach LR');
      assert.equal(await cell('rolPct').getAttribute('placeholder'), '4.17%', 'ROL = rate ÷ limit LR');
      assert.equal(await cell('premium').getAttribute('placeholder'), '500,000', 'premium = EPI × rate');

      // Quote structure 1 follows the Treaty Detail's Stop Loss too.
      await broker.click('.wizard-tab[data-tab=structure]');
      await broker.waitForSelector('text=Structures to Quote');
      const s1 = broker.locator('.np-struct-card').filter({ has: broker.locator('.qss-header', { hasText: 'Structure 1' }) }).first();
      assert.ok((await s1.locator('thead th').allTextContents()).some((h) => h.trim() === 'LIMIT LR %'), 'stop loss table on structure 1');
      assert.equal(await s1.locator('.np-struct-sub-h:has-text("Classes of Business")').count(), 0);

      // Back to a Risk XL: the standard table, and a class participates in a
      // layer only while its underwriting limit exceeds the layer attachment.
      await broker.click('.wizard-tab[data-tab=detail]');
      await fr('Treaty Type').locator('select').selectOption({ label: 'Risk XL' });
      await broker.click('.wizard-tab[data-tab=structure]');
      await broker.waitForSelector('text=Structures to Quote');
      const s1x = broker.locator('.np-struct-card').filter({ has: broker.locator('.qss-header', { hasText: 'Structure 1' }) }).first();
      // Each non-proportional structure picks its own type from the Treaty
      // Detail's non-proportional types and renders as the tool does.
      const npSel = s1x.locator('select.qss-np-type');
      assert.equal(await npSel.inputValue(), 'Stop Loss', 'structure 1 kept the type it was defaulted to');
      const npOpts = (await npSel.locator('option').allTextContents()).map((t) => t.trim()).filter((t) => !t.startsWith('Select'));
      assert.ok(['Risk XL', 'CAT XL', 'Risk & CAT XL', 'Stop Loss', 'Aggregate XL'].every((t) => npOpts.includes(t)), 'the non-proportional types');
      assert.ok(!npOpts.includes('Quota Share'), 'no proportional type');
      await npSel.selectOption('Aggregate XL');
      assert.ok((await s1x.locator('thead th').allTextContents()).some((h) => h.trim().startsWith('AGGREGATE LIMIT')), 'aggregate XL table');
      assert.equal(await s1x.locator('[data-col=franchiseDeductible]').count(), 1, 'the policy-shape toggles');
      assert.ok((await s1x.locator('.np-struct-sub-h').allTextContents()).some((h) => /Inner Limits/.test(h)), 'inner limits per class');
      assert.equal(await s1x.locator('.np-struct-sub-h:has-text("Layer Participation")').count(), 0, 'no participation on an aggregate XL');
      await npSel.selectOption('CAT XL');
      assert.equal(await s1x.locator('tbody [data-col=risk]').first().isDisabled(), true, 'CAT XL locks the covers');
      assert.equal(await s1x.locator('tbody [data-col=risk]').first().isChecked(), false, 'CAT XL: risk off');
      assert.equal(await s1x.locator('tbody [data-col=cat]').first().isChecked(), true, 'CAT XL: cat on');
      await npSel.selectOption('Risk & CAT XL');
      assert.equal(await s1x.locator('tbody [data-col=risk]').first().isDisabled(), false, 'Risk & CAT XL frees the covers');
      await npSel.selectOption('Risk XL');
      assert.equal(await s1x.locator('tbody [data-col=risk]').first().isChecked(), true, 'Risk XL: risk on');
      assert.equal(await s1x.locator('tbody [data-col=cat]').first().isChecked(), false, 'Risk XL: cat off');
      assert.equal(await s1x.locator('tbody [data-col=cat]').first().isDisabled(), true, 'Risk XL locks the covers');
      await s1x.locator('tbody [data-col=attachment]').first().fill('5000000');
      const cobRow = s1x.locator('.np-struct-sub tbody tr').first();
      assert.match(await cobRow.innerText(), /Property/);
      const tick = cobRow.locator('input[type=checkbox]').first();
      const limit = cobRow.locator('input').first();
      await limit.fill('4000000');
      assert.equal(await tick.isChecked(), false, 'a limit below the attachment cannot reach the layer');
      await limit.fill('6000000');
      assert.equal(await tick.isChecked(), true, 'a limit above the attachment participates');
      await s1x.locator('tbody [data-col=attachment]').first().fill('7000000');
      assert.equal(await tick.isChecked(), false, 'a raised attachment drops the class again');
      await tick.click();
      assert.equal(await tick.isChecked(), true, 'ticked by hand');
      await limit.fill('1000000');
      assert.equal(await tick.isChecked(), true, 'a hand-ticked cell is left alone by the rule');
    });

    await step("proportional terms carry the modelling tool's detail sections", async () => {
      // A fresh placement through the API so the class list is known.
      const pid = await broker.evaluate(async () => {
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
        const cedant = await call('POST', '/cedants', { name: `Terms Cedant ${Date.now()}`, domicile: 'UK' });
        const p = await call('POST', '/placements', {
          cedant_id: cedant.id, class: 'Property QS', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD',
        });
        return p.id;
      });
      await openExpiring(broker, `${BASE}/placements/${pid}`);
      const card = expiringCard(broker);
      await pickBasis(card, 'Proportional');

      // The cards are there, in the tool's order, with EPI and brokerage
      // inside LOSS PARTICIPATION.
      for (const title of ['LIMIT DETAILS', 'COMMISSIONS', 'LOSS PARTICIPATION', 'STRUCTURE']) {
        assert.ok(await card.locator(`.exp-card .td-card-label:has-text("${title}")`).count(), `${title} card`);
      }
      for (const title of ['EPI', 'BROKERAGE & TAXES']) {
        assert.ok(await card.locator(`.exp-card--lp .exp-sub:has-text("${title}")`).count(), `${title} section`);
      }
      const rowInput = (cardSel, label) => card.locator(cardSel)
        .locator('.fr', { has: broker.locator(`.fr-label:text-is("${label}")`) })
        .locator('input');

      // Sliding scale: switch the mode, set the corridor, enter the slide.
      await card.locator('button:has-text("SLIDING SCALE")').click();
      const term = (label) => rowInput('.exp-card--commissions', label);
      await term('Min Loss Ratio %').fill('40');
      await term('Max Loss Ratio %').fill('80');
      await term('Min Commission %').fill('20');
      await term('Max Commission %').fill('35');
      await card.locator('button:has-text("Enter slide manually")').click();
      const slide = broker.locator('.mod-modal');
      await slide.locator('input').first().fill('30'); // provisional
      const slideRows = slide.locator('tbody tr');
      await slideRows.nth(0).locator('input').nth(0).fill('65');
      await slideRows.nth(0).locator('input').nth(1).fill('30');
      await slideRows.nth(1).locator('input').nth(0).fill('80');
      await slideRows.nth(1).locator('input').nth(1).fill('20');
      await slide.locator('button:has-text("Save table")').click();
      await broker.waitForSelector('text=2 row(s)');

      // Loss participation corridor plus a stepped slide.
      const lpTerm = (label) => rowInput('.exp-card--lp', label);
      await lpTerm('Min Loss Ratio %').fill('70');
      await lpTerm('Max Loss Ratio %').fill('100');
      await lpTerm('Reinsurer Share %').fill('50');
      await card.locator('button:has-text("Enter slides manually")').click();
      const lp = broker.locator('.mod-modal');
      const lpRow = lp.locator('tbody tr').first();
      await lpRow.locator('input').nth(0).fill('70');
      await lpRow.locator('input').nth(1).fill('100');
      await lpRow.locator('input').nth(2).fill('50');
      await lp.locator('button:has-text("Save corridors")').click();
      await broker.waitForSelector('text=✓ 1 corridor(s)');

      // EPI and its split by class — one class, so the equal share is the lot.
      const epiTerm = (label) => rowInput('.exp-card--lp', label);
      await epiTerm('Quota Share EPI (USD)').fill('10000000');
      await card.locator('button:has-text("EPI Split")').click();
      const epi = broker.locator('.mod-modal');
      assert.match(await epi.innerText(), /Property/, 'the placement class heads the split');
      assert.match(await epi.innerText(), /10,000,000/, 'the equal-share default fills the class');
      assert.match(await epi.innerText(), /100\.0%/, 'the split adds back to the EPI total');
      await epi.locator('button:has-text("Save split")').click();
      await broker.waitForSelector('text=1 class(es)');

      // Save, reload, and everything reads back.
      await broker.click('button:has-text("Save expiring structure")');
      await broker.waitForTimeout(1000);
      await openExpiring(broker, `${BASE}/placements/${pid}`);
      const saved = expiringCard(broker);
      assert.equal((await saved.locator('.np-type-pill.is-on', { hasText: 'SLIDING SCALE' }).count()), 1,
        'the commission mode survives');
      const text = await saved.innerText();
      assert.ok(text.includes('2 row(s)'), 'the sliding table survives');
      assert.ok(text.includes('1 corridor(s)'), 'the LP slides survive');
      assert.ok(text.includes('1 class(es)'), 'the EPI split survives');
      await saved.locator('button:has-text("EPI Split")').click();
      assert.match(await broker.locator('.mod-modal').innerText(), /10,000,000/, 'the split premium reads back');
      await broker.locator('.mod-modal button:has-text("Cancel")').click();
    });
  } finally {
    await browser.close();
  }
  return errors;
}
