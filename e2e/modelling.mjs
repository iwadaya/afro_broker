// The modelling workflow on the placement page: after the Retentions tab the
// Universe modelling tool's manual-input screens appear, split by basis from
// the treaty type — a QS treaty runs the proportional wizard (triangles AND
// straight stats, losses, dev factors, summaries, profiles, exposure,
// pricing), an XoL one the non-proportional wizard (premiums cockpit, loss
// dev factors, excess LDFs, historical performance, final pricing). Each
// screen persists to placement_modelling and survives a reload.
import assert from 'node:assert/strict';
import { launch, login, makeStep, BASE } from './lib.mjs';

const nav = (page) => page.locator('nav.wizard-tabs');
const clickTab = async (page, label) => {
  await nav(page).locator('button', { hasText: label }).first().click();
  await page.waitForTimeout(500);
};

/** Create a bare placement of the given class through the app's own API
    (the signed-in page carries the token), then open its detail page. */
async function makePlacement(broker, tag, klass) {
  const id = await broker.evaluate(async ({ tag: t, klass: k }) => {
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
    const cedant = await call('POST', '/cedants', { name: `Cedant ${t}`, domicile: 'UK' });
    const p = await call('POST', '/placements', {
      cedant_id: cedant.id, class: k, inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD',
    });
    return p.id;
  }, { tag, klass });
  await broker.goto(`${BASE}/placements/${id}`, { waitUntil: 'networkidle' });
  await broker.waitForSelector('nav.wizard-tabs');
  return broker.url();
}

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `mod-${Date.now()}`;
  console.log('modelling: workflow after Retentions, split by basis, persisted');

  try {
    const broker = await login(browser, 'broker', errors);
    let propUrl;

    await step('a QS placement runs the proportional wizard — triangles AND straight stats', async () => {
      propUrl = await makePlacement(broker, `${tag}-p`, 'Property QS');
      const tabs = await nav(broker).innerText();
      for (const label of ['TRIANGLES', 'Premium Triangle', 'Straight Stats', 'Large Loss List', 'Premium Dev Factors', 'Projected Summary', 'Quick Summary', 'Risk Profile', 'CRESTA Aggregates', 'Event Loss Tables']) {
        assert.ok(tabs.includes(label), `prop nav carries ${label}`);
      }
      assert.ok(!/\bPricing\b/.test(tabs), 'no pricing screens');
      assert.ok(!tabs.includes('Premiums Table'), 'no NP screens on a proportional treaty');
      // The distribution tabs still follow the modelling block.
      for (const label of ['Data', 'Renewal Pack', 'Pack Approval', 'Quoting Stage']) {
        assert.ok(tabs.includes(label), `${label} still present after the modelling block`);
      }
    });

    await step('a triangle cell saves and survives a reload', async () => {
      await clickTab(broker, 'Premium Triangle');
      await broker.waitForSelector('.tri-inp');
      await broker.locator('.tri-inp:not(.tri-inp--derived)').first().fill('2500000');
      await broker.locator('.mod-savebar button:has-text("Save")').click();
      await broker.waitForSelector('text=Triangle saved');
      await broker.reload();
      await broker.waitForSelector('nav.wizard-tabs');
      await clickTab(broker, 'Premium Triangle');
      await broker.waitForSelector('.tri-inp');
      const v = await broker.locator('.tri-inp:not(.tri-inp--derived)').first().inputValue();
      assert.equal(v, '2,500,000');
    });

    await step('straight stats sit beside the triangles and project on a benchmark curve', async () => {
      await clickTab(broker, 'Straight Stats');
      await broker.waitForSelector('text=STRAIGHT STATS');
      const cells = broker.locator('.nt-table .mod-cell');
      await cells.nth(0).fill('4000000');
      await cells.nth(1).fill('1200000');
      await broker.locator('.mod-savebar button:has-text("Save")').click();
      await broker.waitForSelector('text=Straight stats saved');
      // The projection preview reads the entered stats.
      const preview = await broker.locator('.np-struct-card:has-text("Projection Preview")').innerText();
      assert.ok(/4,\d{3},\d{3}|4,000,000/.test(preview), 'ultimate premium projected from the entered stats');
    });

    await step('a large loss row feeds selection, and the incurred is derived', async () => {
      await clickTab(broker, 'Large Loss List');
      await broker.waitForSelector('.ll-table');
      const row = broker.locator('.ll-table tbody tr').first();
      await row.locator('input').nth(1).fill('Big Insured');
      await row.locator('input[type=date]').first().fill('2023-06-15');
      await row.locator('input[type=date]').nth(1).fill('2023-07-01');
      // Gross loss leads the amounts (left blank it reads as the incurred).
      await row.locator('.mod-cell--right').nth(1).fill('600000'); // paid
      await row.locator('.mod-cell--right').nth(2).fill('150000'); // O/S
      // The gross-to-net split: gross defaults to the incurred; the quota
      // share, surplus and facultative cessions leave the net retention.
      const heads = (await broker.locator('.ll-table thead th').allTextContents()).map((t) => t.trim());
      for (const h of ['DATE REPORTED', 'GROSS LOSS', 'QUOTA SHARE', '1ST SURPLUS', '2ND SURPLUS', 'FACULTATIVE', 'NET RETENTION']) {
        assert.ok(heads.includes(h), `${h} column`);
      }
      assert.ok(heads.indexOf('GROSS LOSS') < heads.indexOf('PAID'), 'gross loss comes before paid');
      await row.locator('.mod-cell--right').nth(3).fill('100000'); // quota share
      await row.locator('.mod-cell--right').nth(4).fill('50000'); // 1st surplus
      await row.locator('.mod-cell--right').nth(6).fill('25000'); // facultative
      await row.locator('.mod-cell--right').nth(6).press('Tab');
      assert.equal((await row.locator('[data-col=netRetention]').textContent()).trim(), '575,000', 'net = 750,000 − 175,000');
      await broker.locator('.mod-savebar button:has-text("Save")').click();
      await broker.waitForSelector('text=Saved 1 record');
      await clickTab(broker, 'Large Loss Selection');
      const sel = await broker.locator('.mod-screen').innerText();
      assert.ok(sel.includes('Big Insured'), 'the loss reaches the selection screen');
      assert.ok(sel.includes('750,000'), 'incurred = paid + OS');
      // UW year derived from the date of loss.
      assert.ok(sel.includes('2023'), 'UW year derived from the date of loss');
    });

    await step('the dev factor screen computes a pattern from the saved triangle', async () => {
      await clickTab(broker, 'Premium Dev Factors');
      await broker.waitForSelector('text=Underwriter Chosen Factors');
    });

    await step('a treaty over two classes carries one set of data per class, picked by pills', async () => {
      await makePlacement(broker, `${tag}-c`, 'Property / Motor Quota Share');
      await clickTab(broker, 'Premium Triangle');
      await broker.waitForSelector('.tri-inp');
      const pills = broker.locator('.mod-cob-pills .mod-cob-pill');
      assert.deepEqual((await pills.allTextContents()).map((t) => t.trim()), ['Property', 'Motor'], 'a pill per class');
      assert.equal((await pills.filter({ hasText: 'Property' }).getAttribute('class')).includes('is-on'), true, 'the first class leads');

      // Property's triangle, saved; Motor's is its own, empty. A class's
      // triangle loads after its pill is on, so a value is waited for.
      const cell = () => broker.locator('.tri-inp:not(.tri-inp--derived)').first();
      const cellReads = (value) => broker.waitForFunction(
        (v) => document.querySelector('.tri-inp:not(.tri-inp--derived)')?.value === v, value, { timeout: 10000 },
      );
      await cell().fill('1000000');
      await broker.locator('.mod-savebar button:has-text("Save")').click();
      await broker.waitForSelector('text=Triangle saved');
      await pills.filter({ hasText: 'Motor' }).click();
      await broker.waitForSelector('.mod-cob-pill.is-on:has-text("Motor")');
      await broker.waitForSelector('.tri-inp');
      await cellReads('');
      assert.equal(await cell().inputValue(), '', 'Motor starts with its own empty triangle');
      await cell().fill('250000');
      await broker.locator('.mod-savebar button:has-text("Save")').click();
      await broker.waitForSelector('text=Triangle saved');

      // Each class reads back its own, on another screen too, and after a reload.
      await pills.filter({ hasText: 'Property' }).click();
      await broker.waitForSelector('.mod-cob-pill.is-on:has-text("Property")');
      await cellReads('1,000,000');
      assert.equal(await cell().inputValue(), '1,000,000', 'Property keeps its triangle');
      await clickTab(broker, 'Large Loss List');
      assert.equal((await broker.locator('.mod-cob-pill.is-on').textContent()).trim(), 'Property', 'the class carries across screens');
      await broker.reload();
      await broker.waitForSelector('nav.wizard-tabs');
      await clickTab(broker, 'Premium Triangle');
      await broker.waitForSelector('.tri-inp');
      await broker.locator('.mod-cob-pills .mod-cob-pill', { hasText: 'Motor' }).click();
      await broker.waitForSelector('.mod-cob-pill.is-on:has-text("Motor")');
      await cellReads('250,000');
      assert.equal(await cell().inputValue(), '250,000', 'Motor keeps its triangle after a reload');
    });

    await step('the Renewal Pack tab carries the standardised modelling pack: a sheet per screen per class, and the AI analysis', async () => {
      // Still on the two-class placement, with a triangle saved for each class.
      await broker.locator('nav.wizard-tabs button[data-tab="pack"]').click();
      await broker.locator('.rp-viewswitch button', { hasText: 'Modelling Pack' }).click();
      await broker.waitForSelector('[data-testid="modelling-pack"] .mp-sheets');
      const rows = await broker.locator('.mp-sheets tbody tr').allInnerTexts();
      assert.ok(rows.some((r) => r.includes('Property') && r.includes('Premium Triangle')), 'Property has its premium triangle sheet');
      assert.ok(rows.some((r) => r.includes('Motor') && r.includes('Premium Triangle')), 'Motor has its own premium triangle sheet');
      assert.match(await broker.locator('.mp-actions button:has-text("Excel pack")').innerText(), /3 sheets/, 'cover + one sheet per class per screen');

      // The Excel pack downloads, named for the placement.
      const [download] = await Promise.all([
        broker.waitForEvent('download', { timeout: 30000 }),
        broker.locator('.mp-actions button:has-text("Excel pack")').click(),
      ]);
      assert.match(download.suggestedFilename(), /-modelling-pack\.xlsx$/, 'the workbook is named for the placement');

      // No AI key on the dev server: the analysis says so instead of failing silently.
      await broker.locator('.mp-actions button:has-text("Analyse with AI")').click();
      await broker.waitForSelector('.mp-notice--warn');
      assert.match(await broker.locator('.mp-notice--warn').innerText(), /not configured/);
      // The browser logs that 503 as a console error of its own; it is the expected answer here.
      const expected = errors.findIndex((e) => /503 \(Service Unavailable\)/.test(e));
      if (expected >= 0) errors.splice(expected, 1);
    });

    await step('raw data uploads beside the screens, and the AI cross-check runs against them', async () => {
      await broker.waitForSelector('[data-testid="modelling-raw-data"]');
      await broker.locator('.mp-upload-note').fill('2024 loss run');
      await broker.locator('[data-testid="raw-data-file"]').setInputFiles({
        name: 'loss-run.csv', mimeType: 'text/csv', buffer: Buffer.from('uw_year,insured,gross\n2024,Fleet Co,450000\n'),
      });
      await broker.waitForSelector('.mp-docs tr:has-text("loss-run.csv")');
      assert.match(await broker.locator('.mp-docs tr:has-text("loss-run.csv")').innerText(), /2024 loss run/, 'the note is kept with the file');

      // No AI key on the dev server: the cross-check says so, and the upload stays.
      await broker.locator('.mp-upload button:has-text("Cross-check with AI")').click();
      await broker.waitForSelector('.mp-notice--warn');
      assert.match(await broker.locator('.mp-notice--warn').innerText(), /not configured/);
      const expected503 = errors.findIndex((e) => /503 \(Service Unavailable\)/.test(e));
      if (expected503 >= 0) errors.splice(expected503, 1);

      await broker.reload();
      await broker.waitForSelector('nav.wizard-tabs');
      await broker.locator('nav.wizard-tabs button[data-tab="pack"]').click();
      await broker.locator('.rp-viewswitch button', { hasText: 'Modelling Pack' }).click();
      await broker.waitForSelector('.mp-docs tr:has-text("loss-run.csv")');
      await broker.locator('.mp-docs tr:has-text("loss-run.csv") button:has-text("Remove")').click();
      await broker.waitForSelector('text=No raw data uploaded yet.');
    });

    await step('the structures to quote decide the wizards: both, proportional only, or non-proportional only', async () => {
      const url = await makePlacement(broker, `${tag}-b`, 'Property Quota Share');
      const pid = url.split('/').pop();
      const setStructures = (structures) => broker.evaluate(async ([id, quote_structures]) => {
        const r = await fetch(`/api/placements/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('ub_token')}` },
          body: JSON.stringify({ quote_structures }),
        });
        if (!r.ok) throw new Error(`PATCH structures: ${r.status}`);
      }, [pid, structures]);
      const layer = { name: 'L1', type: 'XoL', limit: 1_000_000, attachment: 500_000 };
      const rail = async () => {
        await broker.goto(url, { waitUntil: 'networkidle' });
        await broker.waitForSelector('nav.wizard-tabs');
        return nav(broker).innerText();
      };

      // Both bases quoted → both wizards, the shared screens once.
      await setStructures([
        { basis: 'PROP', prop: { treatyType: 'Quota Share', qsLimit: 5_000_000 }, layers: [], cobs: [] },
        { basis: 'NP', npTreatyType: 'Risk & CAT XL', layers: [layer], cobs: [] },
      ]);
      let tabs = await rail();
      for (const label of ['Premium Triangle', 'Straight Stats', 'Premiums Table', 'Large Loss Dev Factors', 'Excess Dev Factors', 'Quick Summary']) {
        assert.ok(tabs.includes(label), `both: carries ${label}`);
      }
      assert.equal((tabs.match(/Large Loss List/g) || []).length, 1, 'both: the shared screens appear once');

      // Only a non-proportional structure → the NP wizard alone; a Risk XL
      // drops the cat screens, a CAT XL the large-loss screens (the tool's
      // peril modes).
      await setStructures([{ basis: 'NP', npTreatyType: 'Risk XL', layers: [layer], cobs: [] }]);
      tabs = await rail();
      assert.ok(tabs.includes('Premiums Table') && !tabs.includes('Premium Triangle'), 'NP only: no proportional screens');
      assert.ok(!tabs.includes('Cat Loss List') && !tabs.includes('CRESTA Aggregates'), 'Risk XL: no cat screens');
      assert.ok(tabs.includes('Large Loss List'), 'Risk XL: the large-loss screens stay');
      await setStructures([{ basis: 'NP', npTreatyType: 'CAT XL', layers: [layer], cobs: [] }]);
      tabs = await rail();
      assert.ok(!tabs.includes('Large Loss List') && tabs.includes('Cat Loss List'), 'CAT XL: no large-loss screens');

      // Only a proportional structure → the proportional wizard alone.
      await setStructures([{ basis: 'PROP', prop: { treatyType: 'Quota Share' }, layers: [], cobs: [] }]);
      tabs = await rail();
      assert.ok(tabs.includes('Premium Triangle') && !tabs.includes('Premiums Table'), 'PROP only: no NP screens');
    });

    await step('an XoL placement runs the non-proportional wizard instead', async () => {
      await makePlacement(broker, `${tag}-n`, 'Property XoL');
      const tabs = await nav(broker).innerText();
      for (const label of ['Premiums Table', 'Large Loss Dev Factors', 'Excess Dev Factors', 'Historical Performance']) {
        assert.ok(tabs.includes(label), `np nav carries ${label}`);
      }
      assert.ok(!tabs.includes('Premium Triangle'), 'no triangle screens on a non-proportional treaty');
      assert.ok(!tabs.includes('Quick Summary'), 'no proportional summaries either');
    });

    await step('EGNPI saved on the premiums table survives a reload', async () => {
      await clickTab(broker, 'Premiums Table');
      await broker.waitForSelector('text=PREMIUMS & INFLATION COCKPIT');
      const egnpiCells = broker.locator('.np-struct-card:has-text("Underwriting Years") .mod-cell');
      const n = await egnpiCells.count();
      await egnpiCells.nth(n - 1).fill('9000000');
      await broker.locator('.mod-savebar button:has-text("Save")').click();
      await broker.waitForSelector('text=Premiums saved');
      await broker.reload();
      await broker.waitForSelector('nav.wizard-tabs');
      await clickTab(broker, 'Premiums Table');
      await broker.waitForSelector('text=PREMIUMS & INFLATION COCKPIT');
      const cells = broker.locator('.np-struct-card:has-text("Underwriting Years") .mod-cell');
      assert.equal(await cells.nth((await cells.count()) - 1).inputValue(), '9,000,000', 'the EGNPI reads back');
      assert.ok(!(await nav(broker).innerText()).includes('Final Pricing'), 'no final pricing screen');
    });

    await step('an underwriter reads the modelling but cannot save it', async () => {
      const uw = await login(browser, 'uw', errors);
      await uw.goto(propUrl, { waitUntil: 'networkidle' });
      await uw.waitForSelector('nav.wizard-tabs');
      await clickTab(uw, 'Premium Triangle');
      await uw.waitForSelector('.tri-inp');
      assert.equal(await uw.locator('.mod-savebar button:has-text("Save")').count(), 0, 'no save button for a read-only role');
      const v = await uw.locator('.tri-inp--derived').first().innerText();
      assert.equal(v.trim(), '2,500,000', 'the saved triangle reads back for the underwriter');
    });
  } finally {
    await browser.close();
  }
  return errors;
}
