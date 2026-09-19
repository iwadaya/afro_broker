// The spine workspace (M3/M6/M8/M9): structures and versions, the approach to
// market, responses and the recorded silences, the client cycle, and lines
// through signing — with the D7 four-eyes cycle worked by two real users and
// the break-glass override by an admin.
import assert from 'node:assert/strict';
import { launch, login, makeStep, goHub, BASE } from './lib.mjs';

/** Call the API as the signed-in page's user (setup noise, not the test). */
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

const FOT_TERMS = {
  currency: 'USD',
  deductible: '5000000',
  limit: '20000000',
  rate_pct: 3.75,
  rate_type: 'FLAT',
  brokerage_pct: 10,
  egnpi: '80000000',
  mdp: '1000000',
  reinstatements: [{ count: 1, rate_pct: 100 }],
  aggregate_limit: '40000000',
};

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = Date.now().toString(36);
  console.log('spine: the placement workspace');

  try {
    const broker = await login(browser, 'broker', errors);
    const uw = await login(browser, 'uw', errors);
    const admin = await login(browser, 'admin', errors);

    // Setup that other screens own: a cedant and two reinsurers with contacts.
    const cedant = await apiCall(broker, 'POST', '/cedants', { name: `Spine Mutual ${tag}` });
    const r1 = await apiCall(broker, 'POST', '/markets', {
      name: `Spine Lead Re ${tag}`, type: 'reinsurer', rating: 'A', rating_agency: 'AM Best',
    });
    const r2 = await apiCall(broker, 'POST', '/markets', {
      name: `Spine Follow Re ${tag}`, type: 'reinsurer', rating: 'A-', rating_agency: 'AM Best',
    });
    await apiCall(broker, 'POST', `/markets/${r1.id}/contacts`, {
      name: 'Lead UW', email: `lead-${tag}@spinelead.example`, is_primary: true,
    });
    await apiCall(broker, 'POST', `/markets/${r2.id}/contacts`, {
      name: 'Follow UW', email: `follow-${tag}@spinefollow.example`, is_primary: true,
    });

    let workspaceUrl = null;

    await step('a contract year opens into the workspace from Contracts', async () => {
      await goHub(broker, 'Contracts');
      await broker.waitForSelector('section:has-text("Treaty programmes") form');
      const cf = broker.locator('section:has-text("Treaty programmes") form');
      await cf.locator(`select option:has-text("Spine Mutual ${tag}")`).waitFor({ state: 'attached' });
      await cf.locator('select').selectOption({ label: `Spine Mutual ${tag}` });
      await cf.locator('label:has-text("Programme") input').fill(`Property Cat ${tag}`);
      await cf.locator('label:has-text("Class of business") input').fill('Property');
      await cf.locator('button[type=submit]').click();

      const row = broker.locator('tr', { hasText: `Property Cat ${tag}` });
      await row.locator('button:has-text("Open")').click();
      const yf = broker.locator('form', { has: broker.locator('button:has-text("Add year")') });
      await yf.waitFor();
      await yf.locator('label:has-text("Year") input').fill('2026');
      await yf.locator('input[type=date]').nth(0).fill('2026-01-01');
      await yf.locator('input[type=date]').nth(1).fill('2026-12-31');
      await yf.locator('label:has-text("Currency") input').fill('USD');
      await yf.locator('button[type=submit]').click();

      const yearRow = broker.locator('tr', { hasText: '2026-01-01' }).first();
      await yearRow.locator('button:has-text("Workspace")').click();
      await broker.waitForSelector('[role=tab]:has-text("Lines & signing")');
      workspaceUrl = broker.url();
      assert.match(workspaceUrl, /\/contract-years\//);
    });

    await step('a structure is written with typed terms and shows its version', async () => {
      await broker.click('button:has-text("Add structure")');
      const sf = broker.locator('form.inline-form');
      await sf.locator('label:has-text("Label") input').fill('Cat XL Layer 1');
      await sf.locator('label:has-text("Treaty type") select option').nth(1).waitFor({ state: 'attached' });
      await sf.locator('label:has-text("Treaty type") select').selectOption('PROPERTY_CAT_XL');
      await sf.locator('label:has-text("Class of business") input').fill('Property');
      await sf.locator('label:has-text("Terms") textarea').fill(JSON.stringify(FOT_TERMS));
      await sf.locator('button[type=submit]').click();

      const row = broker.locator('tr', { hasText: 'Cat XL Layer 1' });
      await row.waitFor();
      assert.match(await row.textContent(), /USD 20000000\.00 xs 5000000\.00/);
      assert.match(await row.textContent(), /Submitted/);
    });

    await step('the pack goes to quoting markets under four-eyes', async () => {
      await broker.click('[role=tab]:has-text("Marketing")');
      await broker.click('button:has-text("New approach")');
      await broker.locator('label:has-text("Subject") input').fill(`Spine Mutual 2026 Cat XL ${tag}`);
      await broker.locator('label:has-text("Message") textarea').fill('Pack attached; terms as submitted.');
      await broker.locator('label.spine-pick:has-text("v1 SUBMITTED") input').check();
      await broker.locator(`label.spine-pick:has-text("Spine Lead Re ${tag}") input`).check();
      await broker.locator(`label.spine-pick:has-text("Spine Follow Re ${tag}") input`).check();
      await broker.click('button:has-text("Create draft approach")');

      const row = broker.locator('tr', { hasText: `Spine Mutual 2026 Cat XL ${tag}` });
      await row.waitFor();
      await row.locator('button:has-text("Open")').click();
      await broker.click('button:has-text("Request approval")');
      await broker.waitForSelector('text=Awaiting authorisation');

      // A different user authorises.
      await uw.goto(workspaceUrl, { waitUntil: 'networkidle' });
      await uw.click('[role=tab]:has-text("Marketing")');
      await uw.locator('tr', { hasText: `Cat XL ${tag}` }).locator('button:has-text("Open")').click();
      await uw.click('button:has-text("Authorise")');
      await uw.waitForSelector('button:has-text("Send to quoting markets")');

      // The proposer sends, consuming the grant.
      await broker.reload({ waitUntil: 'networkidle' });
      await broker.click('[role=tab]:has-text("Marketing")');
      await broker.locator('tr', { hasText: `Cat XL ${tag}` }).locator('button:has-text("Open")').click();
      await broker.click('button:has-text("Send to quoting markets")');
      await broker.waitForSelector('.foureyes >> text=Sent');

      // Recipient tracking: record a delivery.
      await broker.locator('tr', { hasText: `Spine Lead Re ${tag}` }).locator('button:has-text("delivered")').click();
      await broker.waitForSelector(`tr:has-text("Spine Lead Re ${tag}") >> text=Delivered`);
    });

    await step('a quote is recorded and closing the round records the silence', async () => {
      await broker.click('[role=tab]:has-text("Responses")');
      await broker.waitForSelector('section:has-text("Responses to")');
      await broker.click('button:has-text("Record response")');
      const rf = broker.locator('form.spine-compose');
      await rf.locator('label:has-text("Reinsurer") select').selectOption({ label: `Spine Lead Re ${tag}` });
      await rf.locator('label:has-text("Rate %") input').fill('3.9');
      await rf.locator('label:has-text("Line %") input').fill('40');
      await rf.locator('button[type=submit]').click();
      await broker.waitForSelector(`tr:has-text("Spine Lead Re ${tag}") >> text=Quoted`);

      // The follow market never answered: closing the round writes it down.
      await broker.locator('section:has-text("Close the quoting round") button:has-text("Close —")').click();
      await broker.waitForSelector('text=NO_RESPONSE recorded for 1 market');
      await broker.waitForSelector(`tr:has-text("Spine Follow Re ${tag}") >> text=No response`);
    });

    await step('the submitted version promotes to FOT on its chain', async () => {
      await broker.click('[role=tab]:has-text("Structures")');
      await broker.locator('tr', { hasText: 'Cat XL Layer 1' }).locator('button:has-text("History")').click();
      await broker.waitForSelector('section:has-text("version history")');
      await broker.click('button:has-text("Promote to FOT")');
      await broker.waitForSelector('section:has-text("version history") tr:has-text("v2")');
      const v2 = broker.locator('section:has-text("version history") tr', { hasText: 'v2' });
      assert.match(await v2.textContent(), /FOT/);
      assert.match(await v2.textContent(), /live/);
    });

    await step('the quote goes to the cedant under four-eyes and is taken up', async () => {
      await broker.click('[role=tab]:has-text("Client")');
      await broker.click('button:has-text("New quote to cedant")');
      await broker.locator('label.spine-pick:has-text("v2 FOT") input').check();
      await broker.click('button:has-text("Create draft send")');
      await broker.waitForSelector('section:has-text("Quotes to the cedant") tr:has-text("Draft")');
      await broker.click('button:has-text("Request approval")');
      await broker.waitForSelector('text=Awaiting authorisation');

      await uw.click('[role=tab]:has-text("Client")');
      await uw.click('button:has-text("Authorise")');
      await uw.waitForSelector('button:has-text("Send to cedant")');

      await broker.reload({ waitUntil: 'networkidle' });
      await broker.click('[role=tab]:has-text("Client")');
      await broker.click('button:has-text("Send to cedant")');
      await broker.waitForSelector('section:has-text("Quotes to the cedant") tr:has-text("Sent")');
      await broker.click('button:has-text("Taken up")');
      await broker.waitForSelector('section:has-text("Quotes to the cedant") >> text=Taken up');
    });

    await step('a note distinguishes what was said to the client', async () => {
      const nf = broker.locator('section:has-text("Negotiation notes") form');
      await nf.locator('input').fill('Cedant pushed back on the rate; held at 3.75.');
      await nf.locator('select').selectOption('CEDANT');
      await nf.locator('button:has-text("Post")').click();
      await broker.waitForSelector('.spine-comment >> text=Said to cedant');
    });

    await step('lines oversubscribe, sign down, and the premium follows the shares', async () => {
      await broker.click('[role=tab]:has-text("Lines & signing")');
      await broker.waitForSelector('section:has-text("Placement completion")');

      const linesCard = broker.locator('section.card', { has: broker.locator('h2:text-is("Lines")') });
      const lf = linesCard.locator('form.inline-form');
      await lf.locator('label:has-text("Reinsurer") select').selectOption({ label: `Spine Lead Re ${tag}` });
      await lf.locator('label:has-text("Written %") input').fill('60');
      await lf.locator('button:has-text("Write line")').click();
      await linesCard.locator(`tbody tr:has-text("Spine Lead Re ${tag}")`).waitFor();
      await lf.locator('label:has-text("Reinsurer") select').selectOption({ label: `Spine Follow Re ${tag}` });
      await lf.locator('label:has-text("Written %") input').fill('70');
      await lf.locator('button:has-text("Write line")').click();

      await broker.waitForSelector('text=signs down by factor');
      await broker.click('button:has-text("Apply signing")');
      // 130% written against an order of 100% signs down; premium at 100% is
      // the MDP, so the signed shares split USD 1,000,000 exactly.
      const leadRow = linesCard.locator('tbody tr', { hasText: `Spine Lead Re ${tag}` });
      await leadRow.locator('text=46.15').waitFor();
      assert.match(await leadRow.textContent(), /USD 461538\.00/);
      await broker.waitForSelector('section:has-text("Placement completion") >> text=Oversubscribed');
    });

    await step('the bordereau renders and exports', async () => {
      const bordCard = broker.locator('section.card', { has: broker.locator('h2:text-is("Lines bordereau")') });
      await bordCard.locator('tbody tr:has-text("Cat XL Layer 1")').first().waitFor();
      // No linked prior year: the expiring panel is unknown, not empty.
      await bordCard.locator('text=unknown').waitFor();
      const download = broker.waitForEvent('download', { timeout: 15000 });
      await bordCard.locator('button:has-text("Excel")').click();
      const file = await download;
      assert.match(file.suggestedFilename(), /\.xlsx$/);
    });

    await step('an advice snapshots the lines and break-glass releases it', async () => {
      await broker.click('button:has-text("Raise advice")');
      await broker.waitForSelector('section:has-text("Written-line advices") tr:has-text("Draft")');

      // Nobody to authorise at 11pm: the admin overrides, with a stated reason.
      await admin.goto(workspaceUrl, { waitUntil: 'networkidle' });
      await admin.click('[role=tab]:has-text("Lines & signing")');
      await admin.locator('section:has-text("Written-line advices") button:has-text("Break glass…")').click();
      await admin.locator('input[placeholder*="Stated reason"]').fill('Inception imminent; no underwriter reachable');
      await admin.click('button:has-text("Override")');
      await admin.waitForSelector('text=Break-glass by');
      await admin.click('button:has-text("Send advice")');
      await admin.waitForSelector('section:has-text("Written-line advices") tr:has-text("Sent")');
    });
  } finally {
    await browser.close();
  }
  return errors;
}
