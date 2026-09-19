// Secondary actions: admin role-gating, portfolio and market intelligence, the market register (tabs, filters,
// counterparty detail), subjectivities, line decline, undersubscription
// (accept-shortfall), and document generation/view.
import assert from 'node:assert/strict';
import { BASE, launch, login, makeStep, goHub, buildLayerToFotAuthorised } from './lib.mjs';

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `feat-${Date.now()}`;
  console.log('features: admin / register / subjectivities / decline / shortfall / docs');

  try {
    const broker = await login(browser, 'broker', errors);
    const uw = await login(browser, 'uw', errors);

    await step('admin nav role-gating', async () => {
      // Admin lives in the top bar's account menu, for an admin or underwriter only.
      assert.equal(await broker.locator('.launcher >> text=Admin').count(), 0, 'broker has no Admin pill');
      await broker.click('.topbar-account');
      await broker.waitForSelector('.account-menu');
      assert.equal(await broker.locator('.account-menu >> text=Admin').count(), 0, 'broker must not see Admin');
      await broker.keyboard.press('Escape');
      await goHub(uw, 'Admin');
      await uw.waitForSelector('text=Audit trail');
      await uw.waitForSelector('text=Pending approvals');
    });

    await step('portfolio intelligence: the calendar\'s neighbour in the top bar', async () => {
      // The top bar carries it beside the renewal calendar.
      await broker.click('.topbar-portfolio');
      await broker.waitForSelector('h2:has-text("Portfolio intelligence")', { timeout: 10000 });
      // Who is leading: the seeded book's lead reinsurers, with their accounts.
      await broker.waitForSelector('table >> text=Swiss Re', { timeout: 10000 });
      assert.ok(await broker.locator('.pi-chip:has-text("GRV-27-PROP-CAT")').count() > 0, 'the GRV renewal sits under its lead');
      // Who is placing: this desk, and the other houses recorded at Final Placement.
      await broker.waitForSelector('text=Guy Carpenter');
      assert.ok(await broker.locator('.pill:has-text("this desk")').count() > 0, 'the house is marked as this desk');
      // The accounts table narrows to the ones another house leads.
      await broker.click('.tabs >> text="We follow"');
      await broker.waitForTimeout(300);
      assert.ok(await broker.locator('table.renewal-cal >> text=BOOK-27-030').count() > 0, 'a followed account is listed');
      assert.equal(await broker.locator('table.renewal-cal >> text=GRV-27-PROP-CAT').count(), 0, 'a led account is not');
      // And back across to the calendar.
      await broker.click('a:has-text("Renewal calendar")');
      await broker.waitForSelector('h2:has-text("Renewal calendar")', { timeout: 10000 });
      await broker.click('a:has-text("Portfolio intelligence")');
      await broker.waitForSelector('h2:has-text("Portfolio intelligence")', { timeout: 10000 });
      // Home in the top bar returns to the dashboard from any page.
      await broker.click('.topbar-home');
      await broker.waitForSelector('h2:has-text("Treaty renewal book")', { timeout: 10000 });
      assert.ok(/\/$/.test(broker.url()), 'home lands on the dashboard');
    });

    await step('programme analysis: the portfolio\'s "Analyse programmes" button, charts by broker and reinsurer', async () => {
      await broker.goto(`${BASE}/portfolio`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('h2:has-text("Portfolio intelligence")', { timeout: 10000 });
      await broker.click('[data-testid=pi-analyse-programmes]');
      await broker.waitForSelector('h2:has-text("Programme analysis")', { timeout: 10000 });
      assert.ok(/\/portfolio\/programmes$/.test(broker.url()), 'the button opens the analysis');
      // Who places: a bar per house, this desk first. Who writes: a bar per reinsurer.
      await broker.waitForSelector('[data-testid=pa-brokers] .viz-hbar', { timeout: 10000 });
      const firstBar = await broker.locator('[data-testid=pa-brokers] .viz-hbar').first().getAttribute('aria-label');
      assert.ok(firstBar.startsWith('Universe Broking'), 'this desk leads the broker chart');
      assert.ok(await broker.locator('[data-testid=pa-brokers] .viz-hrow:has-text("Guy Carpenter")').count() > 0, 'the other house has a bar');
      assert.ok(await broker.locator('[data-testid=pa-reinsurers] .viz-hrow:has-text("Hannover Re")').count() > 0, 'a writing reinsurer has a bar');
      // The grid crosses the two: a column per house, a row per reinsurer.
      assert.ok(await broker.locator('[data-testid=pa-grid] th:has-text("Guy Carpenter")').count() > 0, 'the grid has a column per house');
      assert.ok(await broker.locator('[data-testid=pa-grid] th:has-text("Hannover Re")').count() > 0, 'and a row per reinsurer');
      // One measure toggle re-scales every chart to premium, and back.
      await broker.click('.pa-measure >> text="Premium (100%)"');
      await broker.waitForSelector('.viz-title:has-text("Premium by broker")', { timeout: 5000 });
      await broker.click('.pa-measure >> text="Programmes"');
      await broker.waitForSelector('.viz-title:has-text("Programmes by broker")', { timeout: 5000 });
      // Clicking a house narrows the programme table to the programmes it leads.
      await broker.click('[data-testid=pa-brokers] .viz-hrow:has-text("Guy Carpenter") .viz-hbar');
      await broker.waitForSelector('.pa-filterchip:has-text("Guy Carpenter")', { timeout: 5000 });
      assert.ok(await broker.locator('table.pa-programmes >> text=BOOK-27-025').count() > 0, 'the programme that house leads is listed');
      assert.equal(await broker.locator('table.pa-programmes >> text=GRV-27-PROP-CAT').count(), 0, 'one this desk leads is not');
      await broker.click('button:has-text("Show all")');
      await broker.waitForSelector('table.pa-programmes >> text=GRV-27-PROP-CAT', { timeout: 5000 });
      // Every chart carries its figures in numbers.
      await broker.click('[data-testid=pa-reinsurers] summary');
      await broker.waitForSelector('[data-testid=pa-reinsurers] table >> text=Hannover Re', { timeout: 5000 });
      // And back to the portfolio.
      await broker.click('a:has-text("Portfolio intelligence")');
      await broker.waitForSelector('h2:has-text("Portfolio intelligence")', { timeout: 10000 });
    });

    await step('market intelligence: the portfolio\'s button, a market by country, a trip with its return, a note, an honest gather', async () => {
      await broker.goto(`${BASE}/portfolio`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('h2:has-text("Portfolio intelligence")', { timeout: 10000 });
      await broker.click('[data-testid=pi-market-intelligence]');
      await broker.waitForSelector('h2:has-text("Market intelligence")', { timeout: 10000 });
      assert.ok(/\/portfolio\/market-intelligence$/.test(broker.url()), 'the button opens the screen');
      // The map: every region of the reference list, the seeded book's countries beneath.
      await broker.waitForSelector('[data-testid=mi-map] tr.is-region:has-text("Europe")', { timeout: 10000 });
      assert.ok(await broker.locator('[data-testid=mi-map] tr.is-country:has-text("United Kingdom")').count() > 0, 'the UK, with accounts on the book, sits under Europe');
      // Pick the United Kingdom: the scope goes into the URL and the book narrows to it.
      await broker.selectOption('[data-testid=mi-region]', { label: 'Europe' });
      await broker.waitForSelector('[data-testid=mi-brief]', { timeout: 10000 });
      await broker.selectOption('[data-testid=mi-country]', { label: 'United Kingdom' });
      await broker.waitForSelector('[data-testid=mi-book] >> text=Grievous Mutual', { timeout: 10000 });
      assert.ok(broker.url().includes('country=GB'), 'the country is in the URL');
      // Log a trip: the seeded 1 Jan 2027 renewal incepts inside the year after it, so it has a return.
      await broker.click('[data-testid=mi-add-trip]');
      const vf = broker.locator('[data-testid=mi-visit-form]');
      await vf.locator('input[type=date]').nth(0).fill('2026-10-05');
      await vf.locator('input[type=date]').nth(1).fill('2026-10-08');
      await vf.locator('input[type=number]').fill('8000');
      await vf.locator('input[placeholder^="Renewal roadshow"]').fill(`Renewal roadshow ${tag}`);
      await vf.locator('.mi-cedant-pick label:has-text("Grievous Mutual") input').check();
      await vf.locator('button:has-text("Log trip")').click();
      await broker.waitForSelector(`[data-testid=mi-visits] table >> text=Renewal roadshow ${tag}`, { timeout: 10000 });
      const row = broker.locator(`[data-testid=mi-visits] table tbody tr:has-text("Renewal roadshow ${tag}")`);
      assert.ok(await row.locator('text=Demo Broker').count() > 0, 'the trip is the signed-in broker\'s');
      assert.ok(await row.locator('text=Grievous Mutual').count() > 0, 'the cedant met is named');
      const roi = await broker.locator('[data-testid=mi-kpi-roi] .kpi-value').textContent();
      assert.ok(/^\+/.test(roi), `the trip's return is read from the book's brokerage (${roi})`);
      // Keep a note on the cedant: it appears with its scope.
      await broker.click('[data-testid=mi-add-note]');
      const nf = broker.locator('[data-testid=mi-note-form]');
      await nf.locator('select[aria-label="Note level"]').selectOption('cedant');
      await nf.locator('select[aria-label="Cedant"]').selectOption({ label: 'Grievous Mutual — United Kingdom' });
      await nf.locator('textarea[aria-label="Note text"]').fill(`Retention moving up to 15m ${tag}`);
      await nf.locator('button:has-text("Keep note")').click();
      await broker.waitForSelector(`[data-testid=mi-notes] .mi-note:has-text("Retention moving up to 15m ${tag}")`, { timeout: 10000 });
      const card = broker.locator(`[data-testid=mi-notes] .mi-note:has-text("Retention moving up to 15m ${tag}")`);
      assert.ok(await card.locator('.pill:has-text("cedant")').count() > 0, 'the note is on the cedant');
      assert.ok(await card.locator('text=Grievous Mutual').count() > 0, 'and names it');
      // With no AI provider configured the brief says so up front, offers the gather
      // all the same, and stays empty rather than invented. (A gather here would be
      // an honest 503, which the browser logs as a console error and this harness
      // counts as a failure; the API test covers that path.)
      assert.ok(await broker.locator('[data-testid=mi-brief] .viz-note:has-text("No AI provider is configured")').count() > 0, 'no key: the brief says so');
      assert.equal(await broker.locator('[data-testid=mi-gather]').count(), 1, 'the gather is offered to a broker');
      assert.equal(await broker.locator('[data-testid=mi-brief-empty]').count(), 1, 'and there is no brief');
      // The whole region reads the same trip, and the cedant's note rolls up into it.
      await broker.selectOption('[data-testid=mi-country]', { label: 'Whole region — Europe' });
      await broker.waitForSelector(`[data-testid=mi-visits] table >> text=Renewal roadshow ${tag}`, { timeout: 10000 });
      assert.ok(await broker.locator(`[data-testid=mi-notes] .mi-note:has-text("${tag}")`).count() > 0, 'the cedant\'s note rolls up into its region');
      // And back to the portfolio.
      await broker.click('a:has-text("Portfolio intelligence")');
      await broker.waitForSelector('h2:has-text("Portfolio intelligence")', { timeout: 10000 });
    });

    await step('cedants page: the register of clients, with each country resolved', async () => {
      await broker.goto(`${BASE}/cedants`, { waitUntil: 'networkidle' });
      await broker.waitForSelector('h2:has-text("Cedants")', { timeout: 10000 });
      await broker.waitForSelector('table >> text=Grievous Mutual', { timeout: 10000 });
      // The stored "UK" reads as its reference name.
      assert.ok(await broker.locator('table >> text=United Kingdom').count() > 0, 'a domicile resolves to its country name');
      assert.equal(await broker.locator('text=not in the country list').count(), 0, 'every seeded domicile is on the list');
    });

    await step('market register: three tabs, filters, counterparty detail', async () => {
      await goHub(broker, 'Markets');
      await broker.waitForSelector('text=Market register');

      // Each tab shows only its own counterparty type.
      for (const [tab, seeded] of [['Reinsurers', 'Swiss Re'],
        ['Insurers', 'Grievous Mutual'], ['Brokers', 'Cornerstone Broking']]) {
        await broker.click(`.tabs >> text="${tab}"`);
        await broker.waitForSelector(`table >> text=${seeded}`, { timeout: 10000 });
      }

      // Filters narrow the list and survive as URL state.
      await broker.click('.tabs >> text="Reinsurers"');
      await broker.waitForSelector('table >> text=Swiss Re');
      const region = broker.locator('.filters label:has-text("Region") select');
      await region.selectOption({ label: 'EMEA' });
      await broker.waitForTimeout(500);
      assert.ok(broker.url().includes('region=EMEA'), 'filters go into the URL');
      assert.equal(await broker.locator('table >> text=Aspen Bermuda').count(), 0, 'Bermuda market filtered out');
      await broker.click('button:has-text("Clear")');
      await broker.waitForTimeout(400);

      // The reinsurer tab carries the lead/follow columns; the others do not.
      assert.ok(await broker.locator('th:has-text("Lead")').count() > 0);
      await broker.click('.tabs >> text="Brokers"');
      await broker.waitForTimeout(400);
      assert.equal(await broker.locator('th:has-text("Follow")').count(), 0);

      // Clicking through opens the counterparty: compliance + group summary.
      await broker.click('.tabs >> text="Reinsurers"');
      await broker.click('table a:has-text("Swiss Re")');
      await broker.waitForSelector('text=Compliance');
      await broker.waitForSelector('text=Group summary');
      await broker.waitForSelector('text=Five-year financials');
      assert.ok(await broker.locator('.gate:has-text("KYC")').count() > 0, 'KYC gate shown');
      assert.ok(await broker.locator('.gate:has-text("rating")').count() > 0, 'rating gate shown');

      // The group summary is writable by hand.
      const sf = broker.locator('section:has-text("Group summary") form');
      await sf.locator('textarea').first().fill('Top-three global reinsurer.');
      await sf.locator('button:has-text("Save summary")').click();
      await broker.waitForSelector('text=Top-three global reinsurer.', { timeout: 10000 });

      // Five-year financials accept a CSV upload.
      const ff = broker.locator('section:has-text("Five-year financials") form:has-text("CSV")');
      await ff.locator('textarea').fill('year,currency,gwp,combined_ratio\n2025,EUR,1000000,94.1\n2024,EUR,900000,96.5');
      await ff.locator('button:has-text("Upload financials")').click();
      await broker.waitForSelector('th:has-text("2025")', { timeout: 10000 });
      assert.ok(await broker.locator('td:has-text("94.1%")').count() > 0, 'combined ratio rendered');
    });

    await step('underwriter records a compliance review; broker cannot', async () => {
      await goHub(uw, 'Markets');
      await uw.waitForSelector('text=Market register');
      await uw.click('table a:has-text("Lancashire")');
      await uw.waitForSelector('text=Record a compliance review');
      const cf = uw.locator('section:has-text("Compliance") form');
      await cf.locator('select').first().selectOption('in_progress');
      await cf.locator('button:has-text("Save compliance")').click();
      await uw.waitForTimeout(900);
      assert.ok(
        await uw.locator('.gate:has-text("KYC") >> text=In progress').count() > 0,
        'the KYC gate reflects the review',
      );

      // A broker sees the file but cannot sign it off.
      await broker.goto(uw.url());
      await broker.waitForSelector('text=Group summary');
      assert.equal(await broker.locator('button:has-text("Save compliance")').count(), 0);
    });

    let layerUrl;
    let names;
    await step('build placement to authorised FOT (2 markets)', async () => {
      ({ layerUrl, names } = await buildLayerToFotAuthorised(broker, uw, { tag, premium: 500_000, markets: ['Lead', 'A'], rol: 0.04 }));
    });

    await step('capture quote, add + resolve subjectivity', async () => {
      const row = broker.locator('section:has-text("Quote board") table tbody tr').first();
      await row.locator('button:has-text("Quote")').click();
      const pop = broker.locator('.popover').first();
      await pop.locator('input[type=number]').nth(0).fill('0.04');
      await pop.locator('button:has-text("Capture")').click();
      await broker.waitForTimeout(400);
      await row.locator('button:has-text("Subj")').click();
      const sp = broker.locator('.popover').first();
      await sp.locator('input[placeholder="New subjectivity"]').fill('Signed MRC required');
      await sp.locator('button:has-text("Add")').click();
      await broker.waitForTimeout(300);
      await sp.locator('button:has-text("Resolve")').click();
      await broker.waitForTimeout(300);
      assert.ok(await sp.locator('text=Signed MRC required').count() > 0);
    });

    await step('write a line, decline another, accept-shortfall sign', async () => {
      await broker.reload();
      await broker.waitForSelector('text=Written lines');
      const write = async (label, pct) => {
        const lForm = broker.locator('section:has-text("Written lines") form');
        await lForm.locator('select').selectOption({ label });
        await lForm.locator('input[type=number]').fill(String(pct));
        await lForm.locator('button:has-text("Write line")').click();
        await broker.waitForTimeout(350);
      };
      await write(names[0], 60);
      await write(names[1], 80);
      const rows = broker.locator('section:has-text("Written lines") table tbody tr');
      await rows.nth(1).locator('button:has-text("Decline")').click();
      await broker.waitForTimeout(400);
      await broker.click('button:has-text("Apply (accept shortfall)")');
      await broker.waitForTimeout(600);
    });

    await step('generate + view documents', async () => {
      await broker.locator('section:has-text("Documents") button:has-text("Cover note")').click();
      await broker.waitForTimeout(350);
      await broker.locator('section:has-text("Documents") button:has-text("Signing slip")').click();
      await broker.waitForTimeout(450);
      assert.ok(await broker.locator('section:has-text("Documents") table tbody tr').count() >= 2);
      await broker.locator('section:has-text("Documents") button:has-text("View")').first().click();
      await broker.waitForSelector('.docview');
    });
  } finally {
    await browser.close();
  }
  return errors;
}
