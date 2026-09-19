// Renewal pack: the pack tab is a checklist of every screen — with or without
// data — over the template's sections, and Create Renewal Pack cuts the next
// version: stored, with its Excel and PDF rendered at that moment and kept
// with it. Every section for the basis is present whether or not there is
// data behind it.
import assert from 'node:assert/strict';
import { launch, login, makeStep, BASE } from './lib.mjs';

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

/** Create a placement through the API. */
async function seed(page, { klass }) {
  const cedant = await call(page, 'POST', '/cedants', { name: `Pack Cedant ${Date.now()}`, domicile: 'Kenya' });
  return call(page, 'POST', '/placements', {
    cedant_id: cedant.id, class: klass, inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD',
  });
}

/** Import a premium and a claims bordereau, so the experience sections fill. */
async function importBordereaux(page, placementId) {
  await call(page, 'POST', `/placements/${placementId}/bordereaux`, {
    type: 'premium', source_file: 'premium.csv',
    rows: [{ policy_ref: 'P-001', insured: 'Acme Mills', class_of_business: 'Property', territory: 'Kenya',
      sum_insured_100: '5000000', si_ceded: '4000000', premium_ceded: '20000', gross_premium_100: '25000' }],
  });
  await call(page, 'POST', `/placements/${placementId}/bordereaux`, {
    type: 'claims', source_file: 'claims.csv',
    rows: [{ claim_ref: 'C-001', policy_ref: 'P-001', date_of_loss: '2026-03-04', cause_of_loss: 'Fire',
      paid: '20000', outstanding: '5000' }],
  });
}

/** Give a placement a Risk XL structure to quote, an expiring structure, and
    data on every screen that structure requires — so a version can be submitted. */
async function fillRequiredScreens(page, placementId) {
  await call(page, 'PATCH', `/placements/${placementId}`, {
    quote_structures: [{ basis: 'NP', npTreatyType: 'Risk XL', cobs: [], prop: {},
      layers: [{ name: 'Layer 1', type: 'XoL', limit: 5000000, attachment: 1000000, premium: 400000, rate_pct: 8 }] }],
    expiring_structure: { basis: 'NP', layers: [{ name: 'Layer 1', limit: 4000000, attachment: 1000000, premium: 380000 }] },
  });
  for (const section of ['np_premiums', 'np_historical', 'large_losses', 'loss_selection_large', 'np_large_ldf', 'np_excess_dev', 'risk_profile']) {
    await call(page, 'PUT', `/placements/${placementId}/modelling/${section}`, { data: { note: 'entered for the e2e run', rows: [{ value: 1 }] } });
  }
}

/** Open the placement's Renewal Pack tab — it lands on the checklist. */
const openPack = async (page, id) => {
  await page.goto(`${BASE}/placements/${id}`, { waitUntil: 'networkidle' });
  await page.click('.wizard-tab:has-text("Renewal Pack")');
  await page.waitForSelector('.rp-viewswitch');
  await page.waitForSelector('[data-testid="screen-checklist"] .rp-check-row', { timeout: 15000 });
  await page.waitForSelector('[data-testid="pack-checklist"]', { timeout: 15000 });
  await page.waitForTimeout(400);
};

/** Create the next version and wait for it to be shown. */
async function createPack(page, version) {
  await page.click('[data-testid="create-pack"]');
  await page.waitForSelector(`[data-testid="pack-created"]:has-text("v${version} created")`, { timeout: 30000 });
  await page.waitForSelector(`.rp-meta:has-text("Version ${version}")`, { timeout: 20000 });
  await page.waitForTimeout(300);
}

/** Section title → status (the rightmost pill), from the pack checklist. */
async function sectionsOnScreen(page) {
  const out = {};
  for (const row of await page.locator('[data-testid="pack-checklist"] .rp-check-row').all()) {
    const title = (await row.locator('.rp-check-title').innerText()).trim();
    const statuses = await row.locator('.rp-status').allTextContents();
    out[title] = (statuses[statuses.length - 1] || '').trim().toLowerCase();
  }
  return out;
}

/** Screen label → whether every class holds data, from the screen checklist. */
async function screensOnScreen(page) {
  const out = {};
  for (const row of await page.locator('[data-testid="screen-checklist"] .rp-check-row').all()) {
    const label = (await row.locator('.rp-check-title').innerText()).trim();
    out[label] = (await row.locator('.rp-check-mark--empty').count()) === 0;
  }
  return out;
}

const screenGroups = async (page) => (await page.locator('[data-testid="screen-checklist"] .rp-check-group').allTextContents())
  .map((t) => t.trim()).filter(Boolean);

