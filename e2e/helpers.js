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

export async function login(page, user = USERS.broker) {
  await page.goto('/login');
  await page.fill('#login-user', user.username);
  await page.fill('#login-pass', user.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await expect(page.getByRole('banner')).toBeVisible();
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
