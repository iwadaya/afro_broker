// Demo auto sign-in (DEMO_AUTO_LOGIN): a fresh visit lands on the dashboard
// signed in as the demo user, with no login screen; Sign out shows the
// login screen with a "Continue as" button that gives the session back;
// and a new tab is signed in again by itself. Skipped, not failed, when the
// server under test has auto sign-in off.
import assert from 'node:assert/strict';
import { BASE, launch, makeStep } from './lib.mjs';

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  console.log('autologin: a fresh visit is signed in as the demo user');

  const demo = await fetch(`${BASE}/api/auth/demo-users`).then((r) => r.json()).catch(() => null);
  if (!demo?.auto_login) {
    console.log('  - skipped: the server has no DEMO_AUTO_LOGIN');
    return errors;
  }
  const auto = demo.auto_login;
  const browser = await launch();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`autologin pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`autologin console: ${m.text()}`); });

    await step(`a fresh visit opens on the dashboard as ${auto.name}, with no login screen`, async () => {
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.waitForSelector('.topbar', { timeout: 15000 });
      assert.equal(await page.locator('.login').count(), 0, 'no login form');
      await page.waitForSelector('h2:has-text("Treaty renewal book")', { timeout: 10000 });
      assert.equal((await page.locator('.topbar-account-name').textContent()).trim(), auto.name);
      // A deep link is signed in the same way.
      await page.goto(`${BASE}/contracts`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid=contracts-proportional]', { timeout: 15000 });
    });

    await step('sign out shows the login screen, and "Continue as" gives the session back', async () => {
      await page.click('.topbar-account');
      await page.waitForSelector('.account-menu');
      await page.click('.account-menu >> text=Sign out');
      await page.waitForSelector('.login', { timeout: 10000 });
      // The login card carries the house logo too.
      const logo = page.locator('.login [data-testid=brand-logo]');
      await logo.waitFor({ timeout: 10000 });
      assert.ok(await logo.evaluate((img) => img.complete && img.naturalWidth > 0), 'the logo loaded on the login screen');
      // Signed out on purpose: a reload stays on the login screen.
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.login', { timeout: 10000 });
      assert.equal(await page.locator('.topbar').count(), 0, 'not signed back in behind the visitor\'s back');
      const btn = page.locator('[data-testid=auto-login]');
      await btn.waitFor({ timeout: 10000 });
      assert.equal((await btn.textContent()).trim(), `Continue as ${auto.name}`);
      await btn.click();
      await page.waitForSelector('.topbar', { timeout: 15000 });
      assert.equal((await page.locator('.topbar-account-name').textContent()).trim(), auto.name);
    });

    await step('a new tab is signed in by itself again', async () => {
      const fresh = await browser.newContext();
      const tab = await fresh.newPage();
      await tab.goto(`${BASE}/renewals`, { waitUntil: 'networkidle' });
      await tab.waitForSelector('h2:has-text("Renewal calendar")', { timeout: 15000 });
      assert.equal(await tab.locator('.login').count(), 0);
      await fresh.close();
    });
  } finally {
    await browser.close();
  }
  return errors;
}
