// Finalization features: shaped experience (UW-year / large losses / risk
// profile), client signing instruction, brokerage, the MDP account prepared
// and independently approved in the Premium workspace (its debit notes and
// settlement), and treaty losses with reinstatement premium.
import assert from 'node:assert/strict';
import { launch, login, makeStep, goHub, buildLayerToFotAuthorised, BASE } from './lib.mjs';

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

/** Call the API as the signed-in page's user (register setup, not the test). */
async function apiCall(page, method, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const r = await fetch(`/api${p}`, {
      method: m,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${localStorage.getItem('ub_token')}`,
      },
      body: b === null ? undefined : JSON.stringify(b),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${m} ${p} -> ${r.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  }, [method, path, body ?? null]);
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

      await broker.goto(`${BASE}/placements/${placementId}`, { waitUntil: 'networkidle' });
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

    await step('the layer card sends MDP to the Premium workspace: no issue form on the layer page', async () => {
      await broker.goto(layerUrl, { waitUntil: 'networkidle' });
      const mdp = broker.locator('section.card:has-text("minimum & deposit premium")');
      await mdp.locator('a:has-text("Open Premium workspace")').waitFor({ timeout: 10000 });
      assert.equal(await mdp.locator('input[type=number]').count(), 0, 'no issue form on the layer page');
      assert.equal(await mdp.locator('button:has-text("Issue MDP")').count(), 0, 'no Issue MDP button');
    });

    await step('prepare the MDP account in the Premium workspace → 2 markets × 4 instalments, submitted for review', async () => {
      // Every note goes to a reinsurer's registered contact, so each market
      // with a signed line gets one unless the register already has it (the
      // e2e database accumulates across runs) — register setup, not the test.
      const source = await apiCall(broker, 'GET', `/premium/contracts/${placementId}`);
      for (const line of source.layers[0].lines) {
        if (source.contacts.some((c) => c.market_id === line.market_id)) continue;
        await apiCall(broker, 'POST', `/markets/${line.market_id}/contacts`, {
          name: `${line.market_name} accounts`,
          email: `${line.market_name.replace(/\W+/g, '.').toLowerCase()}@example.test`,
          is_primary: true,
        });
      }

      // The workspace opens on the question — which contract? — asked as
      // country, then cedant, then contract.
      await broker.goto(`${BASE}/claims-premiums/non-proportional/premium`, { waitUntil: 'networkidle' });
      const picker = broker.locator('[data-testid="servicing-contract-picker"]');
      await picker.waitFor({ timeout: 15000 });
      await picker.locator('#sv-pick-country').selectOption('GB');
      await picker.locator('#sv-pick-cedant').selectOption(`Cedant ${tag}`);
      await picker.locator('#sv-pick-contract').selectOption(placementId);
      await picker.locator('button:has-text("Open contract")').click();
      await broker.waitForSelector(`.pw-treaty-heading:has-text("Cedant ${tag}")`, { timeout: 15000 });

      // The signed shares behind the account: 60 / 40 as instructed, not normalised.
      const shares = broker.locator('section.pw-panel:has-text("The shares behind the account")');
      await shares.locator('td:has-text("60%")').first().waitFor();
      assert.ok(await shares.locator('td:has-text("40%")').count() > 0, 'Beta signed 40%');

      // Terms at 100%. The deposit is entered, never assumed from the quoted
      // premium; brokerage, the schedule and the first due date come from the
      // layer and the placement.
      const term = (label) => broker.locator(`input[aria-label="Layer 1 ${label}"]`);
      await term('Minimum premium').fill('320000');
      await term('Deposit premium').fill('360000');
      assert.equal(await term('Brokerage %').inputValue(), '2.5', 'brokerage read from the layer');
      assert.equal(await term('Instalments').inputValue(), '4', 'four instalments');
      assert.equal(await term('Every (months)').inputValue(), '3', 'quarterly');
      assert.equal(await term('due date').inputValue(), '2026-01-01', 'first due at inception');
      // A reinsurer with one registered contact has its recipient pre-selected;
      // one with several is asked.
      const recipients = broker.locator('.pw-recipient-grid select');
      assert.equal(await recipients.count(), 2, 'a recipient per reinsurer');
      for (let i = 0; i < 2; i += 1) {
        const recipient = recipients.nth(i);
        if (!(await recipient.inputValue())) await recipient.selectOption({ index: 1 });
        assert.notEqual(await recipient.inputValue(), '', 'a recipient for every reinsurer');
      }

      await broker.click('button:has-text("Calculate accounts")');
      await broker.waitForSelector('.pw-notice:has-text("Calculated from the signed lines")');
      // 360k deposit: Alpha 60% → 4 × 54,000 (52,650 net of 2.5% brokerage),
      // Beta 40% → 4 × 36,000 (35,100 net); 351,000 due in all.
      const review = broker.locator('section.pw-panel:has-text("Review every amount")');
      assert.equal(await review.locator('tbody tr').count(), 8, '8 debit notes: 2 markets × 4 instalments');
      assert.equal(await review.locator('td:has-text("54,000")').count(), 4, 'Alpha instalments');
      assert.equal(await review.locator('td:has-text("36,000")').count(), 4, 'Beta instalments');
      assert.equal(await review.locator('td:has-text("52,650")').count(), 4, 'Alpha net of brokerage');
      assert.equal(await review.locator('td:has-text("35,100")').count(), 4, 'Beta net of brokerage');
      await review.locator('.pw-total-pills b:has-text("351,000")').waitFor();

      await broker.click('button:has-text("Save draft")');
      await broker.waitForSelector('.pw-notice:has-text("Draft saved")');
      // Four eyes: the preparer names a different approver and submits a locked account.
      await broker.selectOption('select[aria-label="Independent approver"]', { label: 'Demo Underwriter · underwriter' });
      await broker.click('button:has-text("Approve & submit")');
      await broker.waitForSelector('.pw-notice:has-text("Submitted to the selected approver")');
      await broker.waitForSelector('text=Awaiting the second pair of eyes', { timeout: 10000 });
      assert.equal(await broker.locator('button:has-text("Approve, issue & email")').count(), 0, 'the preparer cannot approve their own account');
    });

    await step('independent approval issues the 8 numbered notes; the preparer records a settlement', async () => {
      await uw.goto(`${BASE}/claims-premiums/non-proportional/premium?contract=${placementId}`, { waitUntil: 'networkidle' });
      await uw.click('button:has-text("Approve, issue & email")');
      await uw.waitForSelector('.pw-notice:has-text("Approved. Notes were issued")', { timeout: 30000 });
      const issued = uw.locator('section.pw-panel:has-text("Issued accounts")');
      await issued.waitFor({ timeout: 15000 });
      assert.equal(await issued.locator('tbody tr').count(), 8, '8 issued notes');
      assert.equal(await issued.locator('td:has-text("PIQ-")').count(), 8, 'every note is numbered');
      await issued.locator('button:has-text("Download PDF")').first().waitFor();

      // Settlement is recorded by the preparer or the approver; here the preparer.
      await broker.goto(`${BASE}/claims-premiums/non-proportional/premium?contract=${placementId}`, { waitUntil: 'networkidle' });
      const mine = broker.locator('section.pw-panel:has-text("Issued accounts")');
      await mine.waitFor({ timeout: 15000 });
      assert.equal(await mine.locator('button:has-text("Record as settled")').count(), 8, 'all 8 outstanding');
      await mine.locator('button:has-text("Record as settled")').first().click();
      await broker.waitForSelector('.pw-notice:has-text("Settlement recorded")');
      await mine.locator('.pw-delivery.sent:has-text("Settled")').first().waitFor();
      assert.equal(await mine.locator('button:has-text("Record as settled")').count(), 7, 'one settled, seven outstanding');
    });

    await step('advise + calculate loss → shares and reinstatement premium', async () => {
      await broker.goto(`${BASE}/placements/${placementId}`, { waitUntil: 'networkidle' });
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