/** Download through a button and hand back the file's name and size. */
async function downloadVia(page, selector) {
  const [downloaded] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click(selector),
  ]);
  const fs = await import('node:fs');
  return { name: downloaded.suggestedFilename(), size: fs.statSync(await downloaded.path()).size };
}

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  console.log('packs: the checklist of screens + Create Renewal Pack (SQL, Excel, PDF)');

  try {
    const broker = await login(browser, 'broker', errors);

    await step('the pack opens on the checklist of every screen, shaped by the basis', async () => {
      const np = await seed(broker, { klass: 'Property Cat XoL' });
      await openPack(broker, np.id);
      assert.equal(await broker.locator('.rp-tabs').count(), 0, 'the paste-from-Excel input tabs are gone');
      assert.equal(await broker.locator('.rp-viewswitch button').count(), 2, 'Pack and Modelling Pack are the views');
      const hint = await broker.locator('.np-struct-card-hint').first().innerText();
      assert.match(hint, /Create Renewal Pack cuts v1/i);
      assert.match(await broker.locator('[data-testid="create-pack"]').innerText(), /Create Renewal Pack/i);

      // The placement screens come first, then the modelling wizard's groups.
      const npGroups = await screenGroups(broker);
      assert.equal(npGroups[0], 'Placement');
      for (const label of ['Premiums', 'Large Losses', 'Profiles']) {
        assert.ok(npGroups.includes(label), `${label} group listed (got ${npGroups.join(', ')})`);
      }
      const screens = await screensOnScreen(broker);
      assert.equal(screens['Treaty Detail'], true, 'the treaty detail is entered on creation');
      assert.equal(screens['Large Loss List'], false, 'no large losses yet');
      assert.ok(!('Data' in screens), 'the Data screen reads the others rather than holding data');
      assert.ok(!('Renewal Pack' in screens) && !('Quoting Stage' in screens) && !('Pack Approval' in screens), 'only data screens are listed');
      // The quoting structure decides which screens are required: the placement
      // screens always, and the tracker counts them first.
      const tracker = await broker.locator('[data-testid="screen-tracker"]').innerText();
      assert.match(tracker, /\d+\/\d+ required screens have data/i);
      assert.match(tracker, /\d+\/\d+ in all/i);
      const detailRow = broker.locator('[data-testid="screen-checklist"] .rp-check-row:has(.rp-check-title:text-is("Treaty Detail"))');
      assert.equal(await detailRow.locator('.rp-status--required').count(), 1, 'Treaty Detail is required');
      const dataRow = broker.locator('[data-testid="screen-checklist"] .rp-check-row:has(.rp-check-title:text-is("Data"))');
      assert.equal(await dataRow.locator('.rp-status--required').count(), 0, 'the bordereau data is never required');
      assert.ok(await broker.locator('.rp-tracker-chip--required').count() >= 1, 'a required screen without data is flagged');

      const prop = await seed(broker, { klass: 'Property Quota Share' });
      await openPack(broker, prop.id);
      const propGroups = await screenGroups(broker);
      for (const label of ['Triangles', 'Experience', 'Dev Factors', 'Summaries']) {
        assert.ok(propGroups.includes(label), `${label} group listed for PROP`);
      }
    });

    await step('every section of the template is listed, empty ones included', async () => {
      const placement = await seed(broker, { klass: 'Property Cat XoL' });
      await openPack(broker, placement.id);
      assert.match(await broker.locator('.np-struct-card-hint').first().innerText(), /non-proportional running order/i);
      const groups = (await broker.locator('[data-testid="pack-checklist"] .rp-check-group').allTextContents()).map((t) => t.trim());
      for (const label of ['Setup', 'Structure', 'Experience', 'Large Losses', 'Cat Losses', 'Profiles', 'Exposure', 'Market']) {
        assert.ok(groups.some((t) => t.startsWith(label)), `${label} group present`);
      }
      const sections = await sectionsOnScreen(broker);
      const empties = Object.entries(sections).filter(([, status]) => status.endsWith('empty'));
      assert.ok(empties.length >= 3, 'the empty sections stay listed');
      assert.ok(empties.some(([title]) => /Triangulation|Straight Stats|Loss/i.test(title)), 'the experience sections are among them');
      assert.ok((await broker.locator('.rp-empty-note').first().innerText()).length > 10,
        'an empty section says what would fill it');
    });

    await step('Create Renewal Pack cuts the version and stores its Excel and PDF', async () => {
      const placement = await seed(broker, { klass: 'Property Cat XoL' });
      await openPack(broker, placement.id);
      await createPack(broker, 1);

      const banner = broker.locator('[data-testid="pack-created"]');
      assert.match(await banner.innerText(), /Stored as version 1/);
      assert.match(await banner.innerText(), /Created without data on \d+ required screens?/i);
      assert.match(await broker.locator('[data-testid="approval-required-missing"]').innerText(), /Required screens without data when this version was created/i);
      assert.match(await broker.locator('.rp-meta').innerText(), /EXCEL \+ PDF STORED/);
      assert.match(await broker.locator('.np-struct-card-actions select option:checked').innerText(), /v1/);

      // The files the banner offers are the ones cut with the version.
      for (const [label, extension, minimumBytes] of [['Excel', 'xlsx', 5000], ['PDF', 'pdf', 3000]]) {
        const { name, size } = await downloadVia(broker, `[data-testid="pack-created"] button:has-text("${label}")`);
        assert.match(name, new RegExp(`RenewalPack_v1_\\d{4}-\\d{2}-\\d{2}\\.${extension}$`),
          `${label} downloads under the pack's own name (got ${name})`);
        assert.ok(size > minimumBytes, `${label} is a real file (${size} bytes)`);
        assert.match(await banner.locator(`button:has-text("${label}")`).innerText(), /KB|MB/, 'the banner shows the stored size');
      }

      // The version records the checklist as it stood when it was cut.
      const stored = await call(broker, 'GET', `/placements/${placement.id}/packs`);
      const pack = await call(broker, 'GET', `/packs/${stored[0].id}`);
      assert.ok(pack.snapshot.screens.rows.length >= 5, 'the screens are on the snapshot');
      assert.equal(pack.snapshot.screens.rows.find((r) => r.label === 'Treaty Detail').done[0], true);
      assert.ok(pack.files.xlsx.bytes > 5000 && pack.files.pdf.bytes > 3000, 'both files stored');
      assert.match(await broker.locator('[data-testid="screen-checklist"] .rp-sub-title').innerText(), /as recorded when v1 was created/i);
    });

    await step('versions keep their contents when the data moves on', async () => {
      const placement = await seed(broker, { klass: 'Property Cat XoL' });
      await openPack(broker, placement.id);

      // v1 — cut before any data is in.
      await createPack(broker, 1);
      assert.equal((await sectionsOnScreen(broker))['Large Loss List'], 'empty');

      // The bordereaux arrive, then v2.
      await importBordereaux(broker, placement.id);
      await createPack(broker, 2);
      const v2 = await sectionsOnScreen(broker);
      assert.equal(v2['Large Loss List'], 'filled');
      assert.equal(v2['Premium Experience'], 'filled');

      // The change list names what filled.
      const changes = await broker.locator('.rp-changes').innerText();
      assert.match(changes, /Changed since v1/);
      assert.match(changes, /Large Loss List filled/);

      // Going back to v1 reads it as it was cut, not as the data is now.
      await broker.locator('.np-struct-card-actions select').selectOption({ index: 2 });
      await broker.waitForSelector('.rp-meta:has-text("Version 1")');
      await broker.waitForTimeout(300);
      assert.equal((await sectionsOnScreen(broker))['Large Loss List'], 'empty',
        'v1 still shows what it showed when it was cut');
    });

    await step('a created version downloads as Excel, CSV and PDF from the exports', async () => {
      const placement = await seed(broker, { klass: 'Property Cat XoL' });
      await openPack(broker, placement.id);
      await createPack(broker, 1);
      const exports = '.np-struct-card-actions .rp-exports';
      const labels = (await broker.locator(`${exports} button`).allTextContents()).join(' ');
      assert.match(labels, /Excel/);
      assert.match(labels, /CSV/);
      assert.match(labels, /PDF/);

      for (const [label, extension, minimumBytes] of [
        ['Excel', 'xlsx', 5000], ['CSV', 'csv', 500], ['PDF', 'pdf', 3000],
      ]) {
        const { name, size } = await downloadVia(broker, `${exports} button:has-text("${label}")`);
        assert.match(name, new RegExp(`RenewalPack_v1_\\d{4}-\\d{2}-\\d{2}\\.${extension}$`),
          `${label} downloads under the pack's own name (got ${name})`);
        assert.ok(size > minimumBytes, `${label} is a real file (${size} bytes)`);
      }
    });

    await step('a version goes for approval: the broker submits, a Senior Broker returns it, then approves it', async () => {
      const placement = await seed(broker, { klass: 'Property Cat XoL' });
      await openPack(broker, placement.id);
      await createPack(broker, 1);

      // Until a version is approved the Quoting Stage tab is locked.
      assert.equal(await broker.locator('.wizard-tab--locked:has-text("Quoting Stage")').count(), 1, 'the Quoting Stage tab shows its lock');
      assert.equal(await broker.locator('[data-testid="approve-pack"]').count(), 0, 'a broker is never offered the approval');

      // v1 was created without data on required screens: the pack tab says so,
      // and the approval tab holds submit.
      assert.match(await broker.locator('[data-testid="approval-required-missing"]').innerText(), /Submit is held/i);
      const openApproval = async (page) => {
        await page.click('.wizard-tab[data-tab=approval]');
        await page.waitForSelector('[data-testid="pack-approval-screen"]', { timeout: 15000 });
      };
      await openApproval(broker);
      assert.ok(await broker.locator('[data-testid="submit-pack"]').isDisabled(), 'submit is held until every required screen has data');
      assert.match(await broker.locator('[data-testid="pack-stepper"]').innerText(), /created/i);

      // The data goes on the screens, and a new version is created from them.
      await fillRequiredScreens(broker, placement.id);
      await openPack(broker, placement.id);
      assert.match(await broker.locator('[data-testid="screen-tracker"]').innerText(), /ready for approval/i);
      await createPack(broker, 2);
      assert.equal(await broker.locator('[data-testid="approval-required-missing"]').count(), 0);
      await broker.click('[data-testid="submit-created"]');
      await broker.waitForSelector('[data-testid="pack-approval-screen"]', { timeout: 15000 });
      assert.ok(!(await broker.locator('[data-testid="submit-pack"]').isDisabled()), 'submit opens once every required screen has data');

      await broker.click('[data-testid="submit-pack"]');
      await broker.waitForSelector('[data-testid="pack-approval"]:has-text("awaiting")', { timeout: 15000 });
      assert.match(await broker.locator('[data-testid="pack-approval"]').innerText(), /Submitted by .* awaiting a Senior Broker/i);
      assert.match(await broker.locator('[data-testid="approval-version"] option:checked').innerText(), /awaiting approval/);
      assert.match(await broker.locator('[data-testid="pack-trail"]').innerText(), /Submitted for approval/);

      // A comment on the version, revised: both wordings are kept.
      await broker.fill('[data-testid="comment-body"]', 'Cat load is in the premium — see the premiums screen.');
      await broker.click('[data-testid="add-comment"]');
      await broker.waitForSelector('[data-testid="pack-comment"]', { timeout: 15000 });
      assert.match(await broker.locator('[data-testid="pack-comments"]').innerText(), /Cat load is in the premium/);

      // The Senior Broker opens the same version on the approval tab, returns it with a note…
      const senior = await login(browser, 'senior', errors);
      await senior.goto(`${BASE}/placements/${placement.id}`, { waitUntil: 'networkidle' });
      await openApproval(senior);
      await senior.waitForSelector('[data-testid="approve-pack"]', { timeout: 15000 });
      await senior.click('[data-testid="return-pack"]');
      await senior.fill('[data-testid="return-note"]', 'Large losses need the 2025 run.');
      await senior.click('[data-testid="return-confirm"]');
      await senior.waitForSelector('[data-testid="pack-approval"]:has-text("Returned by")', { timeout: 15000 });
      assert.match(await senior.locator('[data-testid="pack-approval"]').innerText(), /Large losses need the 2025 run/);
      assert.match(await senior.locator('[data-testid="pack-trail"]').innerText(), /Returned with a note/);

      // …the broker sees the note and submits again…
      await broker.goto(`${BASE}/placements/${placement.id}`, { waitUntil: 'networkidle' });
      await openApproval(broker);
      await broker.waitForSelector('[data-testid="pack-approval"]:has-text("Returned by")', { timeout: 15000 });
      await broker.click('[data-testid="submit-pack"]');
      await broker.waitForSelector('[data-testid="pack-approval"]:has-text("awaiting")', { timeout: 15000 });

      // …and the Senior Broker approves it, which opens the quoting stage.
      await senior.goto(`${BASE}/placements/${placement.id}`, { waitUntil: 'networkidle' });
      await openApproval(senior);
      await senior.waitForSelector('[data-testid="approve-pack"]', { timeout: 15000 });
      await senior.click('[data-testid="approve-pack"]');
      await senior.waitForSelector('[data-testid="pack-approval"]:has-text("Approved by")', { timeout: 15000 });
      assert.match(await senior.locator('[data-testid="approval-version"] option:checked').innerText(), /approved/);
      await senior.waitForTimeout(400);
      assert.equal(await senior.locator('.wizard-tab--locked').count(), 0, 'the lock is gone once approved');

      await broker.goto(`${BASE}/placements/${placement.id}`, { waitUntil: 'networkidle' });
      await broker.click('.wizard-tab:has-text("Quoting Stage")');
      await broker.waitForSelector('[data-testid="neg-tabs"]', { timeout: 15000 });
      assert.equal(await broker.locator('[data-testid="negotiation-locked"]').count(), 0);
      await senior.context().close();
    });
  } finally {
    await browser.close();
  }
  return errors;
}
