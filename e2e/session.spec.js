// An expired or revoked cookie session sends the user back to sign-in with an
// explanation, and signing in again returns them to where they were.
import { test, expect } from '@playwright/test';
import { login, USERS } from './helpers.js';

test('an expired session returns to sign-in with a notice, then back to the page after signing in', async ({ page }) => {
  await login(page);
  await page.goto('/broking');
  await expect(page.getByRole('banner')).toBeVisible();
  await page.context().clearCookies();                      // the server-side session is gone as far as this browser is concerned
  await page.goto('/broking');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId('auth-notice')).toHaveText('Your session has expired. Sign in again to continue.');
  await page.fill('#login-user', USERS.broker.username);
  await page.fill('#login-pass', USERS.broker.password);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/broking$/);
  await expect(page.getByTestId('auth-notice')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New contract' })).toBeVisible();
});
