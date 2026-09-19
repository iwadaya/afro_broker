// Full placement lifecycle DRAFT→BOUND through the UI, two users (broker drives,
// underwriter authorises). Oversubscribed 115% must sign down to exactly 100%.
import assert from 'node:assert/strict';
import { launch, login, makeStep, buildLayerToFotAuthorised } from './lib.mjs';

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `flow-${Date.now()}`;
  console.log('flow: DRAFT→BOUND');

  try {
    const broker = await login(browser, 'broker', errors);
    const uw = await login(browser, 'uw', errors);
    let layerUrl;
    let names;

    await step('build placement to authorised FOT', async () => {
      ({ layerUrl, names } = await buildLayerToFotAuthorised(broker, uw, { tag }));
    });

    await step('write oversubscribed lines (25/20/30/40 = 115%)', async () => {
      await broker.reload();
      await broker.waitForSelector('text=Written lines');
      const written = ['25', '20', '30', '40'];
      for (let i = 0; i < written.length; i++) {
        const lForm = broker.locator('section:has-text("Written lines") form');
        await lForm.locator('select').selectOption({ label: names[i] });
        await lForm.locator('input[type=number]').fill(written[i]);
        await lForm.locator('button:has-text("Write line")').click();
        await broker.waitForTimeout(350);
      }
    });

    await step('apply signing → Σ signed = 100% = 1,000,000', async () => {
      await broker.click('button:has-text("Apply signing")');
      await broker.waitForSelector('text=Premium allocation');
      const txt = await broker.locator('section:has-text("Bind & closing") table').innerText();
      assert.ok(/100/.test(txt) && /1,000,000/.test(txt), 'allocation should total 100% / 1,000,000');
    });

    await step('four-eyes bind → layer BOUND', async () => {
      await broker.click('button:has-text("Propose bind")');
      await broker.waitForTimeout(400);
      await uw.goto(layerUrl, { waitUntil: 'networkidle' });
      await uw.waitForSelector('text=Bind & closing');
      await uw.click('button:has-text("Authorise bind (4-eyes)")');
      await uw.waitForTimeout(600);
      await broker.reload();
      await broker.waitForSelector('text=Quote board');
      // Status pills read in the design's title case ("Bound"), not the raw
      // backend enum.
      const pill = (await broker.locator('.card-head .status').first().innerText()).trim();
      assert.equal(pill, 'Bound');
    });
  } finally {
    await browser.close();
  }
  return errors;
}
