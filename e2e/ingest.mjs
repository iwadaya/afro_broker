// Bordereau ingestion: auto-detect. Bordereaux arrive split (a premium file
// and a claims file) or as one sheet carrying both — the detection has to
// tell them apart. The engine is an API the pack builder and imports use;
// the Data tab of a placement no longer ingests anything, it reads the
// screens before it, so the detection is exercised through the API and the
// Data tab is checked for what it now is.
import assert from 'node:assert/strict';
import { launch, login, makeStep, BASE } from './lib.mjs';

const PREMIUM_ONLY = [
  'Policy No,Insured,Inception,Expiry,Sum Insured 100%,Premium Ceded to Surplus',
  'P-001,Acme Mills,2026-01-01,2026-12-31,5000000,12500',
  'P-002,Borak Foods,2026-02-01,2027-01-31,3000000,8000',
].join('\n');
const CLAIMS_ONLY = [
  'Claim No,Policy No,Insured,Date of Loss,Cause of Loss,Paid,Outstanding',
  'C-001,P-001,Acme Mills,2026-03-04,Fire,20000,5000',
].join('\n');
const COMBINED = [
  'Policy No,Insured,Inception,Expiry,Sum Insured 100%,Premium Ceded to Surplus,Claim No,Date of Loss,Paid,Outstanding',
  'P-001,Acme Mills,2026-01-01,2026-12-31,5000000,12500,C-001,2026-03-04,20000,5000',
  'P-002,Borak Foods,2026-02-01,2027-01-31,3000000,8000,C-002,2026-05-19,1000,15000',
].join('\n');

/** Preview a pasted CSV through the ingest API and detect its type. */
async function detect(page, csv) {
  return page.evaluate(async (text) => {
    const token = localStorage.getItem('ub_token');
    const call = (path, body) => fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const preview = await call('/ingest/preview', { csv: text, filename: 'Pasted CSV' });
    const detected = await call('/ingest/detect', { tables: preview.tables.map((t) => ({ name: t.name, headers: t.headers })) });
    return { preview, detected };
  }, csv);
}

export default async function run() {
  const errors = [];
  const step = makeStep(errors);
  const browser = await launch();
  console.log('ingest: bordereau auto-detect, and the Data tab that reads the screens');

  try {
    const broker = await login(browser, 'broker', errors);
    const placement = await broker.evaluate(async () => {
      const token = localStorage.getItem('ub_token');
      const call = (method, path, body) => fetch(`/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json());
      const cedant = await call('POST', '/cedants', { name: `Ingest Cedant ${Date.now()}`, domicile: 'Kenya' });
      return call('POST', '/placements', {
        cedant_id: cedant.id, class: 'Property QS', inception: '2026-01-01',
        expiry: '2026-12-31', currency: 'USD',
      });
    });

    await step('a premium-only sheet is detected as premium', async () => {
      const { preview, detected } = await detect(broker, PREMIUM_ONLY);
      assert.equal(preview.tables.length, 1);
      assert.equal(preview.tables[0].rows.length, 2);
      assert.equal(detected.tables[0].type, 'premium');
    });

    await step('a claims-only sheet is detected as claims', async () => {
      const { detected } = await detect(broker, CLAIMS_ONLY);
      assert.equal(detected.tables[0].type, 'claims');
    });

    await step('a combined sheet is detected as carrying both', async () => {
      const { detected } = await detect(broker, COMBINED);
      assert.ok(['both', 'combined'].includes(detected.tables[0].type), `combined sheet detected as ${detected.tables[0].type}`);
    });

    await step('the Data tab ingests nothing: it reads the screens and asks for the expiring pack of new business', async () => {
      await broker.goto(`${BASE}/placements/${placement.id}`, { waitUntil: 'networkidle' });
      await broker.click('.wizard-tab:has-text("Data")');
      await broker.waitForSelector('[data-testid="placement-data"]', { timeout: 15000 });
      assert.equal(await broker.locator('text=Ingest Bordereau').count(), 0, 'no ingest card on the Data tab');
      const screens = await broker.locator('[data-testid="data-screens"]').innerText();
      assert.match(screens, /Treaty Detail/);
      assert.match(screens, /Quote Structure/);
      const basis = await broker.locator('[data-testid="data-basis"]').innerText();
      assert.match(basis, /NEW BUSINESS/);
      assert.ok(await broker.locator('[data-testid="upload-expiring-pack"]').count() === 1, 'the expiring pack can be uploaded for a placement new to the house');
    });
  } finally {
    await browser.close();
  }
  return errors;
}
