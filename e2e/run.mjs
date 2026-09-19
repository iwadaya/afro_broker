// Runs every e2e spec sequentially and exits non-zero if any reports an error.
// Specs assume a seeded backend + the frontend dev server are already running
// (see e2e/README.md or the CI workflow).
import flow from './flow.mjs';
import signing from './signing.mjs';
import features from './features.mjs';
import structures from './structures.mjs';
import ingest from './ingest.mjs';
import packs from './packs.mjs';
import retentions from './retentions.mjs';
import modelling from './modelling.mjs';
import negotiation from './negotiation.mjs';
import wordings from './wordings.mjs';
import spine from './spine.mjs';
import finalization from './finalization.mjs';
import detail from './detail.mjs';
import renewalPacks from './renewalPacks.mjs';
import dfa from './dfa.mjs';
import { launch, BASE } from './lib.mjs';

// Warm up the (dev) server so its first on-demand compile doesn't count against
// the first spec's timeouts — otherwise cold start can flake the run.
async function warmup() {
  const b = await launch();
  try {
    const p = await b.newPage();
    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
    await p.waitForSelector('button:has-text("Sign in")', { timeout: 60000 });
  } finally {
    await b.close();
  }
}

await warmup();

const specs = [flow, signing, features, detail, structures, ingest, packs, retentions, modelling, negotiation, wordings, spine, finalization, renewalPacks, dfa];
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
