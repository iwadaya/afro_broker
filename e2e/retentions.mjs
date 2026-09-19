// Table of retentions: the class / % of capacity table (read by everyone,
// maintained by an admin), grading an occupancy into a class automatically,
// and the per-row suggestion chip.
import assert from 'node:assert/strict';
import { launch, login, makeStep, BASE } from './lib.mjs';

const card = (page) => page.locator('.np-struct-card:has-text("Table of Retentions")');
const rowsOf = (page) => card(page).locator('.np-struct-table tbody tr');

/** Open the wizard's retentions step. */
async function openRetentions(page) {
  await page.goto(`${BASE}/placements/new`, { waitUntil: 'networkidle' });
  await page.click('.wizard-tab:has-text("Retentions")');
  await page.waitForSelector('text=Table of Retentions');
}

/** Read a row as [class, category, pct, usable]. */
async function readRow(page, i) {
  const inputs = rowsOf(page).nth(i).locator('input');
  return Promise.all([0, 1, 2, 3].map((n) => inputs.nth(n).inputValue()));
}

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  console.log('retentions: class table, auto-detection, row suggestion');

  try {
    const broker = await login(browser, 'broker', errors);
    await step('open the table of retentions', async () => {
      await openRetentions(broker);
      assert.equal(await rowsOf(broker).count(), 6, 'six seeded occupancy categories');
      const [klass, category, pct] = await readRow(broker, 0);
      assert.equal(category, 'Dwellings');
      assert.equal(klass, 'A', 'seeded with a class');
      assert.equal(pct, '', 'but no share of capacity yet');
    });

    await step('the button opens the class / % of capacity table', async () => {
      assert.equal(await card(broker).locator('.ret-classes').count(), 0, 'hidden until asked for');
      await card(broker).locator('button:has-text("Class & % of capacity")').click();
      await broker.waitForSelector('.ret-classes');
      const classRows = card(broker).locator('.ret-classes tbody tr');
      assert.equal(await classRows.count(), 3);
      const text = await card(broker).locator('.ret-classes').innerText();
      for (const bit of ['A', '100%', 'B', '75%', 'C', '50%', 'Non-hazardous', 'Heavy / hazardous']) {
        assert.ok(text.includes(bit), `class table shows ${bit}`);
      }
      await card(broker).locator('button:has-text("Hide class table")').click();
      assert.equal(await card(broker).locator('.ret-classes').count(), 0);
    });

    await step('auto-detect gives every seeded occupancy its share of capacity', async () => {
      await card(broker).locator('button:has-text("Auto-detect classes")').click();
      await broker.waitForSelector('.np-struct-notice');
      const expected = [
        ['A', 'Dwellings', '100'], ['A', 'Offices & Retail', '100'],
        ['B', 'Warehousing', '75'], ['B', 'Light Industry', '75'],
        ['C', 'Heavy Industry', '50'], ['C', 'Hazardous Risks', '50'],
      ];
      for (const [i, [klass, category, pct]] of expected.entries()) {
        const row = await readRow(broker, i);
        assert.equal(row[0], klass, `${category} reads as class ${klass}`);
        assert.equal(row[1], category);
        assert.equal(row[2], `${pct}%`);
      }
      const notice = await card(broker).locator('.np-struct-notice').innerText();
      assert.match(notice, /Applied 6 of 6 occupancies/);
    });

    await step('the usable limit follows the detected share of capacity', async () => {
      await card(broker).locator('#ret-limit').fill('100000000');
      await broker.waitForTimeout(200);
      assert.equal((await readRow(broker, 0))[3], '100,000,000', 'class A uses the full limit');
      assert.equal((await readRow(broker, 4))[3], '50,000,000', 'class C is capped at 50%');
    });

    await step('a new occupancy is graded from its description, on the row', async () => {
      await card(broker).locator('button:has-text("Add category")').click();
      await broker.waitForTimeout(150);
      const newRow = rowsOf(broker).nth(6);
      await newRow.locator('input').nth(1).fill('Petrol filling station');
      await broker.waitForTimeout(200);
      const chip = newRow.locator('.ret-suggest');
      assert.equal(await chip.count(), 1, 'a suggestion is offered');
      assert.match(await chip.innerText(), /C/);
      await chip.click();
      await broker.waitForTimeout(200);
      const row = await readRow(broker, 6);
      assert.equal(row[0], 'C');
      assert.equal(row[2], '50%');
      assert.equal(await newRow.locator('.ret-suggest').count(), 0, 'chip clears once applied');
    });

    await step('an unrecognised occupancy is left alone, not guessed at', async () => {
      await card(broker).locator('button:has-text("Add category")').click();
      await broker.waitForTimeout(150);
      const newRow = rowsOf(broker).nth(7);
      await newRow.locator('input').nth(1).fill('Fish farm');
      await broker.waitForTimeout(200);
      assert.equal(await newRow.locator('.ret-suggest').count(), 0, 'no suggestion');
      await card(broker).locator('button:has-text("Auto-detect classes")').click();
      await broker.waitForTimeout(200);
      assert.equal((await readRow(broker, 7))[0], '', 'still unclassified');
      assert.match(await card(broker).locator('.np-struct-notice').innerText(), /No class could be detected/);
    });

    await step('re-detect all replaces a class that no longer fits', async () => {
      const heavy = rowsOf(broker).nth(4);
      await heavy.locator('input').nth(0).fill('A');
      await heavy.locator('input').nth(2).fill('90');
      await broker.waitForTimeout(150);
      await card(broker).locator('button:has-text("Re-detect all")').click();
      await broker.waitForTimeout(250);
      const row = await readRow(broker, 4);
      assert.equal(row[0], 'C', 'Heavy Industry is graded back to C');
      assert.equal(row[2], '50%');
    });
    await step('a broker cannot edit the class table', async () => {
      await card(broker).locator('button:has-text("Class & % of capacity")').click();
      await broker.waitForSelector('.ret-classes');
      assert.equal(await card(broker).locator('button:has-text("Edit class table")').count(), 0);
      await card(broker).locator('button:has-text("Hide class table")').click();
    });

    const admin = await login(browser, 'admin', errors);
    await step('an admin edits every column, adds a class and removes one', async () => {
      await openRetentions(admin);
      const panel = card(admin);
      await panel.locator('button:has-text("Class & % of capacity")').click();
      await admin.waitForSelector('.ret-classes');
      await panel.locator('button:has-text("Edit class table")').click();
      await admin.waitForTimeout(200);

      const classRow = (i) => panel.locator('.ret-classes tbody tr').nth(i);
      // Re-letter A, rename it, reword it, re-price it and re-term it.
      await classRow(0).locator('input').nth(0).fill('1');
      await classRow(0).locator('input').nth(1).fill('Simple risks');
      await classRow(0).locator('input').nth(2).fill('Offices and homes.');
      await classRow(0).locator('input').nth(3).fill('90');
      await classRow(0).locator('textarea').fill('office, dwelling, school');
      // Drop the middle class, then add a new one.
      await classRow(1).locator('button[aria-label^="Remove class"]').click();
      await admin.waitForTimeout(150);
      await panel.locator('button:has-text("Add class")').click();
      await admin.waitForTimeout(150);
      const added = panel.locator('.ret-classes tbody tr').last();
      await added.locator('input').nth(0).fill('9');
      await added.locator('input').nth(1).fill('Referral only');
      await added.locator('input').nth(3).fill('0');
      await added.locator('textarea').fill('abattoir, tannery');
      await panel.locator('button:has-text("Save class table")').click();
      await admin.waitForTimeout(600);

      assert.equal(await panel.locator('button:has-text("Edit class table")').count(), 1, 'back to reading');
      const text = await panel.locator('.ret-classes').innerText();
      assert.ok(text.includes('Simple risks') && text.includes('90%'), 'the edits show');
      assert.ok(text.includes('Referral only') && text.includes('0%'), 'the new class shows');
      assert.ok(!text.includes('Light hazard'), 'the removed class is gone');
    });

    await step('the saved table is what grading now uses, for everyone', async () => {
      await openRetentions(broker);
      const panel = card(broker);
      // "Dwellings" now grades to the re-lettered class 1 at 90%.
      await panel.locator('button:has-text("Auto-detect classes")').click();
      await broker.waitForTimeout(400);
      const first = await readRow(broker, 0);
      assert.equal(first[0], '1');
      assert.equal(first[2], '90%');
      // An occupancy only the new class knows.
      await panel.locator('button:has-text("Add category")').click();
      await broker.waitForTimeout(150);
      const fresh = panel.locator('.np-struct-table').last().locator('tbody tr').last();
      await fresh.locator('input').nth(1).fill('Tannery');
      await broker.waitForTimeout(250);
      const chip = fresh.locator('.ret-suggest');
      assert.equal(await chip.count(), 1, 'the added class grades it');
      assert.match(await chip.innerText(), /9/);
    });

    await step('the table is restored for the next run', async () => {
      await openRetentions(admin);
      const panel = card(admin);
      await panel.locator('button:has-text("Class & % of capacity")').click();
      await admin.waitForSelector('.ret-classes');
      await panel.locator('button:has-text("Edit class table")').click();
      await admin.waitForTimeout(200);
      const rows = panel.locator('.ret-classes tbody tr');
      const restore = [
        ['A', 'Non-hazardous', 'Simple, non-industrial occupancies with no process hazard.', '100',
          'dwelling, residential, apartment, flat, bungalow, office, offices and retail, retail, shop, school, college, university, church, mosque, bank, clinic, surgery, hostel, library, museum, government building'],
        ['B', 'Light hazard', 'Commercial, storage and light-industrial risks.', '75',
          'warehousing, warehouse, light industry, workshop, garage, hotel, guest house, lodge, hospital, supermarket, shopping mall, restaurant, bakery, laundry, cold store, cold storage, showroom, cinema, printing works, packaging, data centre, data center'],
        ['C', 'Heavy / hazardous', 'Heavy industry and highly combustible or flammable processes.', '50',
          'heavy industry, hazardous risk, hazardous, factory, manufacturing, mill, textile mill, flour mill, spinning mill, ginnery, foundry, steel, cement works, chemical, petrol, filling station, petrol filling station, fuel depot, refinery, sawmill, timber yard, foam, rubber, tyre, plastics, distillery, brewery, grain silo, explosives, fireworks, mining, quarry'],
      ];
      while (await rows.count() > restore.length) {
        await rows.last().locator('button[aria-label^="Remove class"]').click();
        await admin.waitForTimeout(120);
      }
      while (await rows.count() < restore.length) {
        await panel.locator('button:has-text("Add class")').click();
        await admin.waitForTimeout(120);
      }
      for (const [i, [code, name, description, pct, terms]] of restore.entries()) {
        await rows.nth(i).locator('input').nth(0).fill(code);
        await rows.nth(i).locator('input').nth(1).fill(name);
        await rows.nth(i).locator('input').nth(2).fill(description);
        await rows.nth(i).locator('input').nth(3).fill(pct);
        await rows.nth(i).locator('textarea').fill(terms);
      }
      await panel.locator('button:has-text("Save class table")').click();
      await admin.waitForTimeout(600);
      const text = await panel.locator('.ret-classes').innerText();
      assert.ok(text.includes('Non-hazardous') && text.includes('100%'));
      assert.ok(text.includes('Light hazard') && text.includes('75%'));
      assert.ok(text.includes('Heavy / hazardous') && text.includes('50%'));
    });

  } catch (e) {
    errors.push(`retentions spec crashed: ${e.message}`);
  } finally {
    await browser.close();
  }
  return errors;
}
