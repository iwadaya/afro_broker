import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderSubmissionEmail, renderSubject, personalise, isoDay,
} from '../../src/modules/negotiation/submissionEmail.js';
import { fallbackParagraphs, buildPrompt } from '../../src/modules/negotiation/commentary.js';

const placement = {
  reference: 'UB-2027-MERI-A1', class: 'Property Cat XoL', currency: 'USD',
  inception: '2027-01-01', expiry: '2027-12-31',
};
const cedant = { name: 'Meridian Insurance' };
const pack = {
  version: 3,
  status: 'approved',
  summary: {
    basis: 'NP', premium_ceded: 4_200_000, sum_insured_100: 980_000_000,
    incurred: 1_550_000, loss_ratio_pct: 36.9,
  },
};
const wording = { title: 'Property Cat XoL wording', status: 'issued', clause_count: 24 };
const structures = [
  {
    index: 1,
    label: 'Structure 1',
    basis: 'NP',
    lines: [
      { label: 'Layer 1', basis: 'NP', limit: 5_000_000, attachment: 1_000_000, asked: { premium: 400_000, rate_pct: 8 } },
      { label: 'Layer 2', basis: 'NP', limit: 10_000_000, attachment: 6_000_000, asked: { premium: 250_000 } },
    ],
  },
  {
    index: 2,
    label: 'Structure 2',
    basis: 'PROP',
    lines: [{ label: 'QS', basis: 'PROP', capacity: 4_000_000, asked: { commission_pct: 30, epi: 9_000_000 } }],
  },
];

test('dates render as ISO days, whatever pg hands back', () => {
  assert.equal(isoDay('2027-01-01T00:00:00.000Z'), '2027-01-01');
  assert.equal(isoDay(new Date(2027, 0, 1)), '2027-01-01', 'a DATE column comes back as a Date at local midnight');
  assert.equal(isoDay(null), '—');
});

test('the subject names the cedant, class, period and pack version', () => {
  assert.equal(
    renderSubject({ placement, cedant, pack }),
    'Meridian Insurance — Property Cat XoL — 2027-01-01 to 2027-12-31 — renewal pack v3',
  );
});

test('the covering email quotes only pack figures and keeps the salutation a token', () => {
  const body = renderSubmissionEmail({
    placement, cedant, pack, structures, wording, commentary: 'Commentary paragraph.', author: { name: 'A Broker' },
  });
  assert.match(body, /^Dear \{\{contact_name\}\},/);
  assert.match(body, /RE: Meridian Insurance — Property Cat XoL — 2027-01-01 to 2027-12-31 \(USD\)/);
  assert.match(body, /Commentary paragraph\./);
  assert.match(body, /Structure 1 — non-proportional/);
  assert.match(body, /Layer 1: 5,000,000 xs 1,000,000, premium 400,000, rate 8%/);
  assert.match(body, /Structure 2 — proportional/);
  assert.match(body, /QS — capacity 4,000,000, commission 30%, EPI 9,000,000/);
  assert.match(body, /Ceded premium: USD 4,200,000/);
  assert.match(body, /Loss ratio: 36\.9%/);
  assert.match(body, /Renewal pack v3$/m, 'an approved pack is not flagged as a draft');
  assert.match(body, /Wording: Property Cat XoL wording \(issued\)/);
  assert.match(body, /A Broker\nUniverse Broking$/);
});

test('a draft pack and a missing wording are stated, not hidden', () => {
  const body = renderSubmissionEmail({
    placement, cedant, pack: { ...pack, status: 'draft' }, structures, wording: null, commentary: 'x', author: null,
  });
  assert.match(body, /Renewal pack v3 \(draft\)/);
  assert.match(body, /Wording: to follow/);
  assert.match(body, /The broking team/);
});

test('tokens resolve per recipient, with a neutral fallback', () => {
  const body = 'Dear {{contact_name}}, we approach {{market_name}}.';
  assert.equal(personalise(body, { contactName: 'Jo', marketName: 'Helvetia Re' }), 'Dear Jo, we approach Helvetia Re.');
  assert.equal(personalise(body, {}), 'Dear Underwriter, we approach your syndicate.');
});

test('the offline commentary states only pack facts and brackets the judgement calls', () => {
  const paragraphs = fallbackParagraphs({ placement, cedant, pack, structures, wording });
  assert.equal(paragraphs.length, 3);
  const text = paragraphs.join('\n\n');
  assert.match(text, /Property Cat XoL programme of Meridian Insurance/);
  assert.match(text, /ceded premium of USD 4,200,000 against incurred of USD 1,550,000, a loss ratio of 36\.9%/);
  assert.match(text, /Structure 1 \(non-proportional, 2 layers\) and Structure 2 \(proportional\)/);
  assert.ok((text.match(/\[/g) || []).length >= 3, 'every judgement call is handed back to the broker');
});

test('with nothing in the pack yet, the commentary says so instead of stating zeros', () => {
  const empty = { ...pack, summary: { basis: 'NP', premium_ceded: 0, incurred: null } };
  const text = fallbackParagraphs({
    placement: { ...placement, inception: new Date(2027, 0, 1) }, cedant, pack: empty, structures, wording,
  }).join('\n\n');
  assert.doesNotMatch(text, /USD 0/);
  assert.match(text, /experience is set out in the attached pack/);
  assert.match(text, /incepting 2027-01-01/, 'a DATE column is not printed raw');
});

test('the model is handed computed figures only — no rows, no prices to invent', () => {
  const prompt = JSON.parse(buildPrompt({ placement, cedant, pack, structures, wording }));
  assert.equal(prompt.placement.cedant, 'Meridian Insurance');
  assert.equal(prompt.renewal_pack.version, 3);
  assert.equal(prompt.renewal_pack.computed_figures.loss_ratio_pct, 36.9);
  assert.equal(prompt.structures_to_quote.length, 2);
  assert.equal(prompt.structures_to_quote[0].lines.length, 2);
  assert.equal(prompt.wording.title, 'Property Cat XoL wording');
});
