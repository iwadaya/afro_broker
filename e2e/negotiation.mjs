// Negotiation: the pack goes to market, and the quotes come back against the
// structures that were quoted.
import assert from 'node:assert/strict';
import { launch, login, makeStep, BASE } from './lib.mjs';

const api = async (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(`/api${p}`, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('ub_token')}` },
    body: b === null ? undefined : JSON.stringify(b),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}, [method, path, body ?? null]);

/** A placement carrying two structures and a built pack, ready to go out. */
async function seedPlacement(page, tag) {
  const cedant = await api(page, 'POST', '/cedants', { name: `Neg Cedant ${tag}` });
  const placement = await api(page, 'POST', '/placements', {
    cedant_id: cedant.id, class: 'Property Cat XoL',
    inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD',
  });
  await api(page, 'PATCH', `/placements/${placement.id}`, {
    quote_structures: [
      { basis: 'NP', cobs: [], prop: {}, layers: [
        { name: 'Layer 1', type: 'XoL', limit: 5000000, attachment: 1000000, premium: 400000, rate_pct: 8 },
        { name: 'Layer 2', type: 'XoL', limit: 10000000, attachment: 6000000, premium: 250000 },
      ] },
      { basis: 'PROP', cobs: [], layers: [],
        prop: { treatyType: 'QS', qsLimit: 4000000, commissionPct: 30, epi: 9000000 } },
    ],
  });
  // Each market carries a named underwriter with an address: that list is what
  // a submission is addressed to.
  for (const [name, person] of [[`Alpha Re ${tag}`, 'Jo Smith'], [`Beta Re ${tag}`, 'Anders Vik']]) {
    const market = await api(page, 'POST', '/markets', { name, rating: 'A' });
    await api(page, 'POST', `/markets/${market.id}/contacts`, {
      name: person, email: `${person.split(' ')[0].toLowerCase()}.${tag}@example.test`, is_primary: true,
    });
  }
  // A wording for the placement: the pack cannot go out without one.
  await api(page, 'POST', '/wordings/drafts', {
    title: `Property Cat XoL wording ${tag}`, placement_id: placement.id, cob: 'Property',
  });
  return placement.id;
}

/* A card by its title, not its whole text — the stage header's tab labels
   would otherwise match ("Responses & Quotes" for the Responses card). */
const card = (page, title) => page.locator('.np-struct-card').filter({ has: page.locator('.np-struct-card-h2', { hasText: title }) });
/* The board's own cards — the capture sheet repeats the structure names, so
   board assertions have to say which they mean. */
const boardCard = (page, title) => page.locator(`.neg-board .np-struct-card:has-text("${title}")`);
/* The quoting stage runs in six tabs: Renewal Pack, Emails, Sent to
   reinsurers, Responses & Quotes, By Underwriter, Rate on Line. The board and
   the capture sheet are on Responses & Quotes. */
const negTab = async (page, label) => {
  await page.click(`[data-testid="neg-tabs"] button:has-text("${label}")`);
  await page.waitForTimeout(200);
};

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  const tag = `neg-${Date.now()}`;
  console.log('negotiation: pack to market, quotes against the structures');

  try {
    const broker = await login(browser, 'broker', errors);
    const senior = await login(browser, 'senior', errors);
    const uw = await login(browser, 'uw', errors);
    let pid;

    await step('the placement page carries a Quoting Stage tab, not SA & Endorsements', async () => {
      pid = await seedPlacement(broker, tag);
      await broker.goto(`${BASE}/placements/${pid}`, { waitUntil: 'networkidle' });
      const tabs = await broker.locator('.wizard-tab').allInnerTexts();
      assert.ok(tabs.some((t) => t.includes('Quoting Stage')), 'the Quoting Stage is there');
      assert.ok(!tabs.some((t) => t.includes('Endorsement')), 'SA & Endorsements is gone');
    });

    await step('with no approved pack, the Quoting Stage tab is locked', async () => {
      assert.equal(await broker.locator('.wizard-tab--locked:has-text("Quoting Stage")').count(), 1);
      await broker.click('.wizard-tab:has-text("Quoting Stage")');
      await broker.waitForSelector('[data-testid="negotiation-locked"]');
      assert.match(await broker.locator('[data-testid="negotiation-locked"]').innerText(), /No renewal pack has been created/);

      // A created pack is still locked until a Senior Broker approves it.
      const pack = await api(broker, 'POST', `/placements/${pid}/packs`, {});
      await api(broker, 'POST', `/packs/${pack.id}/submit`, {});
      await broker.reload({ waitUntil: 'networkidle' });
      await broker.click('.wizard-tab:has-text("Quoting Stage")');
      await broker.waitForSelector('[data-testid="negotiation-locked"]');
      assert.match(await broker.locator('[data-testid="negotiation-locked"]').innerText(), /awaiting a Senior Broker/);
      await api(senior, 'POST', `/packs/${pack.id}/approve`, {});
    });

    await step('the Renewal Pack tab opens the approved version as the Excel it went out as', async () => {
      await broker.reload({ waitUntil: 'networkidle' });
      await broker.click('.wizard-tab:has-text("Quoting Stage")');
      await broker.waitForSelector('[data-testid="neg-tabs"]');
      const tabs = await broker.locator('[data-testid="neg-tabs"] button').allInnerTexts();
      assert.deepEqual(tabs.map((t) => t.replace(/^\d · /, '')), ['Renewal Pack', 'Emails', 'Sent to reinsurers', 'Responses & Quotes', 'By Underwriter', 'Rate on Line']);
      // The approved version opens by default, as the stored workbook.
      await broker.waitForSelector('[data-testid="neg-workbook"]', { timeout: 15000 });
      assert.match(await broker.locator('.neg-pack-facts').innerText(), /v1 \(approved\)/);
      const book = broker.locator('[data-testid="neg-workbook"]');
      const sheets = await book.locator('.xl-sheet').allInnerTexts();
      assert.equal(sheets[0], 'Cover');
      assert.ok(sheets.length > 3, `a sheet per section: ${sheets.join(', ')}`);
      const cover = await book.innerText();
      assert.match(cover, /BROKER IQ/);
      assert.match(cover, /Renewal Pack v1/);
      assert.match(cover, /Cedant/);
      // Excel's furniture: column letters across, row numbers down.
      assert.deepEqual(await book.locator('thead th').allInnerTexts().then((h) => h.slice(1, 4)), ['A', 'B', 'C']);
      // Another sheet opens on its tab.
      await book.locator('.xl-sheet').nth(1).click();
      assert.equal(await book.locator('.xl-sheet.is-on').innerText(), sheets[1]);
      assert.ok(await broker.locator('[data-testid="send-pack"]').isEnabled(), 'an approved pack can go to market from here');
    });

    await step('the structures to quote are on the board before anyone has it', async () => {
      await negTab(broker, 'Responses & Quotes');
      await broker.waitForSelector('text=Structure 1');
      const np = boardCard(broker, 'Structure 1');
      assert.match(await np.innerText(), /non-proportional/);
      assert.equal(await np.locator('tbody tr').count(), 2, 'a line per layer');
      assert.match(await np.innerText(), /5,000,000 XS 1,000,000/i);
      const prop = boardCard(broker, 'Structure 2');
      assert.match(await prop.innerText(), /proportional/);
      assert.equal(await prop.locator('tbody tr').count(), 1, 'quoted as a whole');
      assert.match(await prop.innerText(), /30% commission · EPI 9,000,000/);
    });

    await step('the covering email is drafted for two named underwriters', async () => {
      await negTab(broker, 'Emails');
      await broker.locator('[data-testid="send-pack"]').click();
      await broker.waitForSelector('.neg-editor');
      const picker = broker.locator('.neg-editor');
      // Reinsurers first: ticking one picks its primary underwriter and opens
      // the underwriters at that reinsurer underneath.
      await picker.locator('[data-testid="reinsurer-picker"]').waitFor({ timeout: 15000 });
      assert.match(await picker.innerText(), /Reinsurers to approach for quotation/i);
      assert.equal(await picker.locator('[data-testid="underwriter-picker"]').count(), 0, 'no underwriters shown until a reinsurer is chosen');
      for (const name of [`Alpha Re ${tag}`, `Beta Re ${tag}`]) {
        await picker.locator(`.neg-market:has-text("${name}")`).click();
      }
      assert.equal(await picker.locator('[data-testid="underwriter-picker"]').count(), 2, 'each chosen reinsurer lists its underwriters');
      assert.equal(await picker.locator('.neg-underwriter.is-on').count(), 2, 'the primary underwriter at each is picked');
      assert.match(await picker.locator('.neg-editor-actions').innerText(), /Selected\s*2/);
      // Every reinsurer approached is asked for a lead quote: nobody is singled out.
      assert.equal(await picker.locator('select').count(), 0, 'no lead market to name');
      await picker.locator('button:has-text("Draft covering email")').click();
      await broker.waitForSelector('textarea.neg-mail');

      const body = await broker.locator('textarea.neg-mail').inputValue();
      assert.match(body, /\{\{contact_name\}\}/, 'the salutation stays a token until it is sent');
      assert.match(body, /Structure 1 — non-proportional/);
      assert.match(body, /Layer 1: 5,000,000 xs 1,000,000/);
      assert.ok(body.includes('['), 'the drafted commentary leaves the judgement calls to the broker');
      assert.ok(
        await broker.locator('button:has-text("Send for approval (4-eyes)")').isDisabled(),
        'approval is locked until the broker confirms they have read it',
      );
    });

    await step('the broker edits it, confirms the read, and asks for approval', async () => {
      const area = broker.locator('textarea.neg-mail');
      await area.fill(`${await area.inputValue()}\n\nChecked and edited by the broker.`);
      await broker.locator('.neg-confirm input').check();
      await broker.locator('button:has-text("Send for approval (4-eyes)")').click();
      await broker.waitForSelector('text=/awaiting release/');
      assert.equal(await broker.locator('textarea.neg-mail').count(), 0, 'content freezes once it goes for approval');
      assert.match(await broker.locator('.neg-editor').innerText(), /another underwriter or admin has to release it/);
      assert.equal(await broker.locator('button:has-text("Approve & send")').count(), 0,
        'the drafter is never offered the release');
      await broker.locator('.neg-editor button[aria-label="Close"]').click();
      await broker.waitForTimeout(500);
      assert.match(await card(broker, 'Submissions').innerText(), /awaiting release/);
    });

    await step('a second pair of eyes releases it, and the markets hold the pack', async () => {
      await uw.goto(`${BASE}/placements/${pid}`, { waitUntil: 'networkidle' });
      await uw.click('.wizard-tab:has-text("Quoting Stage")');
      await uw.waitForSelector('[data-testid="neg-tabs"]');
      await negTab(uw, 'Emails');
      await uw.waitForSelector('text=Submissions');
      await card(uw, 'Submissions').locator('button:has-text("Review")').click();
      await uw.waitForSelector('button:has-text("Approve & send")');
      const dialog = uw.locator('.neg-editor');
      assert.match(await dialog.innerText(), /jo\.[a-z0-9-]+@example\.test/i, 'the addresses it goes to are shown');
      assert.match(await dialog.innerText(), /Checked and edited by the broker\./, 'what the broker wrote is what ships');
      await dialog.locator('button:has-text("Approve & send")').click();
      await uw.waitForSelector('text=/after four-eyes approval/');
      assert.match(await dialog.innerText(), /sent 20/, 'delivery is recorded per underwriter');
      await dialog.locator('button[aria-label="Close"]').click();
      await uw.waitForTimeout(600);

      await broker.reload({ waitUntil: 'networkidle' });
      await broker.click('.wizard-tab:has-text("Quoting Stage")');
      await broker.waitForSelector('[data-testid="neg-tabs"]');
      assert.match(await broker.locator('.neg-summary').innerText(), /Reinsurers holding it\s*2/);
      assert.match(await broker.locator('.neg-summary').innerText(), /Underwriters emailed\s*2/);

      // The register: every reinsurer approached for quotation, who at each
      // was emailed, whether it got there, and what has come back — and no
      // role, since every one of them is asked for a lead quote.
      await negTab(broker, 'Sent to reinsurers');
      await broker.waitForSelector('[data-testid="neg-register"]');
      const register = broker.locator('[data-testid="neg-register"]');
      assert.equal(await register.locator('tbody tr').count(), 2);
      const listed = await register.innerText();
      assert.match(listed, /SENT/);
      assert.match(listed, /Jo Smith/);
      assert.match(listed, /jo\.[a-z0-9-]+@example\.test/i, 'the address it went to');
      assert.match(listed, /delivered/);
      assert.match(listed, /awaiting reply/);
      assert.match(await register.locator('tbody tr').first().innerText(), new RegExp(`Alpha Re ${tag}`, 'i'), 'by name');
      assert.equal(await register.locator('select').count(), 0, 'no role to set');
      assert.doesNotMatch(await register.locator('thead').innerText(), /role/i, 'no role column');
      assert.doesNotMatch(listed, /\b(lead|follow)\b/i, 'no role tag on a market');

      // Each market is a column on the board, holding the version it was sent.
      // The header is uppercased by CSS, and innerText reads it as rendered.
      await negTab(broker, 'Responses & Quotes');
      const headers = await boardCard(broker, 'Structure 1').locator('thead th').allInnerTexts();
      assert.match(headers[3], new RegExp(`Alpha Re ${tag}`, 'i'), `headers were ${JSON.stringify(headers)}`);
      assert.match(headers[3], /v1/i);
      assert.doesNotMatch(headers[3], /\b(lead|follow)\b/i, 'no role on the board');
    });

    await step('a reply logged against an underwriter is read by the AI and tracked on the board', async () => {
      await negTab(broker, 'Emails');
      const responses = card(broker, 'Responses');
      await responses.waitFor({ timeout: 15000 });
      assert.match(await responses.innerText(), /Replied\s*0\/2/, 'both underwriters are awaited');
      assert.equal(await responses.locator('[data-testid="reply-standings"] tbody tr').count(), 2);
      assert.match(await responses.innerText(), /awaiting reply/);

      await responses.locator('[data-testid="log-reply-toggle"]').click();
      await broker.fill('[data-testid="log-reply-body"]',
        'Dear Broker,\n\nThank you for the pack. We are pleased to offer a line of 15% on Layer 1 at a rate on line of 7.5%, subject to no losses before inception. Valid until 15 December 2027.\n\nJo');
      await responses.locator('[data-testid="log-reply-submit"]').click();
      await responses.locator('[data-testid="reply"]').first().waitFor({ timeout: 20000 });
      const text = await responses.innerText();
      assert.match(text, /Replied\s*1\/2/);
      assert.match(text, /Quotes\s*1/);
      const reply = responses.locator('[data-testid="reply"]').first();
      assert.match(await reply.innerText(), /quote/i, 'read as a quote');
      assert.match(await reply.innerText(), /7\.5/, 'the rate is extracted');
      assert.match(await reply.innerText(), /15/, 'so is the line');
      assert.match(await reply.innerText(), /Capture the quoted terms/i, 'and the next action is named');
      await reply.locator('button:has-text("Mark handled")').click();
      await broker.waitForTimeout(600);
      assert.match(await responses.locator('[data-testid="reply"]').first().innerText(), /handled/);

      // Demo: the AI plays the underwriter still awaited, and the board fills.
      await responses.locator('[data-testid="simulate-replies"]').click();
      await broker.waitForSelector('.np-struct-card:has-text("Responses") .np-struct-notice:has-text("Demo:")', { timeout: 30000 });
      // The note lands before the card reloads its standings.
      await broker.waitForSelector('.np-struct-card:has-text("Responses") .np-layer-count:has-text("Replied"):has-text("2/2")', { timeout: 15000 });
      assert.equal(await responses.locator('[data-testid="reply"]').count(), 2);
      assert.match(await responses.innerText(), /simulated for the demo/);
      assert.equal(await responses.locator('[data-testid="simulate-replies"]').count(), 0, 'nobody left to simulate');
    });

    await step('a quote is captured against one layer', async () => {
      await negTab(broker, 'Responses & Quotes');
      const np = boardCard(broker, 'Structure 1');
      await np.locator('tbody tr').first().locator('button:has-text("Quote")').first().click();
      await broker.waitForSelector('.neg-editor');
      const editor = broker.locator('.neg-editor');
      assert.match(await editor.innerText(), /Structure 1 · Layer 1/);
      // Lead quote or indication is asked in the form, and a quote is a lead quote until said otherwise.
      assert.match(await editor.locator('[data-testid="quote-kind"] [aria-pressed="true"]').innerText(), /lead quote/i);
      await editor.locator('.fr:has-text("Premium") input').fill('372000');
      await editor.locator('.fr:has-text("Rate %") input').fill('7.44');
      await editor.locator('.fr:has-text("Line %") input').fill('30');
      await editor.locator('button:has-text("Save quote")').click();
      await broker.waitForTimeout(700);
      const row = boardCard(broker, 'Structure 1').locator('tbody tr').first();
      assert.match(await row.innerText(), /USD 372,000/);
      assert.match(await row.innerText(), /7.44% rate · 30% line/);
      assert.match(await row.innerText(), /1 quoted · 30% offered/, 'the line summary follows');
    });

    await step('a second market declines, and the board says so', async () => {
      const row = boardCard(broker, 'Structure 1').locator('tbody tr').first();
      await row.locator('button:has-text("Quote")').first().click();
      await broker.waitForSelector('.neg-editor');
      const editor = broker.locator('.neg-editor');
      await editor.locator('.neg-notquoted input').check();
      await editor.locator('.fr:has-text("Notes") input').fill('Aggregate full');
      await editor.locator('button:has-text("Save quote")').click();
      await broker.waitForTimeout(700);
      const text = await boardCard(broker, 'Structure 1').locator('tbody tr').first().innerText();
      assert.match(text, /Declined/);
      assert.match(text, /Aggregate full/);
      assert.match(text, /1 quoted, 1 declined/);
    });

    await step('the proportional structure is quoted on its terms', async () => {
      const prop = boardCard(broker, 'Structure 2');
      // Scoped to the row: the card's own "＋ Add quote" action matches too.
      await prop.locator('tbody tr').first().locator('button:has-text("Quote")').first()
        .click();
      await broker.waitForSelector('.neg-editor');
      const editor = broker.locator('.neg-editor');
      // The dialog shell appears a tick before its fields, so wait on a field.
      await editor.locator('.fr:has-text("Commission %")').waitFor();
      assert.equal(await editor.locator('.fr:has-text("Premium")').count(), 0, 'commission, not premium');
      await editor.locator('.fr:has-text("Commission %") input').fill('32.5');
      await editor.locator('.fr:has-text("EPI") input').fill('8600000');
      await editor.locator('button:has-text("Save quote")').click();
      await broker.waitForTimeout(700);
      const text = await boardCard(broker, 'Structure 2').locator('tbody tr').first().innerText();
      assert.match(text, /32.5% comm/);
      assert.match(text, /EPI 8,600,000/);
    });

    await step('picking a market on the sheet pulls through what it was sent', async () => {
      const sheet = card(broker, 'Capture a quote');
      const options = await sheet.locator('#neg-market option').allInnerTexts();
      assert.ok(options.some((o) => new RegExp(`Alpha Re ${tag}`, 'i').test(o)));
      assert.ok(!options.some((o) => /\(lead\)|\(follow\)/i.test(o)), 'no role beside a market');
      await sheet.locator('#neg-market').selectOption({ index: 1 });
      await broker.waitForSelector('.neg-sheet-block');
      const blocks = sheet.locator('.neg-sheet-block');
      assert.equal(await blocks.count(), 2, 'both structures it was sent');
      // Its existing answer on layer 1 comes back in the form. (Scope to the
      // row: the block's first input is the Declined checkbox.)
      const layer1 = blocks.first().locator('tbody tr').first();
      assert.equal(await layer1.locator('input[aria-label="Premium 100%"]').inputValue(), '372000');
      // Every column of the layer comes through, not just its price.
      assert.equal(await layer1.locator('input[aria-label="Limit"]').inputValue(), '5000000');
      assert.equal(await layer1.locator('input[aria-label="Attachment"]').inputValue(), '1000000');
      assert.match(await blocks.first().innerText(), /5,000,000 XS 1,000,000/i);
    });

    await step('the sheet prices the rest, and declines a structure outright', async () => {
      const sheet = card(broker, 'Capture a quote');
      const blocks = sheet.locator('.neg-sheet-block');
      // Layer 2, untouched so far.
      await blocks.first().locator('tbody tr').nth(1)
        .locator('input[aria-label="Premium 100%"]')
        .fill('238000');
      await blocks.nth(1).locator('.neg-declined input').check();
      await sheet.locator('button:has-text("Save")').last().click();
      await broker.waitForSelector('.np-struct-notice');
      assert.match(await sheet.locator('.np-struct-notice').innerText(), /Saved/);
      await broker.waitForTimeout(800);   // the board reloads behind the sheet

      const np = boardCard(broker, 'Structure 1');
      assert.match(await np.locator('tbody tr').nth(1).innerText(), /USD 238,000/,
        `row 2 read: ${(await np.locator('tbody tr').nth(1).innerText()).replace(/\n/g, ' | ')}`);
      const prop = boardCard(broker, 'Structure 2');
      assert.match(await prop.locator('tbody tr').first().innerText(), /Declined/);
    });

    await step('the reinsurer cards collect what each quoted, and what each still owes', async () => {
      const cards = broker.locator('[data-testid="neg-by-reinsurer"] .np-struct-card');
      assert.equal(await cards.count(), 2, 'a card per reinsurer holding the pack');
      const alpha = await cards.first().innerText();
      assert.match(alpha, new RegExp(`Alpha Re ${tag}`, 'i'));
      assert.match(alpha, /quoted 2 of 2 structures sent/i);
      assert.match(alpha, /USD 372,000/);
      assert.match(alpha, /USD 238,000/);
      assert.match(alpha, /Declined/, 'the proportional structure it passed on');
      assert.match(alpha, /QUOTED/);
      const beta = await cards.nth(1).innerText();
      assert.match(beta, /quoted 1 of 2 structures sent/i);
      assert.match(beta, /Declined/);
      assert.match(beta, /Awaited/, 'what Beta still owes is listed beside what came in');
    });

    await step('a reinsurer\'s answer on a structure is switched to an indication, and marked wherever it is read', async () => {
      const alpha = () => broker.locator('[data-testid="neg-by-reinsurer"] .np-struct-card').first();
      // Structure 1 is the one Alpha priced; the switch sits on it, and on
      // nothing it declined outright.
      assert.equal(await alpha().locator('[data-testid="quote-kind"]').count(), 1, 'one switch, on the structure it priced');
      const toggle = alpha().locator('[data-testid="quote-kind"]').first();
      assert.match(await toggle.locator('[aria-pressed="true"]').innerText(), /lead quote/i, 'a quote is a lead quote until said otherwise');
      await toggle.locator('button:has-text("Indicative")').click();
      await broker.waitForTimeout(900);
      assert.match(await alpha().locator('[data-testid="quote-kind"] [aria-pressed="true"]').innerText(), /indicative/i);
      assert.ok((await alpha().locator('[data-testid="indicative-tag"]').count()) >= 2, 'both layers Alpha priced carry the mark');
      const row = boardCard(broker, 'Structure 1').locator('tbody tr').first();
      assert.match(await row.innerText(), /indicative/i, 'the board cell says so');
      assert.match(await row.innerText(), /1 quoted \(1 indicative\)/i, 'and so does the line summary');
      // Back to a lead quote: the marks go.
      await alpha().locator('[data-testid="quote-kind"] button:has-text("Lead quote")').click();
      await broker.waitForTimeout(900);
      assert.equal(await boardCard(broker, 'Structure 1').locator('[data-testid="indicative-tag"]').count(), 0);
      assert.match(await alpha().locator('[data-testid="quote-kind"] [aria-pressed="true"]').innerText(), /lead quote/i);
    });

    await step('“Different structure quoted” on a reinsurer card starts it on the sheet', async () => {
      const alpha = broker.locator('[data-testid="neg-by-reinsurer"] .np-struct-card').first();
      await alpha.locator('[data-testid="different-structure"]').click();
      await alpha.locator('select[aria-label^="Different structure quoted by"]').selectOption('blank');
      await broker.waitForTimeout(900);
      const sheet = card(broker, 'Capture a quote');
      assert.match(await sheet.locator('#neg-market option:checked').innerText(), new RegExp(`Alpha Re ${tag}`, 'i'),
        'the sheet is on that market');
      const own = sheet.locator('.neg-sheet-block').last();
      assert.match(await own.locator('input[aria-label="Structure name"]').inputValue(), /Market structure/i);
      assert.equal(await own.locator('tbody tr').count(), 1, 'a blank sheet: one empty layer');
      // Not saved — the next step enters the lead's structure itself.
      await sheet.locator('button:has-text("Reset")').click();
      await broker.waitForSelector('.neg-sheet-block');
      assert.equal(await sheet.locator('.neg-sheet-block').count(), 2);
    });

    await step('a reinsurer answering with its own structure is captured and boarded', async () => {
      const sheet = card(broker, 'Capture a quote');
      await sheet.locator('button:has-text("Add an alternative structure")').click();
      await broker.waitForTimeout(250);
      const own = sheet.locator('.neg-sheet-block').last();
      await own.locator('input[aria-label="Structure name"]').fill(`Lead tower ${tag}`);
      const ownRow = own.locator('tbody tr').first();
      await ownRow.locator('input[aria-label="Name"]').fill('Own layer 1');
      await ownRow.locator('input[aria-label="Limit"]').fill('4000000');
      await ownRow.locator('input[aria-label="Attachment"]').fill('2000000');
      await ownRow.locator('input[aria-label="Premium 100%"]').fill('300000');
      await ownRow.locator('input[aria-label="Line %"]').fill('40');
      await sheet.locator('button:has-text("Save")').last().click();
      await broker.waitForTimeout(900);

      const ownCard = boardCard(broker, `Lead tower ${tag}`);
      assert.equal(await ownCard.count(), 1, 'it is on the board in its own right');
      const text = await ownCard.innerText();
      assert.match(text, /came back with this instead/i);
      assert.match(text, /4,000,000 XS 2,000,000/i);
      assert.match(text, /USD 300,000/);
      // Only the market that put it up may answer it.
      assert.equal(await ownCard.locator('.neg-cell').count(), 1);
    });

    await step('the whole layer is quotable, and what moved is marked against it', async () => {
      const np = boardCard(broker, 'Structure 1');
      // Reopen Alpha's answer on layer 1 — the cell, not the card action.
      await np.locator('tbody tr').first().locator('.neg-cell--quoted').first().click();
      await broker.waitForSelector('.neg-editor');
      const editor = broker.locator('.neg-editor');

      // Every column of the layer is there, starting at what was sent.
      assert.equal(await editor.locator('input[aria-label="Limit"]').inputValue(), '5000000');
      assert.equal(await editor.locator('input[aria-label="Attachment"]').inputValue(), '1000000');
      assert.match(await editor.innerText(), /Reinstatements/);
      assert.match(await editor.innerText(), /AAD/);

      // The underwriter who gave the terms, from that reinsurer's own contacts.
      const who = editor.locator('.fr:has-text("Underwriter") select');
      assert.match((await who.locator('option').allInnerTexts()).join('|'), /Jo Smith/,
        'the reinsurer’s underwriters are offered');
      await who.selectOption({ index: 1 });

      // The underwriter takes it with an AAD, one reinstatement and no CAT.
      await editor.locator('input[aria-label="AAD"]').fill('100000');
      await editor.locator('select[aria-label="Reinstatements"]').selectOption('1');
      await editor.locator('input[aria-label="CAT"]').uncheck();
      // ROL follows the quoted premium over the quoted limit — 372,000 / 5m.
      assert.equal(await editor.locator('.fr:has-text("ROL") input').inputValue(), '7.44%');
      assert.match(await editor.innerText(), /moved off what was sent/i,
        'the form says which columns moved');

      await editor.locator('button:has-text("Save quote")').click();
      await broker.waitForTimeout(800);

      const row = boardCard(broker, 'Structure 1').locator('tbody tr').first();
      assert.match(await row.innerText(), /changed/i, 'the board flags a quote that moved terms');
      assert.match(await row.innerText(), /USD 372,000/, 'the price it was quoted at still reads');
    });

    await step('an alternative structure starts from the one it replaces', async () => {
      const np = boardCard(broker, 'Structure 1');
      await np.locator('button:has-text("Alternative structure")').click();
      await broker.waitForTimeout(300);
      // One market left holding it after the decline, so it goes straight there.
      const picker = np.locator('select[aria-label="Alternative structure for market"]');
      if (await picker.count()) await picker.selectOption({ index: 1 });
      await broker.waitForTimeout(900);

      const sheet = card(broker, 'Capture a quote');
      const alt = sheet.locator('.neg-sheet-block').last();
      assert.match(await alt.locator('input[aria-label="Structure name"]').inputValue(), /Alternative to/i);
      // It arrives carrying the sent structure's layers, ready to be varied.
      assert.equal(await alt.locator('tbody tr').first().locator('input[aria-label="Limit"]').inputValue(), '5000000');
      assert.equal(await alt.locator('tbody tr').count(), 2, 'both layers came across');
    });

    await step('a market that has answered reads as quoted, and can be withdrawn', async () => {
      await negTab(broker, 'Sent to reinsurers');
      const register = broker.locator('[data-testid="neg-register"]');
      await register.waitFor();
      assert.match(await register.innerText(), /QUOTED/);
      assert.match(await register.innerText(), /DECLINED/);
      await register.locator('tbody tr').last().locator('button[aria-label^="Withdraw"]').click();
      await broker.waitForTimeout(700);
      assert.equal(await broker.locator('[data-testid="neg-register"] tbody tr').count(), 1);
    });

    await step('the By Underwriter tab reads each reinsurer\'s quotes by structure and adds them into a combined quote', async () => {
      await negTab(broker, 'By Underwriter');
      await broker.waitForSelector('[data-testid="qu-by-underwriter"]', { timeout: 15000 });
      const cards = await broker.locator('[data-testid="qu-by-underwriter"]').innerText();
      assert.match(cards, /Alpha Re/);
      assert.match(cards, /NON-PROPORTIONAL/);
      assert.match(cards, /PROPORTIONAL/);
      assert.match(cards, /programme/i, 'a non-proportional structure adds its layers into a programme');
      await broker.waitForSelector('[data-testid="qu-combined"]', { timeout: 15000 });
      assert.match(await broker.locator('[data-testid="qu-best"]').first().innerText(), /best of market/i);
    });

    await step('the Rate on Line tab compares each layer across the reinsurers that quoted, keenest marked', async () => {
      await negTab(broker, 'Rate on Line');
      await broker.waitForSelector('[data-testid="rol-comparison"]', { timeout: 15000 });
      const table = await broker.locator('[data-testid="rol-comparison"]').first().innerText();
      assert.match(table, /as sent/i);
      assert.match(table, /alpha re/i);
      assert.match(table, /programme/i);
      assert.ok(await broker.locator('[data-testid="rol-best"]').count() >= 1, 'the keenest quote on a layer is marked');
      await negTab(broker, 'Responses & Quotes');
    });

    await step('the final quote and the final placement: terms from the lead quote, the FOT sent with Excel + PDF, lines written, signed down and confirmed', async () => {
      await broker.click('.wizard-tab:has-text("Final Quote")');
      await broker.waitForSelector('[data-testid="final-quote"]', { timeout: 15000 });
      // We won the lead: the lead reinsurer follows from the terms picked.
      assert.ok(await broker.locator('[data-testid="lead-won"] input').isChecked());
      const terms = broker.locator('[data-testid="final-terms"]');
      await terms.locator('[data-testid="term-s1:l0"] input[type=checkbox]').check();
      assert.match(await terms.locator('[data-testid="term-s1:l0"] select').inputValue().then(() => terms.locator('[data-testid="term-s1:l0"] select option:checked').innerText()), /Alpha Re/);
      await broker.click('[data-testid="save-final-terms"]');
      await broker.waitForSelector('[data-testid="final-note"]:has-text("Final terms saved")', { timeout: 15000 });
      // The note lands before the reload does: wait for what the reload shows.
      await broker.waitForSelector('[data-testid="final-quote"] .np-struct-card-hint:has-text("led by Alpha Re")', { timeout: 15000 });
      assert.match(await broker.locator('[data-testid="final-quote"] .np-struct-card-hint').first().innerText(), /lead broker Universe Broking · led by Alpha Re/);

      // The FOT goes to Alpha's underwriter, with the approved pack as Excel and PDF.
      await broker.click('.wizard-tab:has-text("Final Placement")');
      await broker.waitForSelector('[data-testid="final-placement"]', { timeout: 15000 });
      await broker.waitForSelector('[data-testid="fot-body"]', { timeout: 15000 });
      assert.match(await broker.locator('[data-testid="fot-attach"]').innerText(), /Excel and PDF/);
      assert.match(await broker.inputValue('[data-testid="fot-body"]'), /Firm order terms/);
      // Beta was withdrawn from the board earlier; the FOT still goes to both,
      // which is what puts Beta on the lines sheet.
      for (const name of [`Alpha Re ${tag}`, `Beta Re ${tag}`]) {
        await broker.locator(`[data-testid="reinsurer-picker"] .neg-market:has-text("${name}")`).click();
      }
      await broker.click('[data-testid="send-fot"]');
      await broker.waitForSelector('[data-testid="final-note"]:has-text("Firm order terms sent to 2")', { timeout: 20000 });
      await broker.locator('[data-testid="final-emails"] tbody tr').first().waitFor({ timeout: 15000 });
      assert.equal(await broker.locator('[data-testid="final-emails"] tbody tr').count(), 1);
      assert.match(await broker.locator('[data-testid="final-emails"] tbody tr').first().innerText(), /Excel \+ PDF/);

      // Lines: Alpha writes 60, Beta writes 60 — signed down to 50 each.
      await broker.click('.rp-viewswitch button:has-text("Lines")');
      await broker.waitForSelector('[data-testid="final-lines"]', { timeout: 15000 });
      await broker.fill(`input[aria-label="Alpha Re ${tag} written Layer 1"]`, '60');
      await broker.fill(`input[aria-label="Beta Re ${tag} written Layer 1"]`, '60');
      await broker.click('[data-testid="save-lines"]');
      await broker.waitForSelector('[data-testid="final-note"]:has-text("Lines saved")', { timeout: 15000 });
      await broker.waitForSelector('[data-testid="final-lines"]:has-text("signed down")', { timeout: 15000 });
      const sheet = await broker.locator('[data-testid="final-lines"]').innerText();
      assert.match(sheet, /120%/, 'written total');
      assert.match(sheet, /signed down/);
      assert.equal((sheet.match(/50%/g) || []).length >= 2, true, 'both signed down to 50%');

      await broker.click('[data-testid="confirm-shares"]');
      await broker.waitForSelector('[data-testid="final-note"]:has-text("Shares confirmed")', { timeout: 20000 });
      await broker.waitForSelector('[data-testid="final-placement"]:has-text("every line is signed")', { timeout: 15000 });
      assert.match(await broker.locator('[data-testid="final-placement"]').innerText(), /every line is signed/i);
      assert.match(await broker.locator('[data-testid="final-placement"] .np-struct-card-hint').first().innerText(), /confirmed/);
    });

    await step('an underwriter reads the board but cannot move it', async () => {
      await uw.goto(`${BASE}/placements/${pid}`, { waitUntil: 'networkidle' });
      await uw.click('.wizard-tab:has-text("Quoting Stage")');
      await uw.waitForSelector('[data-testid="neg-tabs"]');
      await uw.waitForSelector('[data-testid="neg-workbook"]', { timeout: 15000 });
      assert.equal(await uw.locator('[data-testid="send-pack"]').count(), 0, 'the pack is readable, not sendable');
      await negTab(uw, 'Emails');
      assert.equal(await uw.locator('button:has-text("Send pack to market")').count(), 0);
      await negTab(uw, 'Sent to reinsurers');
      await uw.waitForSelector('[data-testid="neg-register"]');
      assert.equal(await uw.locator('button[aria-label^="Withdraw"]').count(), 0);
      await negTab(uw, 'Responses & Quotes');
      assert.match(await boardCard(uw, 'Structure 1').innerText(), /USD 372,000/, 'the quotes are readable');
      assert.match(await uw.locator('[data-testid="neg-by-reinsurer"]').innerText(), /USD 372,000/, 'so are the reinsurer cards');
      assert.equal(await uw.locator('.neg-cell--empty').count(), 0, 'no empty cell invites a quote');
      assert.equal(await uw.locator('[data-testid="different-structure"]').count(), 0);
      assert.equal(await uw.locator('[data-testid="quote-kind"]').count(), 0, 'lead quote or indication is read, not switched');
    });
  } catch (e) {
    errors.push(`negotiation spec crashed: ${e.message}`);
  } finally {
    await browser.close();
  }
  return errors;
}
