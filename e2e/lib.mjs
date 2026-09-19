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
  // With DEMO_AUTO_LOGIN set the server signs a fresh visit in by itself, so
  // the shell appears instead of the form: sign out first, then sign in as
  // the role asked for.
  await page.waitForSelector('.topbar, .login', { timeout: 15000 });
  if (await page.locator('.topbar').count()) {
    await page.click('.topbar-account');
    await page.waitForSelector('.account-menu');
    await page.click('.account-menu >> text=Sign out');
    await page.waitForSelector('.login', { timeout: 15000 });
  }
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

/** Call the API as the signed-in user of `page` (its token is in localStorage). */
export async function apiAs(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('ub_token')}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    return r.status === 204 ? null : r.json();
  }, { method, path, body });
}
