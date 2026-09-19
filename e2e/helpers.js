// Shared e2e helpers: sign in through the real login screen, unique UMRs, API reads.
import { expect } from '@playwright/test';

export const USERS = {
  broker: { username: 'aabi.broker', password: 'aabi-broker-2026', displayName: 'Dar Chville' },
  admin: { username: 'aabi.admin', password: 'aabi-admin-2026' },
  other: { username: 'other.broker', password: 'other-broker-2026' },
};
export const SEED = {
  qss: { contractId: '00000000-0000-0000-0000-00000000c001', umr: 'B0621DAR26TR001' },
  catXl: { contractId: '00000000-0000-0000-0000-00000000c002', umr: 'B0621DAR26CX002' },
};

// One real sign-in per user per worker; later tests reuse the session (the auth
// cookies AND the web storage the client keeps its signed-in session in). A
// deployed server limits POST /api/auth/login to 10 per 15 minutes per IP, so the
// suite would otherwise lock itself out when pointed at E2E_BASE_URL.
const sessions = new Map();

const readStorage = (page) => page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));

export async function login(page, user = USERS.broker) {
  const cached = sessions.get(user.username);
  if (cached) {
    await page.context().addCookies(cached.cookies);
    await page.goto('/login');                             // a same-origin document, so storage is reachable
    await page.evaluate(({ local, session }) => {
      for (const [k, v] of local) localStorage.setItem(k, v);
      for (const [k, v] of session) sessionStorage.setItem(k, v);
    }, cached.storage);
    await page.goto('/');
    if (!page.url().includes('/login')) { await expect(page.getByRole('banner')).toBeVisible(); return; }
    sessions.delete(user.username);                        // session expired → sign in again
    await page.context().clearCookies();
  }
  await page.goto('/login');
  await page.fill('#login-user', user.username);
  await page.fill('#login-pass', user.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await expect(page.getByRole('banner')).toBeVisible();
  sessions.set(user.username, { cookies: await page.context().cookies(), storage: await readStorage(page) });
}

/** A fresh, valid UMR: B0621 + up to 12 [A-Z0-9] — unique per run so the suite is re-runnable. */
export function uniqueUmr(tag = 'E2E') {
  const stamp = Date.now().toString(36).toUpperCase().slice(-6);
  const rnd = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `B0621${tag}${stamp}${rnd}`.slice(0, 17);
}

export async function apiGet(page, path) {
  const res = await page.request.get(path);
  expect(res.ok(), `${path} → ${res.status()}`).toBeTruthy();
  return res.json();
}

export async function setTheme(page, theme) {
  await page.evaluate((t) => {
    try { window.localStorage.setItem('UNIVERSE3_THEME_V1', t); } catch { /* ignore */ }
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}
