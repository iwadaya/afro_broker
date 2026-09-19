// Dynamic financial analysis: the eight-stage what-if desk, independent of any
// one placement. Arriving asks what to model — a standalone book, one
// contract, or the whole portfolio; the verdict strip leads on every stage;
// a contract runs by itself; an edit to the proposed programme marks the
// standing run as stale until it is run again; a quota share draws on the
// tower and a scan traces variants on the frontier; a longer horizon adds
// the surplus path; a domicile reads the capital against its country's
// regime on 05 and in the verdict; 07 Scenarios lists the Handbook's cases
// and reads each against the base case; 08 Structuring tests every family
// across a range of retentions on one button, reads them against the
// appetite, adopts the pick as the proposed programme and prints a
// one-pager; the scope and the stage survive a reload; a standalone book
// runs once its premium is typed; and the whole portfolio is one click
// away, said to be an approximation.
import assert from 'node:assert/strict';
import { launch, login, makeStep, goHub } from './lib.mjs';

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  console.log('dfa: the eight-stage what-if desk');

  try {
    const broker = await login(browser, 'broker', errors);
    // A stage tab by its label alone. The state under a label is text too —
    // "cheaper than capital" under 04 Impact would otherwise answer for 05
    // Capital — so only the label span is matched, and exactly.
    const exact = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    const tab = (label) => broker.locator('[role=tab]', { has: broker.locator('.tab-label', { hasText: exact(label) }) }).first();
    const verdict = broker.locator('[data-testid="dfa-verdict"]');
    // A run that has landed: the stale note is gone and the verdict is on screen.
    const ran = async (timeout = 120000) => {
      await broker.waitForSelector('[data-testid="dfa-running"]', { state: 'detached', timeout });
      await broker.waitForSelector('[data-testid="dfa-stale"]', { state: 'detached', timeout });
      await verdict.waitFor({ timeout });
    };

    await step('the desk opens from the hub asking what to model, with the three scopes', async () => {
      await goHub(broker, 'Dynamic financial analysis');
      await broker.waitForSelector('[data-testid="dfa-head"]');
      await broker.waitForSelector('[data-testid="dfa-choose"]');
      await broker.waitForSelector('[data-testid="dfa-scopes"]');
      for (const s of ['standalone', 'contract', 'portfolio']) {
        assert.ok(await broker.locator(`[data-testid="dfa-scope-${s}"]`).isVisible(), `the ${s} scope`);
      }
      assert.ok(await broker.locator('[data-testid="dfa-run"]').isDisabled(), 'nothing to run yet');
      const strip = await broker.locator('.dfa-tabs').innerText();
      for (const s of ['01', 'Scope', '02', 'Programme', '03', 'Assumptions', '04', 'Impact', '05', 'Capital', '06', 'Covers & panel', '07', 'Scenarios', '08', 'Structuring']) {
        assert.ok(strip.includes(s), `stage ${s} on the spine`);
      }
    });

    await step('one contract: picked from the book, it runs by itself and leads with the verdict', async () => {
      await broker.click('[data-testid="dfa-scope-contract"]');
      // Without a working placement to suggest, the picker opens; pick the first.
      if (!/scope=contract/.test(broker.url())) {
        const pick = broker.locator('[data-testid="dfa-contract-pick"]');
        await pick.waitFor();
        const first = await pick.locator('option[value]:not([value=""])').first().getAttribute('value');
        await pick.selectOption(first);
      }
      await broker.waitForURL(/scope=contract&placements=[0-9a-f-]{36}|placements=[0-9a-f-]{36}/, { timeout: 15000 });
      await ran();
      assert.match(await verdict.innerText(), /programme/, 'the verdict names the programme');
      assert.equal(await broker.locator('[data-testid="dfa-facts"] .dfa-fact').count(), 5, 'five headline figures');
      assert.ok(!(await broker.locator('.dfa-tabs').innerText()).toUpperCase().includes('NOT RUN'), 'the result stages have a run to read');
      await broker.waitForSelector('[data-testid="dfa-contract"] .dfa-deflist');
    });

    await step('01 Scope: the loss model in sentences, its fields behind one button', async () => {
      await broker.waitForSelector('[data-testid="dfa-model"]');
      assert.equal(await broker.locator('[data-testid="dfa-model-fields"]').count(), 0, 'the calibration fields stay folded');
      await broker.click('[data-testid="dfa-adjust"]');
      await broker.waitForSelector('[data-testid="dfa-model-fields"]');
      assert.ok(await broker.locator('[data-testid="dfa-model-fields"] input').count() >= 12, 'every calibration figure is editable');
    });

    await step('02 Programme: an edit marks the run stale on the strip and the result stages; running clears it', async () => {
      await tab('Programme').click();
      await broker.waitForSelector('[data-testid="dfa-proposed"]');
      assert.equal(await broker.locator('[data-testid="dfa-stale"]').count(), 0, 'nothing edited yet');
      if (await broker.locator('[data-testid="dfa-proposed"] .dfa-layers tbody input[aria-label$="attachment"]').count() === 0) {
        await broker.click('[data-testid="dfa-proposed-add"]');
        const row = broker.locator('[data-testid="dfa-proposed"] .dfa-layers tbody tr').first();
        await row.locator('input[aria-label$="limit"]').fill('5000000');
      }
      const first = broker.locator('[data-testid="dfa-proposed"] .dfa-layers tbody tr').first();
      await first.locator('input[aria-label$="attachment"]').fill('7500000');
      await broker.waitForSelector('[data-testid="dfa-stale"]');
      assert.ok((await tab('Impact').innerText()).toUpperCase().includes('RUN NEEDED'), 'the result stages say a run is needed');
      await tab('Impact').click();
      await broker.waitForSelector('[data-testid="dfa-stalebar"]');
      await tab('Programme').click();
      await broker.click('[data-testid="dfa-run"]');
      await ran();
      assert.ok((await verdict.innerText()).startsWith('The proposed programme'), 'the verdict now reads the proposed programme');
    });

    await step('a quota share draws on the tower, and a scan traces variants on the frontier', async () => {
      await broker.locator('[data-testid="dfa-proposed-qs"]').check();
      await broker.waitForSelector('[data-testid="dfa-proposed"] .dfa-tower-qs');
      await broker.selectOption('[data-testid="dfa-scan"]', 'cession');
      await broker.click('[data-testid="dfa-run"]');
      await ran();
      await tab('Impact').click();
      await broker.waitForSelector('[data-testid="dfa-impact-table"]');
      assert.ok(await broker.locator('.dfa-fdot.dfa-f-variant').count() >= 3, 'the variants are on the frontier');
      assert.ok(await broker.locator('[data-testid="dfa-economics"]').isVisible(), 'the economics table is on the stage');
    });

    await step('03 Assumptions: a three-year horizon adds the surplus path to 05 Capital', async () => {
      await tab('Assumptions').click();
      await broker.waitForSelector('[data-testid="dfa-horizon"]');
      await broker.selectOption('[data-testid="dfa-horizon"]', '3');
      await broker.click('[data-testid="dfa-run"]');
      await ran(180000);
      await tab('Capital').click();
      await broker.waitForSelector('[data-testid="dfa-horizon-table"]');
      assert.ok(await broker.locator('[data-testid="dfa-capital-bars"]').isVisible(), 'the capital bars');
      assert.equal(await broker.locator('[data-testid="dfa-horizon-table"] tbody tr').count(), 4, 'three years and the total');
    });

    await step('03 Assumptions: a domicile reads the capital against its regime, on 05 and in the verdict', async () => {
      await tab('Assumptions').click();
      await broker.waitForSelector('[data-testid="dfa-domicile"]');
      // The cedant's domicile seeds the picker; the United States is NAIC RBC.
      await broker.selectOption('[data-testid="dfa-domicile"]', 'US');
      // The card keeps the seeded domicile's regime on screen while the US one
      // loads, so wait for the RBC family badge rather than for the card alone.
      await broker.waitForSelector('[data-testid="dfa-regime-card"] .dfa-badge.fam-rbc');
      const card = await broker.locator('[data-testid="dfa-regime-card"]').innerText();
      assert.ok(/Risk-based capital/i.test(card), 'the regime family is on the card');
      assert.ok(/Company Action Level/.test(card), 'the ladder is on the card');
      assert.ok(await broker.locator('[data-testid="dfa-regime-card"] [data-testid="dfa-ladder"] tbody tr').count() >= 4, 'the ladder’s rungs');
      await broker.waitForSelector('[data-testid="dfa-stale"]');
      await broker.click('[data-testid="dfa-run"]');
      await ran(180000);
      assert.match(await broker.locator('[data-testid="dfa-verdict-regime"]').innerText(), /RBC ratio/, 'the verdict reads the ratio');
      await tab('Capital').click();
      await broker.waitForSelector('[data-testid="dfa-regime"]');
      assert.equal(await broker.locator('[data-testid="dfa-regime"] .dfa-regime-table tbody tr').count(), 3, 'gross, current and proposed on the ladder');
      assert.ok(await broker.locator('[data-testid="dfa-monitors"]').isVisible(), 'the monitors');
      assert.ok((await tab('Capital').innerText()).toUpperCase().includes('RBC RATIO'), 'the stage says the ratio');
    });

    await step('07 Scenarios: the Handbook’s cases beside the base case, one turned off and re-run', async () => {
      await tab('Scenarios').click();
      await broker.waitForSelector('[data-testid="dfa-scenario-chooser"]');
      await broker.waitForSelector('[data-testid="dfa-scenarios-table"]');
      const rows = () => broker.locator('[data-testid="dfa-scenarios-table"] tbody tr').count();
      const before = await rows();
      assert.ok(before >= 3, 'the base case and the scenarios');
      await broker.waitForSelector('[data-testid="dfa-scenario-base"]');
      assert.ok(/Standing|Holds|Strained|Breach/.test(await broker.locator('[data-testid="dfa-scenarios-table"]').innerText()), 'each scenario has a standing');
      await broker.locator('[data-testid="dfa-scenario-on-favourable"]').uncheck();
      await broker.waitForSelector('[data-testid="dfa-stale"]');
      await broker.click('[data-testid="dfa-run"]');
      await ran(180000);
      assert.equal(await rows(), before - 1, 'one scenario fewer');
      assert.match(await broker.locator('[data-testid="dfa-verdict-scenarios"]').innerText(), /stress scenarios/, 'the verdict counts the scenarios');
    });

    await step('08 Structuring: the appetite and the grid, then every structure tested on one button', async () => {
      await tab('Structuring').click();
      await broker.waitForSelector('[data-testid="dfa-appetite"]');
      await broker.waitForSelector('[data-testid="dfa-grid"]');
      assert.ok((await tab('Structuring').innerText()).toUpperCase().includes('NOT TESTED'), 'nothing tested yet');
      assert.equal(await broker.locator('[data-testid="dfa-appetite"] input[type=number]').count(), 5, 'the five lines of the appetite');
      for (const f of ['xol', 'quota_share', 'surplus', 'blend']) {
        assert.ok(await broker.locator(`[data-testid="dfa-family-${f}"]`).isChecked(), `the ${f} family is on`);
      }
      // Three steps a family keep the test quick: twelve programmes.
      await broker.fill('[data-testid="dfa-grid-steps"]', '3');
      assert.match(await broker.locator('[data-testid="dfa-grid"] .hint').innerText(), /12 programmes/, 'the grid counts its programmes');
      await broker.click('[data-testid="dfa-sweep"]');
      await broker.waitForSelector('[data-testid="dfa-decision-sentence"]', { timeout: 240000 });
      await broker.waitForFunction(() => !document.querySelector('[data-testid="dfa-sweep"]').textContent.startsWith('Testing'), null, { timeout: 240000 });
      assert.equal(await broker.locator('[data-testid="dfa-candidate"]').count(), 12, 'every programme tested is in the table');
      assert.ok(await broker.locator('[data-testid="dfa-candidate-ref"]').count() >= 1, 'the current programme is a reference row');
      assert.ok(await broker.locator('[data-testid="dfa-frontier"] .dfa-sdot').count() >= 14, 'every programme and the references are on the frontier');
      assert.equal(await broker.locator('[data-testid="dfa-decision"] .dfa-famrange').count(), 4, 'a range a family');
      assert.equal(await broker.locator('[data-testid="dfa-stress-row"]').count(), 3, 'the three stresses');
      assert.match((await tab('Structuring').innerText()).toUpperCase(), /\d+ OF 12 FIT/, 'the stage counts what fits');
      assert.match(await broker.locator('[data-testid="dfa-verdict-structuring"]').innerText(), /of 12 programmes tested/, 'the verdict strip reads the test');
      assert.ok(await broker.locator('[data-testid="dfa-range-cr"]').isVisible(), 'the outcome range of the pick');
      assert.ok(await broker.locator('[data-testid="dfa-tests"]').isVisible(), 'the appetite line by line');
    });

    await step('08 Structuring: a programme clicked reads below, the one-pager opens, the pick adopted runs the desk', async () => {
      const second = broker.locator('[data-testid="dfa-candidate"]').nth(1);
      const label = (await second.locator('.dfa-cover-name').innerText()).replace(/\s+(the pick|efficient)/g, '').trim();
      await second.click();
      await broker.waitForFunction((l) => document.querySelector('[data-testid="dfa-outcomes"]')?.textContent.includes(l), label, { timeout: 10000 });
      await broker.click('[data-testid="dfa-onepager-open"]');
      await broker.waitForSelector('[data-testid="dfa-onepager"]');
      assert.match(await broker.locator('[data-testid="dfa-onepager"]').innerText(), /renewal brief/i, 'the one-pager is the renewal brief');
      assert.ok(await broker.locator('[data-testid="dfa-onepager-print"]').isVisible(), 'it prints');
      await broker.click('[data-testid="dfa-onepager-close"]');
      await broker.waitForSelector('[data-testid="dfa-onepager"]', { state: 'detached' });
      const adopt = broker.locator('[data-testid="dfa-adopt"]');
      const pick = (await adopt.innerText()).replace(/^Use /, '').replace(/ as the proposed programme$/, '');
      await adopt.click();
      await ran(240000);
      assert.ok((await verdict.innerText()).startsWith('The proposed programme'), 'the desk runs on the adopted programme');
      const programmeHint = await tab('Programme').innerText();
      assert.ok(/XOL|QS|SURPLUS/.test(programmeHint.toUpperCase()), `02 Programme now describes the pick (${pick}): ${programmeHint}`);
      // An edit marks the test stale, like the run.
      await broker.fill('[data-testid="dfa-appetite-max_ruin_pct"]', '1');
      await broker.waitForSelector('[data-testid="dfa-sweepbar"]');
      assert.ok((await tab('Structuring').innerText()).toUpperCase().includes('TEST NEEDED'), 'the stage says a test is needed');
    });

    await step('06 Covers & panel reads each cover, and the other side of the slip', async () => {
      await tab('Covers & panel').click();
      await broker.waitForSelector('[data-testid="dfa-covers-proposed"]');
      assert.ok(await broker.locator('[data-testid="dfa-covers-proposed"] tbody tr').count() >= 1, 'a cover row');
      assert.ok(await broker.locator('[data-testid="dfa-reinsurer"]').isVisible(), 'the reinsurers’ side');
      assert.ok(await broker.locator('[data-testid="dfa-panel"]').isVisible(), 'the panel');
    });

    await step('the scope and the stage survive a reload', async () => {
      const url = broker.url();
      assert.match(url, /tab=covers/, 'the stage is in the URL');
      assert.match(url, /placements=/, 'the scope is in the URL');
      await broker.reload({ waitUntil: 'networkidle' });
      await broker.waitForSelector('[data-testid="dfa-covers-proposed"]', { timeout: 120000 });
      assert.equal(broker.url(), url, 'same URL after the reload');
    });

    await step('a standalone book: nothing read from the register, runs once its premium is typed', async () => {
      await tab('Scope').click();
      await broker.click('[data-testid="dfa-scope-standalone"]');
      await broker.waitForSelector('[data-testid="dfa-needs-premium"]');
      await broker.waitForSelector('[data-testid="dfa-standalone"]');
      assert.ok(await broker.locator('[data-testid="dfa-run"]').isDisabled(), 'no premium, nothing to run');
      assert.ok((await tab('Scope').innerText()).toUpperCase().includes('STANDALONE'), 'the stage says standalone');
      await broker.fill('[data-testid="dfa-ccy"]', 'USD');
      await broker.fill('[data-testid="dfa-cal-subject_premium"]', '50000000');
      await broker.waitForFunction(() => !document.querySelector('[data-testid="dfa-run"]').disabled);
      await broker.click('[data-testid="dfa-run"]');
      await ran();
      assert.match(await verdict.innerText(), /carries no reinsurance/, 'a blank programme runs gross');
      assert.match(await verdict.innerText(), /USD/, 'the typed currency is on the figures');
      // A layer on the proposed programme, priced by the model, changes the verdict.
      await tab('Programme').click();
      await broker.waitForSelector('[data-testid="dfa-proposed"]');
      await broker.click('[data-testid="dfa-proposed-add"]');
      const row = broker.locator('[data-testid="dfa-proposed"] .dfa-layers tbody tr').first();
      await row.locator('input[aria-label$="limit"]').fill('10000000');
      await row.locator('input[aria-label$="attachment"]').fill('10000000');
      await broker.click('[data-testid="dfa-run"]');
      await ran();
      assert.ok((await verdict.innerText()).startsWith('The proposed programme'), 'the verdict reads the proposed programme');
      assert.match(broker.url(), /scope=standalone/, 'the scope is in the URL');
    });

    await step('the whole portfolio is one click away, and 02 says it is an approximation', async () => {
      await tab('Scope').click();
      await broker.click('[data-testid="dfa-scope-portfolio"]');
      await broker.waitForURL(/scope=portfolio/, { timeout: 15000 });
      await ran(240000);
      const ticked = await broker.locator('[data-testid="dfa-portfolio"] input[type=checkbox]:checked').count();
      assert.ok(ticked >= 1, 'the portfolio is ticked');
      if (ticked > 1) {
        await tab('Programme').click();
        await broker.waitForSelector('.dfa-warn:has-text("approximation")');
      }
    });
  } finally {
    await browser.close();
  }
  return errors;
}
