// The book screens: admin role-gating, portfolio intelligence, programme
// analysis and market intelligence.
import assert from 'node:assert/strict';
import { BASE, launch, login, makeStep, goHub } from './lib.mjs';

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `feat-${Date.now()}`;
  console.log('features: admin / portfolio / programme analysis / market intelligence');

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

    await step('portfolio intelligence: from the launcher, and across to the calendar', async () => {
      // Reached from the dashboard's launcher; the top bar carries no button for it.
      assert.equal(await broker.locator('.topbar-portfolio, .topbar >> text="Renewal calendar"').count(), 0, 'no book buttons in the top bar');
      await goHub(broker, 'Portfolio intelligence');
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
      assert.ok(firstBar.startsWith('Afro-Asian Insurance Services'), 'this desk leads the broker chart');
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
      // An account on the book opens as a contract, on its basis page.
      await broker.selectOption('[data-testid=mi-country]', { label: 'United Kingdom' });
      await broker.waitForSelector('[data-testid=mi-book] >> text=GRV-27-PROP-CAT', { timeout: 10000 });
      await broker.click('[data-testid=mi-book] a.refbtn:has-text("GRV-27-PROP-CAT")');
      await broker.waitForURL(/\/contracts\/non-proportional\/[0-9a-f-]{36}$/, { timeout: 15000 });
      await broker.waitForSelector('[data-testid=np-contract-details]', { timeout: 10000 });
      // And back to the portfolio.
      await broker.goto(`${BASE}/portfolio/market-intelligence`, { waitUntil: 'networkidle' });
      await broker.click('a:has-text("Portfolio intelligence")');
      await broker.waitForSelector('h2:has-text("Portfolio intelligence")', { timeout: 10000 });
    });
  } finally {
    await browser.close();
  }
  return errors;
}
