// Component screenshots: each design-system preview.html (tokens.json + bundle.css)
// next to the same component rendered by the app (/broking/gallery), in Daylight
// and Midnight. Output: docs/broking/screenshots/components/<Name>.<source>.<theme>.png
//
//   npm run screenshots
import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { login, setTheme } from './helpers.js';
import { buildPreviewTokensCss } from './lib/previewTokens.js';

const ROOT = path.resolve(process.cwd());
const DS = path.join(ROOT, 'docs/broking/design-system');
const OUT = path.join(ROOT, 'docs/broking/screenshots/components');
const COMPONENTS = ['Badge', 'Button', 'FormRow', 'NumericInput', 'Pane', 'SlideTable', 'SummaryBar', 'TogglePill', 'WizardShell', 'IdentityField'];
const THEMES = [['daylight', 'light'], ['midnight', 'dark']];

const tokensCss = buildPreviewTokensCss(path.join(DS, 'tokens.json'));
const bundleCss = readFileSync(path.join(DS, 'components/bundle.css'), 'utf8');
mkdirSync(OUT, { recursive: true });

function previewHtml(name, themeId) {
  const raw = readFileSync(path.join(DS, `components/${name}/preview.html`), 'utf8');
  const height = Number((raw.match(/height=(\d+)/) || [])[1] || 300);
  const html = raw
    .replace(/<link rel="stylesheet" href="https:\/\/fonts[^>]*>/, '')                 // offline: system Inter fallback
    .replace('</head>', `<style>${tokensCss}\n${bundleCss}</style></head>`)
    .replace('<html lang="en">', `<html lang="en" data-theme="${themeId}">`);
  return { html, height };
}

for (const name of COMPONENTS) {
  test(`${name}: preview vs app in both themes`, async ({ page }) => {
    for (const [theme, id] of THEMES) {
      const { html, height } = previewHtml(name, id);
      await page.setViewportSize({ width: 960, height: Math.max(120, height) });
      await page.setContent(html, { waitUntil: 'load' });
      await page.screenshot({ path: path.join(OUT, `${name}.preview.${theme}.png`), fullPage: false });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    for (const [theme] of THEMES) {
      await page.goto('/broking/gallery');
      await setTheme(page, theme);
      const section = page.locator(`[data-gallery="${name}"]`);
      await expect(section).toBeVisible();
      await section.screenshot({ path: path.join(OUT, `${name}.app.${theme}.png`) });
    }
  });
}
