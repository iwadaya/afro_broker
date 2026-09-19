// Signing by contract: the Signing pill asks which contract on arrival, and
// the contract chosen shows its programme with the written line and the
// signed line of every market on every layer — as a preview until signing
// is applied, then from the ledger.
import assert from 'node:assert/strict';
import { launch, login, makeStep, goHub, buildLayerToFotAuthorised, BASE } from './lib.mjs';

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `sgn-${Date.now()}`;
  console.log('signing: choose a contract → programme + written/signed lines');

  try {
    const broker = await login(browser, 'broker', errors);
    const uw = await login(browser, 'uw', errors);
    let layerUrl;
    let names;
    let contractUrl;

    await step('build placement to authorised FOT and write 25/20/30/40 (115%)', async () => {
      ({ layerUrl, names } = await buildLayerToFotAuthorised(broker, uw, { tag }));
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

    await step('the Signing pill asks which contract, and the search narrows to it', async () => {
      await goHub(broker, 'Signing');
      await broker.waitForSelector('[data-testid=signing-contract-choice]');
      await broker.fill('[data-testid=signing-contract-search]', `Cedant ${tag}`);
      const option = broker.locator(`[data-testid=signing-contract-option]:has-text("Cedant ${tag}")`);
      await option.waitFor();
      assert.equal(await broker.locator('[data-testid=signing-contract-option]').count(), 1, 'one contract matches the cedant');
      assert.match(await option.innerText(), /Lines written/, 'the chooser says where the signing stands');
      await option.click();
      await broker.waitForURL(/\/signing\/[0-9a-f-]{36}$/, { timeout: 15000 });
      contractUrl = broker.url();
      assert.equal(await broker.locator('[data-testid=signing-contract-choice]').count(), 0, 'the pop-up closes on choosing');
    });

    await step('the programme and the written lines show, the signed line as a preview', async () => {
      await broker.waitForSelector('[data-testid=signing-plate]');
      assert.ok((await broker.locator('[data-testid=signing-plate]').innerText()).includes(`Cedant ${tag}`));
      const programme = await broker.locator('[data-testid=signing-programme]').innerText();
      assert.match(programme, /Layer 1/, 'the programme lists the layer');
      assert.match(programme, /115\.00%/, 'the programme carries the written total');
      const layer = broker.locator('[data-testid=signing-layer]').first();
      const txt = await layer.innerText();
      for (const [i, w] of ['25.00%', '20.00%', '30.00%', '40.00%'].entries()) {
        assert.ok(txt.includes(names[i]) && txt.includes(w), `${names[i]} written ${w}`);
      }
      assert.match(txt, /signed line · preview/i, 'the signed column is a preview before signing is applied');
      assert.match(txt, /has not been applied/, 'the layer says so');
      // By reinsurer reads the same lines, one block per market.
      await broker.click('[data-testid=signing-view-market]');
      await broker.waitForSelector('[data-testid=signing-by-market]');
      const byMarket = await broker.locator('[data-testid=signing-by-market]').innerText();
      for (const n of names) assert.ok(byMarket.includes(n), `${n} on the by-reinsurer read`);
      await broker.click('[data-testid=signing-view-layer]');
    });

    await step('once signing is applied, the signed lines read from the ledger', async () => {
      await broker.goto(layerUrl, { waitUntil: 'networkidle' });
      await broker.waitForSelector('button:has-text("Apply signing")');
      await broker.click('button:has-text("Apply signing")');
      await broker.waitForSelector('text=Premium allocation');
      await broker.goto(contractUrl, { waitUntil: 'networkidle' });
      await broker.waitForSelector('[data-testid=signing-layer]');
      const txt = await broker.locator('[data-testid=signing-layer]').first().innerText();
      assert.doesNotMatch(txt, /preview/i, 'no preview once the ledger holds the signed lines');
      assert.match(txt, /100\.00%/, 'Σ signed reads exactly the order');
      const plate = await broker.locator('[data-testid=signing-plate]').innerText();
      assert.match(plate, /Signed/, 'the plate reads Signed');
    });

    await step('Change contract reopens the pop-up with the open contract marked', async () => {
      await broker.click('[data-testid=signing-change-contract]');
      await broker.waitForSelector('[data-testid=signing-contract-choice]');
      await broker.fill('[data-testid=signing-contract-search]', `Cedant ${tag}`);
      const current = broker.locator('[data-testid=signing-contract-option][aria-current="true"]');
      await current.waitFor();
      assert.match(await current.innerText(), /Open/);
      await broker.keyboard.press('Escape');
      await broker.waitForSelector('[data-testid=signing-contract-choice]', { state: 'detached' });
    });
  } finally {
    await browser.close();
  }
  return errors;
}
