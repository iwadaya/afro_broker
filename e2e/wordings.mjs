// Wording library: browse the library by class and category, build a draft
// wording from a reinsurer's house wording, amend and revert a clause, and
// compare two wordings clause by clause.
import assert from 'node:assert/strict';
import { launch, login, makeStep, BASE } from './lib.mjs';

/**
 * Select the first option whose visible text starts with `prefix`. Option
 * values here are ids or bare codes while the labels carry live counts
 * ("Swiss Re (7)"), so neither an exact value nor an exact label is stable.
 */
async function selectByPrefix(select, prefix) {
  const value = await select.locator('option').evaluateAll(
    (opts, p) => opts.find((o) => o.textContent.trim().startsWith(p))?.value,
    prefix,
  );
  assert.ok(value !== undefined, `no option starting with "${prefix}"`);
  await select.selectOption(value);
}

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `wording-${Date.now()}`;
  console.log('wordings: library / draft builder / comparison');

  try {
    const broker = await login(browser, 'broker', errors);
    const uw = await login(browser, 'uw', errors);

    await step('library opens and is stocked', async () => {
      // The drafts editor has no tile of its own (it lives inside Wording), so the
      // spec reaches it by URL, as a library "Open the drafts editor" click would.
      await broker.goto(`${BASE}/wordings`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('h1:has-text("Wording library")');
      await broker.waitForSelector('.wl-group-head:has-text("Standard coverages")');
      await broker.waitForSelector('.wl-group-head:has-text("Extensions")');
      await broker.waitForSelector('.wl-group-head:has-text("Market exclusions")');
      const count = await broker.locator('.wl-item').count();
      assert.ok(count > 20, `expected a stocked library, saw ${count} clauses`);
    });

    await step('filtering by class narrows the library', async () => {
      const before = await broker.locator('.wl-item').count();
      await broker.locator('.wl-filters .field:has(span:text-is("Class of business")) select').selectOption('Marine');
      await broker.waitForTimeout(600);
      const after = await broker.locator('.wl-item').count();
      assert.ok(after < before, `class filter should narrow the list (${before} → ${after})`);
      await broker.waitForSelector('.wl-item:has-text("Marine Cargo")');
    });

    await step('a clause opens with its text and provenance', async () => {
      await broker.click('.wl-item:has-text("Marine Cargo")');
      await broker.waitForSelector('.wl-detail h3:has-text("Marine Cargo")');
      const body = await broker.locator('.wl-detail .wl-body').first().innerText();
      assert.ok(body.length > 120, 'the clause text is shown in full');
      await broker.waitForSelector('.wl-detail .status:has-text("Standard")');
    });

    await step('a reinsurer house wording is labelled with its market', async () => {
      await broker.locator('.wl-filters .field:has(span:text-is("Class of business")) select').selectOption('');
      await broker.locator('.wl-filters .field:has(span:text-is("Source")) select').selectOption('market');
      await selectByPrefix(broker.locator('.wl-filters .field:has(span:text-is("Reinsurer")) select'), 'Swiss Re');
      await broker.waitForTimeout(600);
      const items = await broker.locator('.wl-item').count();
      assert.ok(items > 0, 'Swiss Re has house clauses');
      await broker.waitForSelector('.wl-item .status:has-text("Swiss Re")');
    });

    await step('authentic market forms are badged with their reference and source', async () => {
      await broker.goto(`${BASE}/wordings`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('.wl-item');
      await broker.locator('.wl-filters .field:has(span:text-is("Provenance")) select').selectOption('market_standard');
      await broker.waitForTimeout(700);
      const forms = await broker.locator('.wl-item').count();
      assert.ok(forms >= 10, `expected the published market forms, saw ${forms}`);

      // The Lloyd's war exclusion, by its market reference.
      await broker.click('.wl-item:has-text("War and Civil War Exclusion")');
      await broker.waitForSelector('.wl-detail .status:has-text("Market standard")');
      await broker.waitForSelector('.wl-detail .status:has-text("NMA 464")');
      const body = await broker.locator('.wl-detail .wl-body').first().innerText();
      assert.match(body, /Notwithstanding anything to the contrary contained herein/);

      // Provenance panel names the publisher and links to the source.
      const source = broker.locator('.wl-source--std');
      await source.waitFor();
      assert.match(await source.innerText(), /Lloyd's Market Association/);
      assert.ok(await source.locator('a[href^="https://"]').count() > 0, 'source is linked');

      // Illustrative clauses are badged differently, not silently mixed in.
      await broker.locator('.wl-filters .field:has(span:text-is("Provenance")) select').selectOption('illustrative');
      await broker.waitForTimeout(700);
      await broker.click('.wl-item >> nth=0');
      await broker.waitForSelector('.wl-detail .status:has-text("Illustrative")');
    });

    let draftUrl;
    await step('a draft wording is built from a reinsurer over the standard set', async () => {
      await broker.click('.wl-tab:has-text("Drafts")');
      await broker.waitForSelector('text=New draft wording');
      await broker.click('button:has-text("Start a draft")');
      await broker.waitForSelector('input[placeholder^="Acme Insurance"]');
      await broker.fill('input[placeholder^="Acme Insurance"]', `Draft ${tag}`);
      await broker.locator('.wl-form .field:has(span:text-is("Class of business")) select').selectOption('Property');
      await selectByPrefix(broker.locator('.wl-form .field:has(span:text-is("Build on")) select'), 'Swiss Re');
      await broker.click('button:has-text("Create draft")');
      await broker.waitForSelector(`h1:has-text("Draft ${tag}")`, { timeout: 15000 });
      draftUrl = broker.url();

      const clauses = await broker.locator('.wl-clause').count();
      assert.ok(clauses > 20, `draft seeded from the library, saw ${clauses} clauses`);
      // Swiss Re's Debris Removal replaced the standard one — once, not twice.
      const debris = broker.locator('.wl-clause:has(.wl-clause-title:text-is("Debris Removal"))');
      assert.equal(await debris.count(), 1, 'the house clause replaced the standard one');
      await debris.locator('.status:has-text("Swiss Re")').first().waitFor();
    });

    await step('amending a clause flags it, and reverting puts it back', async () => {
      const clause = broker.locator('.wl-clause:has(.wl-clause-title:text-is("Debris Removal"))');
      const box = clause.locator('textarea');
      const original = await box.inputValue();
      await box.fill('Debris removal is sub-limited to 25% of the sum insured on the damaged property.');
      await clause.locator('button:has-text("Save clause")').click();
      await broker.waitForSelector('.wl-clause:has(.wl-clause-title:text-is("Debris Removal")) .status:has-text("Amended")', { timeout: 10000 });
      await broker.waitForSelector('h1 + p:has-text("1 amended")');

      // The disclosure shows what moved away from the library.
      await clause.locator('summary:has-text("What changed")').click();
      await clause.locator('.wl-del').first().waitFor();
      await clause.locator('.wl-ins').first().waitFor();

      await clause.locator('button:has-text("Revert")').click();
      await broker.waitForTimeout(900);
      assert.equal(
        await broker.locator('.wl-clause:has(.wl-clause-title:text-is("Debris Removal")) .status:has-text("Amended")').count(),
        0, 'the amended flag clears on revert',
      );
      assert.equal(await broker.locator('.wl-clause:has(.wl-clause-title:text-is("Debris Removal")) textarea').inputValue(), original);
    });

    await step('the library is untouched by draft edits', async () => {
      const page = await broker.context().newPage();
      await page.goto(draftUrl.replace(/\/wordings\/drafts\/.*/, '/wordings'));
      await page.waitForSelector('h1:has-text("Wording library")');
      await page.fill('.wl-filters input', 'Debris Removal');
      await page.waitForTimeout(700);
      await page.click('.wl-item:has-text("Debris Removal")');
      const body = await page.locator('.wl-detail .wl-body').first().innerText();
      assert.ok(!body.includes('25%'), 'the library clause never took the draft amendment');
      await page.close();
    });

    await step('a bespoke clause can be added and removed', async () => {
      await broker.goto(draftUrl, { waitUntil: 'networkidle' });
      const before = await broker.locator('.wl-clause').count();
      await broker.click('button:has-text("+ Add clause")');
      await broker.click('button:has-text("Bespoke clause")');
      await broker.locator('.wl-form .field:has(span:text-is("Title *")) input').fill('Aggregate Deductible');
      await broker.locator('.wl-form textarea').fill('An annual aggregate deductible of USD 5,000,000 applies to this Agreement.');
      await broker.click('button:has-text("Add to draft")');
      await broker.waitForSelector('.wl-clause .status:has-text("Bespoke")', { timeout: 10000 });
      assert.equal(await broker.locator('.wl-clause').count(), before + 1);

      const bespoke = broker.locator('.wl-clause:has(.wl-clause-title:text-is("Aggregate Deductible"))');
      await bespoke.locator('button:has-text("Remove")').click();
      await broker.waitForTimeout(900);
      assert.equal(await broker.locator('.wl-clause').count(), before);
    });

    await step('the draft renders as an assembled wording document', async () => {
      await broker.click('.wl-tab:has-text("Document")');
      await broker.waitForSelector('.wl-doc-title');
      await broker.waitForSelector('.wl-doc-h:has-text("Standard coverages")');
      await broker.waitForSelector('.wl-doc-h:has-text("Market exclusions")');
      const clauses = await broker.locator('.wl-doc-clause').count();
      assert.ok(clauses > 20, 'the whole wording is laid out to read');
    });

    await step('standard vs a reinsurer names the clauses they reworded', async () => {
      await broker.goto(draftUrl.replace(/\/wordings\/drafts\/.*/, '/wordings?tab=compare'), { waitUntil: 'networkidle' });
      await broker.waitForSelector('text=Compare wordings');
      const left = broker.locator('.wl-side').first();
      const right = broker.locator('.wl-side').last();
      await left.locator('.field:has(span:text-is("Compare")) select').selectOption('standard');
      await left.locator('.field:has(span:text-is("Class of business")) select').selectOption('Property');
      await right.locator('.field:has(span:text-is("Compare")) select').selectOption('market');
      await selectByPrefix(right.locator('.field:has(span:text-is("Reinsurer")) select'), 'Swiss Re');
      await right.locator('.field:has(span:text-is("Class of business")) select').selectOption('Property');
      await broker.click('section.card:has(.wl-compare-picker) button:has-text("Compare")');
      await broker.waitForSelector('.wl-summary-row', { timeout: 15000 });

      const match = await broker.locator('.wl-stat:has-text("MATCH") .stat-value').innerText();
      assert.ok(parseFloat(match) > 50 && parseFloat(match) < 100, `expected a partial match, got ${match}`);
      const reworded = Number(await broker.locator('.wl-stat:has-text("REWORDED") .stat-value').innerText());
      assert.ok(reworded > 0, 'Swiss Re deviates on some clauses');

      // Differences-only is the default view, so every row shown is a difference.
      const rows = await broker.locator('.wl-row').count();
      assert.equal(rows, reworded + Number(await broker.locator('.wl-stat:has-text("DROPPED") .stat-value').innerText())
        + Number(await broker.locator('.wl-stat:has-text("ADDED") .stat-value').innerText()));

      // Opening a reworded clause shows the word-level diff.
      await broker.locator('.wl-row--changed .wl-row-head').first().click();
      await broker.locator('.wl-row--changed .wl-diff').first().waitFor();
      await broker.locator('.wl-row--changed .wl-ins').first().waitFor();
      await broker.locator('.wl-row--changed .wl-del').first().waitFor();
    });

    await step('two reinsurers can be compared against each other', async () => {
      const left = broker.locator('.wl-side').first();
      const right = broker.locator('.wl-side').last();
      await left.locator('.field:has(span:text-is("Compare")) select').selectOption('market');
      await selectByPrefix(left.locator('.field:has(span:text-is("Reinsurer")) select'), 'Munich Re');
      await left.locator('.field:has(span:text-is("Class of business")) select').selectOption('Casualty');
      await right.locator('.field:has(span:text-is("Class of business")) select').selectOption('Casualty');
      await broker.click('section.card:has(.wl-compare-picker) button:has-text("Compare")');
      await broker.waitForSelector('.card-head h2:has-text("Munich Re vs Swiss Re")', { timeout: 15000 });
      assert.ok(await broker.locator('.wl-row').count() > 0, 'the two markets differ somewhere');
    });

    await step('an underwriter can read the library but not edit it', async () => {
      await uw.goto(`${BASE}/wordings`, { waitUntil: 'networkidle' });
      await uw.waitForSelector('h1:has-text("Wording library")');
      await uw.waitForSelector('.wl-item');
      assert.ok(await uw.locator('.wl-item').count() > 20, 'the library is readable');
      assert.equal(await uw.locator('button:has-text("+ New clause")').count(), 0, 'no create button for underwriters');
      await uw.click('.wl-item >> nth=0');
      await uw.waitForSelector('.wl-detail h3');
      assert.equal(await uw.locator('.wl-detail button:has-text("Edit")').count(), 0, 'no edit button for underwriters');
      await uw.click('.wl-tab:has-text("Drafts")');
      await uw.waitForSelector('text=Draft wordings');
      assert.equal(await uw.locator('button:has-text("Start a draft")').count(), 0, 'no draft builder for underwriters');
    });
  } catch (e) {
    errors.push(`wordings spec threw: ${e.message}`);
  } finally {
    await browser.close();
  }
  return errors;
}
