import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultDeadline, reminderDue, renderDeskEmail, deskSubject, longDate, isoDate,
} from '../../src/modules/analysis/renewalDesk.email.js';
import { summaryPdf, schedulePdf, deskFilename } from '../../src/modules/analysis/renewalDesk.pdf.js';

const analysis = {
  cedant_name: 'Kenya Reinsurance Corporation',
  class_of_business: 'Property, Engineering',
  treaty_type: 'Risk XL',
  analysed_at: '2026-11-06T09:14:00Z',
  verified_at: '2026-11-06T09:41:00Z',
  result: {
    programme: {
      treaty_name: 'Risk Excess of Loss — 2027', structure: 'USD 82.5m xs 2.5m', basis: 'Losses occurring',
      inception: '1 January 2027', expiry: '', currency: 'USD', layer_count: '6', epi: 'USD 96.4m',
      deposit_premium: '', retention: 'USD 2.5m each and every risk', prose: 'Six layers.',
    },
    layers: [{ name: 'Layer 1', cover: 'USD 2.5m xs 2.5m', deposit_premium: 'USD 1.65m', rol: '66%', reinstatements: '3 @ 100%', expiring_line: '' }],
    experience: [{ year: '2025', premium: 'USD 4.09m', incurred: 'USD 3.16m', loss_ratio: '77.3%' }],
    experience_note: 'One large loss.',
    changes: [{ area: 'Retention', change: 'Retention up.', direction: 'improved', significance: 'high', commentary: '' }],
    flags: [{ kind: 'missing', claim: 'No deposit premium stated.', source: 'Pack silent' }],
  },
};
const placement = { inception: '2027-01-01', reference: 'KE-RXL-2027' };

test('the default deadline is fourteen days out, rolled off a weekend', () => {
  assert.equal(defaultDeadline(new Date(2026, 10, 4)), '2026-11-18'); // Wed → Wed
  assert.equal(defaultDeadline(new Date(2026, 10, 7)), '2026-11-23'); // Sat → Sat, rolled to Mon
  assert.equal(defaultDeadline(new Date(2026, 10, 8)), '2026-11-23'); // Sun → Sun, rolled to Mon
});

test('the reminder is owed in the three days before the deadline, once, to those who have not replied', () => {
  const base = { deadline: '2026-11-20', status: 'sent', remindedAt: null, replied: false };
  assert.equal(reminderDue({ ...base, now: new Date(2026, 10, 16, 12) }), false, 'four days out is too early');
  assert.equal(reminderDue({ ...base, now: new Date(2026, 10, 17, 9) }), true, 'three days out');
  assert.equal(reminderDue({ ...base, now: new Date(2026, 10, 20, 23) }), true, 'the deadline day itself');
  assert.equal(reminderDue({ ...base, now: new Date(2026, 10, 21, 0, 1) }), false, 'past the deadline');
  assert.equal(reminderDue({ ...base, now: new Date(2026, 10, 18), remindedAt: '2026-11-17' }), false, 'once');
  assert.equal(reminderDue({ ...base, now: new Date(2026, 10, 18), replied: true }), false, 'not after a reply');
  assert.equal(reminderDue({ ...base, now: new Date(2026, 10, 18), status: 'pending_approval' }), false, 'only once sent');
  assert.equal(reminderDue({ ...base, deadline: null, now: new Date(2026, 10, 18) }), false);
  // A pg DATE arrives as a Date at local midnight.
  assert.equal(reminderDue({ ...base, deadline: new Date(2026, 10, 20), now: new Date(2026, 10, 18) }), true);
});

test('the subject names the cedant, the treaty and the renewal year once', () => {
  assert.equal(deskSubject({ analysis, placement }), 'Kenya Reinsurance Corporation — Risk Excess of Loss 2027 — Firm Order Terms Invited');
  const bare = { ...analysis, result: { programme: {} } };
  assert.equal(deskSubject({ analysis: bare, placement }), 'Kenya Reinsurance Corporation — Risk XL 2027 — Firm Order Terms Invited');
});

test('the covering email carries the verified figures and leaves out what the packs did not state', () => {
  const body = renderDeskEmail({
    analysis, placement, deadline: '2026-11-20', author: { name: 'Alice Njoroge' },
    documents: [{ filename: 'Kenya_Re_2027.xlsx' }],
  });
  assert.match(body, /^Dear \{\{contact_name\}\},/);
  assert.match(body, /2027 renewal of the Kenya Reinsurance Corporation Risk Excess of Loss — 2027 programme, incepting 1 January 2027/);
  assert.match(body, /Structure\s+6 layers — USD 82\.5m xs 2\.5m/);
  assert.match(body, /EPI\s+USD 96\.4m/);
  assert.match(body, /Retention\s+USD 2\.5m each and every risk/);
  assert.doesNotMatch(body, /Deposit premium/, 'a figure the packs did not state is not sent blank');
  assert.match(body, /1\. Renewal pack as received from the cedant \(Kenya_Re_2027\.xlsx\)/);
  assert.match(body, /by close of business Friday 20 November 2026\. Lines are invited on a signing-down basis; the order is 100% of each layer\./);
  assert.match(body, /Alice Njoroge\nUniverse Broking$/);
});

test('dates read as the email names them', () => {
  assert.equal(longDate('2026-11-20'), 'Friday 20 November 2026');
  assert.equal(isoDate(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(isoDate(''), null);
});

test('the verified summary and the schedule render as PDFs from the signed-off result', async () => {
  const summary = await summaryPdf({ analysis, verifiedBy: 'Alice Njoroge' });
  const schedule = await schedulePdf({ analysis, verifiedBy: 'Alice Njoroge' });
  assert.equal(summary.subarray(0, 4).toString(), '%PDF');
  assert.equal(schedule.subarray(0, 4).toString(), '%PDF');
  assert.ok(summary.length > schedule.length, 'the summary carries more than the schedule');
  assert.equal(deskFilename(analysis, 'summary'), 'Kenya_Reinsurance_Corporation_renewal_summary_verified.pdf');
  assert.equal(deskFilename(analysis, 'schedule'), 'Kenya_Reinsurance_Corporation_layer_schedule.pdf');
  // An older draft with none of the programme still renders, flagged.
  const old = await summaryPdf({ analysis: { ...analysis, result: { executive_summary: 'x' } }, verifiedBy: null });
  assert.equal(old.subarray(0, 4).toString(), '%PDF');
});
