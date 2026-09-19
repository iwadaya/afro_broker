// Finalization features: shaped experience (UW-year / large losses / risk
// profile), client signing instruction, brokerage, MDP debit notes, and
// treaty losses with reinstatement premium.
import assert from 'node:assert/strict';
import { launch, login, makeStep, goHub, buildLayerToFotAuthorised } from './lib.mjs';

const PREMIUM_CSV = `UW Year,Gross Premium
2023,1000000
2024,1200000
2025,1500000`;

const CLAIMS_CSV = `UW Year,Claim Ref,Insured,Paid,Outstanding,Cat Code
2023,C-1,Mill A,200000,100000,
2024,C-2,Plant B,150000,450000,EQ26`;

const RISK_PROFILE_CSV = `Band,Risks,TSI,Premium
0 - 1m,120,80000000,900000
1m - 5m,40,120000000,1400000`;

/** Ingest a bordereau through the API from inside the page (the spec's focus
 *  is the exhibits and loss engine, not the ingest form). */
async function ingest(page, placementId, type, csv) {
  await page.evaluate(async ([pid, t, text]) => {
    const r = await fetch(`/api/placements/${pid}/bordereaux`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${localStorage.getItem('ub_token')}`,
      },
      body: JSON.stringify({ type: t, csv: text }),
    });
    if (!r.ok) throw new Error(`ingest ${t} failed: ${r.status}`);
  }, [placementId, type, csv]);
}

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `final-${Date.now()}`;
  console.log('finalization: experience / instruction / brokerage / MDP / losses');

  try {
    const broker = await login(browser, 'broker', errors);
    const uw = await login(browser, 'uw', errors);

    // XoL 2m xs 1m, premium 400k at 100%, 1 reinstatement @ 100%.
    let layerUrl;
    let placementId;
    await step('build XoL layer to authorised FOT', async () => {
      ({ layerUrl } = await buildLayerToFotAuthorised(broker, uw, {
        tag, premium: 400_000, markets: ['Alpha', 'Beta'], rol: 0.2,
        attachment: 1_000_000, limit: 2_000_000, reinstatements: '1', reinstatementPct: 100,
      }));
      const layerId = layerUrl.split('/').filter(Boolean).slice(-2, -1)[0] || layerUrl.split('/').pop();
      placementId = await broker.evaluate(async (lid) => {
        const r = await fetch(`/api/layers/${lid}`, {
          headers: { authorization: `Bearer ${localStorage.getItem('ub_token')}` },
        });
        return (await r.json()).placement_id;
      }, layerUrl.match(/layers\/([0-9a-f-]+)/)[1]);
    });

    await step('set brokerage on the layer (2.5%)', async () => {
      await broker.goto(layerUrl, { waitUntil: 'networkidle' });
      const card = broker.locator('section:has-text("Layer")').first();
      const input = card.locator('dl input[type=number]').first();
      await input.fill('2.5');
      await card.locator('button:has-text("Save")').first().click();
      await broker.waitForTimeout(500);
    });

    await step('ingest bordereaux → experience exhibits, read through the loss summary and the renewal pack', async () => {
      await ingest(broker, placementId, 'premium', PREMIUM_CSV);
      await ingest(broker, placementId, 'claims', CLAIMS_CSV);
      await ingest(broker, placementId, 'risk_profile', RISK_PROFILE_CSV);

      // The Data tab no longer carries the exhibits — it reads the screens
      // before it. The bordereaux feed the loss summary and, through it, the
      // renewal pack's experience sections.
      const summary = await broker.evaluate(async (pid) => {
        const r = await fetch(`/api/placements/${pid}/loss-summary`, {
          headers: { authorization: `Bearer ${localStorage.getItem('ub_token')}` },
        });
        return r.json();
      }, placementId);
      assert.ok(summary.by_year.some((y) => String(y.year) === '2023'), 'UW year rows');
      assert.ok(summary.large_losses.some((l) => l.claim_ref === 'C-2'), 'C-2 (600k) is large');
      assert.ok(summary.risk_profile && summary.risk_profile.bands.length > 0, 'risk profile bands');

      await broker.goto(`${broker.url().split('/layers')[0]}/placements/${placementId}`, { waitUntil: 'networkidle' });
      await broker.click('.wizard-tab:has-text("Data")');
      await broker.waitForSelector('[data-testid="placement-data"]', { timeout: 15000 });
      assert.equal(await broker.locator('text=Ingest Bordereau').count(), 0, 'the Data tab ingests nothing');
      await broker.click('.wizard-tab[data-tab=pack]');
      await broker.waitForSelector('[data-testid="pack-checklist"]', { timeout: 15000 });
      const filled = await broker.locator('.rp-check-row--filled .rp-check-title').allInnerTexts();
      assert.ok(filled.some((t) => /experience/i.test(t)), `an experience section is filled from the bordereaux (got ${filled.join(', ')})`);
    });

    await step('client signing instruction (60/40 despite 60/60 written) + brokerage', async () => {
      await broker.goto(layerUrl, { waitUntil: 'networkidle' });
      const lines = broker.locator('section:has-text("Written lines & signing-down")');
      for (let i = 0; i < 2; i += 1) {
        const wf = lines.locator('form');
        await wf.locator('select').selectOption({ index: i + 1 });
        await wf.locator('input[type=number]').fill('60');
        await wf.locator('button:has-text("Write line")').click();
        await broker.waitForTimeout(350);
      }

      await broker.click('button:has-text("Client signing instruction")');
      const inputs = lines.locator('table input[type=number]');
      await inputs.nth(0).fill('60');
      await inputs.nth(1).fill('40');
      await broker.click('button:has-text("Apply client instruction")');
      await broker.waitForSelector('text=Client instruction'); // signing method on the layer card

      // Brokerage: 2.5% of the 400k signed premium = 10,000 in the allocation.
      const alloc = broker.locator('section:has-text("Bind & closing")');
      await alloc.locator('td:has-text("10,000")').first().waitFor({ timeout: 10000 });
    });

    await step('four-eyes bind', async () => {
      await broker.click('button:has-text("Propose bind")');
      await broker.waitForTimeout(400);
      await uw.goto(layerUrl, { waitUntil: 'networkidle' });
      await uw.click('button:has-text("Authorise bind (4-eyes)")');
      await uw.waitForSelector('text=Bound', { timeout: 10000 });
    });

    await step('issue MDP → schedule + per-market debit notes, sent → paid', async () => {
      await broker.goto(layerUrl, { waitUntil: 'networkidle' });
      const mdp = broker.locator('section:has-text("minimum & deposit premium")');
      await mdp.locator('input[type=number]').nth(0).fill('320000');
      await mdp.locator('input[type=number]').nth(1).fill('360000');
      await mdp.locator('button:has-text("Issue MDP")').click();
      await broker.waitForSelector('text=Debit notes');
      // 2 markets × 4 instalments.
      assert.equal(await mdp.locator('tbody tr').count(), 8, '8 debit notes');

      await mdp.locator('button:has-text("Mark sent")').first().click();
      await broker.waitForTimeout(400);
      await mdp.locator('button:has-text("Mark paid")').first().click();
      await broker.waitForSelector('section:has-text("minimum & deposit premium") >> text=Paid');
    });

    await step('advise + calculate loss → shares and reinstatement premium', async () => {
      await broker.goto(`${broker.url().split('/layers')[0]}/placements/${placementId}`, { waitUntil: 'networkidle' });
      await broker.click('.wizard-tab:has-text("Data")');
      await broker.waitForSelector('text=Treaty losses');
      const losses = broker.locator('section:has-text("Treaty losses")');
      const lf = losses.locator('form');
      await lf.locator('input[type=text]').fill('Warehouse fire');
      await lf.locator('input[type=date]').fill('2026-03-10');
      await lf.locator('input[type=number]').fill('2500000');
      await lf.locator('button:has-text("Advise loss")').click();
      await broker.waitForTimeout(400);

      await losses.locator('button:has-text("Calculate")').first().click();
      await broker.waitForSelector('section:has-text("Treaty losses") >> text=Advised');
      // 2.5m gross → 1.5m to 2m xs 1m; RIP = (1.5m/2m) × 400k = 300k.
      assert.ok(await losses.locator('td:has-text("1,500,000")').count() > 0, 'loss to layer');
      assert.ok(await losses.locator('td:has-text("300,000")').count() > 0, 'reinstatement premium');

      await losses.locator('button:has-text("Shares")').click();
      await broker.waitForTimeout(400);
      // Alpha signs 60% → owes 900k recovery and 180k RIP.
      assert.ok(await losses.locator('td:has-text("900,000")').count() > 0, 'market recovery share');
      assert.ok(await losses.locator('td:has-text("180,000")').count() > 0, 'market RIP share');

      await losses.locator('button:has-text("Settle")').click();
      await broker.waitForSelector('section:has-text("Treaty losses") >> text=Settled');
    });

    await step('dashboard shows brokerage earned', async () => {
      await goHub(broker, 'Dashboard');
      await broker.waitForSelector('text=Brokerage earned');
      // The e2e database accumulates across runs, so assert the KPI carries a
      // real figure rather than a specific total.
      // Wait until the fetch resolves and the KPI carries a real figure.
      await broker.waitForFunction(() => {
        const kpi = [...document.querySelectorAll('.kpi')]
          .find((e) => e.textContent.includes('Brokerage earned'));
        return kpi && /[1-9]/.test(kpi.querySelector('.kpi-value')?.textContent || '');
      }, { timeout: 15000 });
    });
  } finally {
    await browser.close();
  }
  return errors;
}
