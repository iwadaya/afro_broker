import { chromium } from 'playwright';

export const BASE = process.env.BASE_URL || 'http://localhost:5173';

// Use an explicit Chromium binary when provided (e.g. the pre-installed browser
// in some sandboxes); otherwise let Playwright use its managed install.
const EXEC = process.env.PW_CHROMIUM || undefined;
const LAUNCH = {
  headless: false,
  args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
  ...(EXEC ? { executablePath: EXEC } : {}),
};

// The seed gives every demo user one password (DEMO_PASSWORD, default demo2026).
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo2026';
export const CREDENTIALS = {
  broker: { email: 'broker@broking.local', password: DEMO_PASSWORD },
  senior: { email: 'senior@broking.local', password: DEMO_PASSWORD },
  uw: { email: 'uw@broking.local', password: DEMO_PASSWORD },
  admin: { email: 'admin@broking.local', password: DEMO_PASSWORD },
};

export async function launch() {
  return chromium.launch(LAUNCH);
}

/** Open a logged-in page for a role, recording console/page errors into `sink`. */
export async function login(browser, role, sink) {
  // acceptDownloads so specs can exercise file exports.
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => sink.push(`${role} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') sink.push(`${role} console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const c = CREDENTIALS[role];
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('input[placeholder=email]', c.email);
  await page.fill('input[placeholder=password]', c.password);
  await page.click('button:has-text("Sign in")');
  // The top bar is always visible in the signed-in shell, so wait on it.
  await page.waitForSelector('.topbar', { timeout: 15000 });
  return page;
}

/** The dashboard is the hub: Home in the top bar, then the destination's
    pill in the launcher. 'Dashboard' is Home itself; 'Admin' has no pill and
    lives in the top bar's account menu instead. */
export async function goHub(page, label) {
  await page.waitForSelector('.topbar-home');
  if (label === 'Admin') {
    await page.click('.topbar-account');
    await page.waitForSelector('.account-menu');
    await page.click('.account-menu >> text=Admin');
  } else {
    await page.click('.topbar-home');
    await page.waitForSelector('.launcher');
    if (label !== 'Dashboard') await page.click(`.launcher >> text="${label}"`);
  }
  await page.waitForTimeout(300);
}

export function makeStep(sink) {
  return async function step(name, fn) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}: ${e.message}`); sink.push(`${name}: ${e.message}`); }
  };
}

/** Drive a placement to an authorised FOT, returning the layer page URL. */
export async function buildLayerToFotAuthorised(broker, uw, { tag, order = 100, premium = 1_000_000, markets = ['Lead', 'A', 'B', 'C'], rol = 0.05, attachment, limit, reinstatements, reinstatementPct }) {
  const names = markets.map((m) => `${m} ${tag}`);

  // Register the cedant through the API with a GB domicile, so the placement
  // page's country → cedant dropdowns offer it under United Kingdom; then
  // the reinsurers on the Markets → Reinsurers tab.
  await broker.evaluate(async (name) => {
    const r = await fetch('/api/cedants', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('ub_token')}` },
      body: JSON.stringify({ name, domicile: 'GB' }),
    });
    if (!r.ok) throw new Error(`cedant registration failed: ${r.status}`);
  }, `Cedant ${tag}`);

  await goHub(broker, 'Markets');
  await broker.waitForSelector('text=Market register');
  for (const n of names) {
    const mf = broker.locator('section:has-text("Add a reinsurer") form').first();
    await mf.locator('input').first().fill(n);
    await mf.locator('button:has-text("Add reinsurer")').click();
    await broker.waitForTimeout(250);
  }

  // Create the placement on the placement page — /placements/new is the same
  // screen as a saved placement, set up in memory until Create Placement.
  // Wait for OUR cedant to appear in the dropdown (the register fetch may
  // lag the render) and select it explicitly.
  await broker.goto(`${BASE}/placements/new`, { waitUntil: 'networkidle' });
  const fr = (label) => broker.locator('.fr', { has: broker.locator('.fr-label', { hasText: label }) }).first();
  // The dropdowns are the Universe lookups, bound by row id, so each is picked
  // by the name it shows rather than a code.
  await fr('Country').locator('select').selectOption({ label: 'United Kingdom' });
  const cedantSelect = fr('Cedant Name').locator('select');
  // Options inside a collapsed <select> are not "visible", so wait for ATTACHED,
  // not the default visible state, before selecting.
  await cedantSelect.locator(`option:has-text("Cedant ${tag}")`).waitFor({ state: 'attached', timeout: 10000 });
  await cedantSelect.selectOption({ label: `Cedant ${tag}` });
  await fr('Treaty Type').locator('select').selectOption({ label: 'CAT XL' });
  await broker.click('.cob-trigger');
  await broker.click('.cob-item:has-text("Property")');
  await broker.click('button:has-text("Done")');
  await fr('Treaty Inception Date').locator('input').fill('2026-01-01');
  await fr('Treaty Renewal Date').locator('input').fill('2026-12-31');
  await broker.click('button:has-text("Create Placement")');
  await broker.waitForURL(/\/placements\/[0-9a-f-]{36}$/, { timeout: 30000 });
  // Layers live on the Quote Structure tab (its key, since "Structure" is also a
  // substring of "Expiring Structure").
  await broker.waitForSelector('.wizard-tab[data-tab=structure]');
  await broker.click('.wizard-tab[data-tab=structure]');
  await broker.waitForSelector('text=Structures to Quote');

  // Count-driven quote structures: work inside Structure 1's section (add a
  // row, fill it — cells carry a data-col so added columns can't shift these
  // — then save).
  const qs = broker.locator('section.np-struct-card:has-text("Structure 1")');
  await qs.locator('button:has-text("Add layer")').click();
  await qs.locator('tbody [data-col=name]').first().fill('Layer 1');
  await qs.locator('tbody [data-col=order]').first().fill(String(order));
  await qs.locator('tbody [data-col=premium]').first().fill(String(premium));
  if (limit != null) await qs.locator('tbody [data-col=limit]').first().fill(String(limit));
  if (attachment != null) await qs.locator('tbody [data-col=attachment]').first().fill(String(attachment));
  if (reinstatements != null) await qs.locator('tbody select[data-col=reinstatements]').first().selectOption(String(reinstatements));
  if (reinstatementPct != null) await qs.locator('tbody [data-col=reinstatementPct]').first().fill(String(reinstatementPct));
  await broker.click('button:has-text("Save structure")');
  await broker.waitForTimeout(600);

  // Status-transition buttons were removed from the Treaty Detail tab (to be
  // re-homed in the UI), so drive the lifecycle through the API directly.
  const placementId = broker.url().split('/').pop();
  for (const s of ['DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED']) {
    await broker.evaluate(async ([pid, status]) => {
      const r = await fetch(`/api/placements/${pid}/transition`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${localStorage.getItem('ub_token')}`,
        },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error(`transition to ${status} failed: ${r.status}`);
    }, [placementId, s]);
  }

  await broker.click('.wizard-tab[data-tab=structure]');
  await broker.waitForSelector('section.np-struct-card:has-text("Structure 1") tbody a.np-layer-badge');
  await broker.click('section.np-struct-card:has-text("Structure 1") tbody a.np-layer-badge');
  await broker.waitForSelector('text=Quote board');
  await broker.click('button:has-text("Market operations")');
  await broker.waitForSelector('section:has-text("Quote board") form');
  const layerUrl = broker.url();

  // Approach markets (first = lead)
  for (let i = 0; i < names.length; i++) {
    const qf = broker.locator('section:has-text("Quote board") form');
    await qf.locator('select').nth(0).selectOption({ label: names[i] });
    await qf.locator('select').nth(1).selectOption(i === 0 ? 'lead' : 'follow');
    await qf.locator('button:has-text("Approach market")').click();
    await broker.waitForTimeout(350);
  }

  // FOT propose (broker) + authorise (uw)
  const fotForm = broker.locator('section:has-text("Firm Order Terms") form');
  await fotForm.locator('input[type=number]').fill(String(rol));
  await fotForm.locator('button:has-text("Propose FOT")').click();
  await broker.waitForTimeout(400);
  await uw.goto(layerUrl, { waitUntil: 'networkidle' });
  // Wait on the action itself rather than the section's heading text.
  await uw.waitForSelector('button:has-text("Authorise (4-eyes)")');
  await uw.click('button:has-text("Authorise (4-eyes)")');
  await uw.waitForTimeout(500);

  return { layerUrl, names };
}
