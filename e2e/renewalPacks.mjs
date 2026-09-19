// Renewal packs: the prompt on arrival, quick or full behind "Upload a
// renewal pack", and the quick route end to end. The AI's read is answered
// at the network edge (there is no key in CI), so what is exercised is the
// desk's own work: the form filled from the model's picks with where each
// came from, a correction marked as such, and the create putting the packs
// on the desk with the intake recorded — through the real API.
import assert from 'node:assert/strict';
import { launch, login, makeStep, goHub, BASE } from './lib.mjs';

/** Call the API as the signed-in user, from inside the page. */
async function call(page, method, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const token = localStorage.getItem('ub_token');
    return fetch(`/api${p}`, {
      method: m,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: b ? JSON.stringify(b) : undefined,
    }).then((r) => r.json());
  }, [method, path, body]);
}

/** What the model returns for the two packs, normalised as the API hands it back. */
const extraction = (tag) => ({
  cedant: { value: `Quick Mutual ${tag}`, source: 'PDF p.1 cover', confidence: 'high' },
  domicile: { value: 'United Kingdom', as_written: 'London', source: 'PDF p.1 cover', confidence: 'medium' },
  treaty_type: { value: 'CAT XL', as_written: 'Property Catastrophe Excess of Loss', source: 'PDF p.2 §1', confidence: 'high' },
  classes_of_business: { values: ['Property'], as_written: 'Property', source: 'PDF p.2 §1', confidence: 'high' },
  notes: '2027 renewal, USD.',
  documents: [
    { index: 1, filename: 'expiring-2026.txt', role: 'expiring', year: '2026', reason: 'Dated 2026.' },
    { index: 2, filename: 'renewal-2027.txt', role: 'current', year: '2027', reason: 'Titled 2027 renewal.' },
  ],
  flags: [{ kind: 'judgement', claim: 'Excess of loss read as CAT XL.', source: 'PDF p.2 §1' }],
});

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `rq-${Date.now()}`;
  console.log('renewalPacks: quick or full renewal pack');

  try {
    const broker = await login(browser, 'broker', errors);
    const intake = broker.locator('[data-testid="rpa-intake"]');
    const form = intake.locator('form.inline-form');

    await step('arriving asks how the pack is being made, and uploading asks quick or full', async () => {
      await goHub(broker, 'Renewal packs');
      await broker.waitForSelector('[data-testid="rpa-pack-choice"]');
      await broker.click('[data-testid="rpa-choice-upload"]');
      await broker.waitForSelector('[data-testid="rpa-mode-choice"]');
      assert.ok(await broker.locator('[data-testid="rpa-mode-quick"]').isVisible());
      assert.ok(await broker.locator('[data-testid="rpa-mode-full"]').isVisible());
    });

    await step('the full renewal pack is the manual form, with nothing filled in', async () => {
      await broker.click('[data-testid="rpa-mode-full"]');
      await broker.waitForSelector('[data-testid="rpa-intake"][data-mode="full"]');
      assert.equal(await broker.locator('[data-testid="rpa-quick"]').count(), 0, 'no dropzone on the full route');
      assert.equal(await form.locator('select').first().inputValue(), '');
      assert.ok(await broker.locator('[data-testid="rpa-create"]').isDisabled(), 'nothing typed, nothing to create');
    });

    await step('the quick route takes the pack first, and says so when no AI can read it', async () => {
      await broker.click('[data-testid="rpa-switch-mode"]');
      await broker.waitForSelector('[data-testid="rpa-intake"][data-mode="quick"]');
      await broker.waitForSelector('[data-testid="rpa-quick-dropzone"]');
      const info = await call(broker, 'GET', '/renewal-analyses/intake');
      if (info.providers.some((p) => p.configured)) {
        console.log('    (an AI provider is configured here — the no-provider note is not shown)');
        return;
      }
      await broker.waitForSelector('[data-testid="rpa-quick-noai"]');
      assert.ok(await broker.locator('[data-testid="rpa-quick-read"]').isDisabled(), 'nothing can read the pack');
    });

    // From here the model's answer comes from the edge of the network, so
    // the desk's own work is what is tested.
    await broker.route('**/api/renewal-analyses/intake', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            providers: [{ provider: 'openai', model: 'gpt-test', configured: true }],
            limits: { max_document_bytes: 15 * 1024 * 1024, max_total_bytes: 18 * 1024 * 1024, max_documents: 6 },
          }),
        });
      }
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        assert.equal(body.documents.length, 2, 'both packs go to the model in one read');
        assert.deepEqual(body.documents.map((d) => d.filename), ['expiring-2026.txt', 'renewal-2027.txt']);
        return route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ provider: 'openai', model: 'gpt-test', attempts: [{ provider: 'openai', status: 'ok' }], extraction: extraction(tag) }),
        });
      }
      return route.continue();
    });

    await step('the quick route: the AI\'s read fills the form, each field saying where it came from', async () => {
      await broker.goto(`${BASE}/renewal-packs`, { waitUntil: 'networkidle' });
      await broker.click('[data-testid="rpa-choice-upload"]');
      await broker.click('[data-testid="rpa-mode-quick"]');
      await broker.waitForSelector('[data-testid="rpa-quick-dropzone"]');
      await broker.setInputFiles('[data-testid="rpa-quick-input"]', [
        { name: 'expiring-2026.txt', mimeType: 'text/plain', buffer: Buffer.from('Expiring 2026 programme: 10m xs 10m') },
        { name: 'renewal-2027.txt', mimeType: 'text/plain', buffer: Buffer.from('Renewal 2027 programme: 12m xs 10m') },
      ]);
      assert.equal(await broker.locator('[data-testid="rpa-quick-file"]').count(), 2);
      await broker.click('[data-testid="rpa-quick-read"]');
      await broker.waitForSelector('[data-testid="rpa-quick-read-done"]', { timeout: 15000 });

      // The dropdowns hold the model's picks, bound by the lookups' row ids.
      assert.equal((await form.locator('select').nth(0).locator('option:checked').textContent()).trim(), 'United Kingdom');
      assert.equal(await form.locator('select').nth(1).inputValue(), '__new__', 'a cedant the register does not know goes in as new');
      assert.equal(await form.locator('input[placeholder="Cedant name"]').inputValue(), `Quick Mutual ${tag}`);
      assert.equal((await form.locator('select').nth(2).locator('option:checked').textContent()).trim(), 'CAT XL');
      assert.ok((await form.locator('.cob-trigger').innerText()).includes('Property'));
      assert.equal(await form.locator('input[placeholder="Optional context for the AI"]').inputValue(), '2027 renewal, USD.');
      // Provenance under the fields (§2.1): confidence and the place it was read.
      const marks = await form.locator('.rpa-ai-mark').allInnerTexts();
      assert.ok(marks[0].includes('AI · medium') && marks[0].includes('PDF p.1 cover'), marks[0]);
      assert.ok(marks.some((m) => m.includes('not in the register')), marks.join(' | '));
      // Each file carries the year the model took it for, as a select.
      const roles = intake.locator('.rpa-quick-file-role select');
      assert.equal(await roles.nth(0).inputValue(), 'expiring');
      assert.equal(await roles.nth(1).inputValue(), 'current');
      // And what the model flagged for checking is listed.
      assert.ok((await intake.locator('.rpa-read-flags').innerText()).includes('Excess of loss read as CAT XL'));
    });

    await step('a correction is marked, and the create puts the packs on the desk with the intake recorded', async () => {
      await form.locator('select').nth(0).selectOption({ label: 'Kenya' });
      const mark = await form.locator('.rpa-ai-mark').first().innerText();
      assert.ok(mark.includes('Corrected') && mark.includes('United Kingdom'), mark);
      assert.equal(await form.locator('select').nth(1).inputValue(), '__new__', 'the new cedant stays picked across a country change');

      const create = broker.locator('[data-testid="rpa-create"]');
      assert.equal((await create.innerText()).trim(), 'Create & upload 2 packs');
      await create.click();
      await broker.waitForURL(/\/renewal-packs\/[0-9a-f-]{36}/, { timeout: 30000 });
      await broker.waitForSelector('.rpa-packs tbody tr', { timeout: 15000 });
      assert.equal(await broker.locator('.rpa-packs tbody tr').count(), 2, 'both packs are on the desk');
      const packs = await broker.locator('.rpa-packs').innerText();
      assert.ok(packs.includes('Expiring pack') && packs.includes('Current pack'), packs);

      const details = await broker.locator('.rpa-side:has-text("Details")').innerText();
      assert.ok(details.includes(`Quick Mutual ${tag}`) && details.includes('Kenya'), details);
      assert.ok(details.includes('Quick renewal pack'), details);
      assert.ok(details.includes('4 accepted · 1 corrected'), details);

      // The record itself says how the details arrived, and keeps the review.
      const id = broker.url().split('/').pop().split('?')[0];
      const record = await call(broker, 'GET', `/renewal-analyses/${id}`);
      assert.equal(record.intake_mode, 'quick');
      assert.equal(record.intake.review.cedant_domicile, 'corrected');
      assert.equal(record.intake.extraction.domicile.value, 'United Kingdom');
      assert.equal(record.cedant_domicile, 'Kenya');
    });

    await step('an underwriter is not asked, and reads the book', async () => {
      const uw = await login(browser, 'uw', errors);
      await uw.goto(`${BASE}/renewal-packs`, { waitUntil: 'networkidle' });
      await uw.waitForSelector('.rpa-book');
      assert.equal(await uw.locator('[data-testid="rpa-pack-choice"]').count(), 0);
      const book = await uw.locator('.rpa-book').innerText();
      assert.ok(book.includes(`Quick Mutual ${tag}`) && book.includes('quick intake'), book);
    });
  } finally {
    await browser.close();
  }
  return errors;
}
