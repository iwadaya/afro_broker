// Builds the tokens.css the design-system previews expect (they reference the
// raw token names: --bg0, --accent, --space-3, --radius-lg, --shadow-pane …) from
// docs/broking/design-system/tokens.json — light on :root, dark under [data-theme].
import { readFileSync } from 'node:fs';

export function buildPreviewTokensCss(tokensJsonPath) {
  const t = JSON.parse(readFileSync(tokensJsonPath, 'utf8'));
  const light = []; const dark = []; const common = [];
  for (const c of t.color.tokens) { light.push(`--${c.name}:${c.value.light}`); dark.push(`--${c.name}:${c.value.dark}`); }
  for (const s of t.shadow.tokens) { light.push(`--${s.name}:${s.value.light}`); dark.push(`--${s.name}:${s.value.dark}`); }
  for (const s of t.spacing.tokens) common.push(`--${s.name}:${s.value}`);
  for (const r of t.radius.tokens) common.push(`--${r.name}:${r.value}`);
  common.push(`--font-sans:${t.type.families.sans}`, `--font-mono:${t.type.families.mono}`);
  return `:root{${common.join(';')};${light.join(';')}}\n:root[data-theme="dark"],:root[data-theme="midnight"]{${dark.join(';')}}\n`;
}
