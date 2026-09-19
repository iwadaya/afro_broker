// Runs every e2e spec sequentially and exits non-zero if any reports an error.
// Specs assume a seeded backend + the frontend dev server are already running
// (see e2e/README.md or the CI workflow).
import features from './features.mjs';
import contracts from './contracts.mjs';
import autologin from './autologin.mjs';
import { launch, BASE } from './lib.mjs';

// Warm up the (dev) server so its first on-demand compile doesn't count against
// the first spec's timeouts — otherwise cold start can flake the run.
async function warmup() {
  const b = await launch();
  try {
    const p = await b.newPage();
    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
    // The login form, or — with DEMO_AUTO_LOGIN — the signed-in shell.
    await p.waitForSelector('button:has-text("Sign in"), .topbar', { timeout: 60000 });
  } finally {
    await b.close();
  }
}

await warmup();

const specs = [autologin, contracts, features];
let failed = 0;

for (const spec of specs) {
  const errors = await spec();
  if (errors.length) {
    failed += errors.length;
    console.log('  FAILED:');
    for (const e of errors) console.log('   -', e);
  }
}

console.log('---');
if (failed) {
  console.log(`E2E FAILED with ${failed} issue(s)`);
  process.exit(1);
}
console.log('E2E PASSED — all specs green');
