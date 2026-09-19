import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicNotice, parseAmount, parseDate, readClaimNotice, CLAIM_NOTICE_SCHEMA } from '../../src/modules/claims/claimNotice.llm.js';

const NOTICE = {
  source: 'cedant_claims_inbox',
  sender: 'j.kariuki@kenyare.co.ke',
  subject: 'Loss advice — Eldoret Textile Mills — Risk XL 2027 — reserve USD 4.2m',
  body: [
    'Dear Sirs,',
    'Treaty reference: KE-RXL-2027',
    'Claim reference: KR/CL/2027/0091',
    'Insured: Eldoret Textile Mills',
    'Date of loss: 02 September 2027',
    'Cause: Fire — carding hall',
    'Advised reserve: USD 4,200,000',
    'Paid to date: USD 0',
    'Class of business: Property',
    'Attaching layer: Layer 2',
    'Kind regards, J. Kariuki, Kenya Reinsurance Corporation',
  ].join('\n'),
};

test('amounts and dates read as cedants write them', () => {
  assert.equal(parseAmount('USD 4.2m'), 4200000);
  assert.equal(parseAmount('4,200,000'), 4200000);
  assert.equal(parseAmount('650k'), 650000);
  assert.equal(parseAmount('1.5 million'), 1500000);
  assert.equal(parseAmount(''), 0);
  assert.equal(parseDate('02 September 2027'), '2027-09-02');
  assert.equal(parseDate('September 2, 2027'), '2027-09-02');
  assert.equal(parseDate('2027-09-02'), '2027-09-02');
  assert.equal(parseDate('2/9/2027'), '2027-09-02');
  assert.equal(parseDate('soon'), '');
});

test('the keyword read pulls the labelled lines and every reference-like token', () => {
  const p = heuristicNotice(NOTICE);
  assert.equal(p.treaty_reference, 'KE-RXL-2027');
  assert.ok(p.references.includes('KE-RXL-2027'));
  assert.ok(p.references.includes('KR/CL/2027/0091'));
  assert.equal(p.cedant_reference, 'KR/CL/2027/0091');
  assert.equal(p.insured, 'Eldoret Textile Mills');
  assert.equal(p.date_of_loss, '2027-09-02');
  assert.equal(p.cause, 'Fire — carding hall');
  assert.equal(p.advised_reserve, 4200000);
  assert.equal(p.paid, 0);
  assert.equal(p.currency, 'USD');
  assert.equal(p.class, 'Property');
  assert.equal(p.attaching_layer, 'Layer 2');
});

test('the read falls back to the keywords when no provider is reachable, and says so', async () => {
  const p = await readClaimNotice(NOTICE, {});
  assert.equal(p.source, 'fallback');
  assert.equal(p.insured, 'Eldoret Textile Mills');
  assert.match(p.reason, /No AI provider/);
});

test('ChatGPT\'s read is taken when it answers, with the references it missed added from the text', async () => {
  const p = await readClaimNotice(NOTICE, {
    openai: async (args) => {
      assert.equal(args.schema, CLAIM_NOTICE_SCHEMA);
      assert.match(args.prompt, /Eldoret Textile Mills/);
      return { data: { treaty_reference: 'KE-RXL-2027', references: [], cedant_name: 'Kenya Reinsurance Corporation', cedant_reference: 'KR/CL/2027/0091', insured: 'Eldoret Textile Mills', cause: 'Fire', date_of_loss: '2 September 2027', advised_reserve: 4200000, paid: 0, outstanding: 4200000, currency: 'USD', class: 'Property', attaching_layer: 'Layer 2', summary: 'Fire at the mill.' }, model: 'gpt-test' };
    },
  });
  assert.equal(p.source, 'ai');
  assert.equal(p.date_of_loss, '2027-09-02', 'normalised');
  assert.ok(p.references.includes('KR/CL/2027/0091'));
});
