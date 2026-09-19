import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchNotification, MATCH_THRESHOLD } from '../../src/modules/claims/claimMatch.js';

const KE = { placement_id: 'ke', reference: 'KE-RXL-2027', cedant_name: 'Kenya Reinsurance Corporation', class: 'Property Risk XL', inception: '2027-01-01', expiry: '2027-12-31', insureds: ['Athi River Cement Works', 'Nakuru Grain Silo Ltd'] };
const SG = { placement_id: 'sg', reference: 'SG-CAT-2027', cedant_name: 'Sanlam General Insurance Kenya', class: 'Property catastrophe', inception: '2027-01-01', expiry: '2027-12-31', insureds: [] };
const OLD = { placement_id: 'old', reference: 'KE-RXL-2026', cedant_name: 'Kenya Reinsurance Corporation', class: 'Property Risk XL', inception: '2026-01-01', expiry: '2026-12-31', insureds: [] };

test('the treaty reference matches first, and the date of loss and insured raise the confidence', () => {
  const bare = matchNotification({ treaty_reference: 'KE-RXL-2027' }, [SG, KE, OLD]);
  assert.equal(bare.candidate.placement_id, 'ke');
  assert.equal(bare.basis, 'treaty reference');
  assert.equal(bare.confidence, 0.9);
  assert.equal(bare.status, 'matched');

  const full = matchNotification(
    { treaty_reference: '', references: ['CL/2027/0091', 'KE-RXL-2027'], insured: 'Athi River Cement', date_of_loss: '2027-09-02' },
    [SG, KE, OLD],
  );
  assert.equal(full.candidate.placement_id, 'ke');
  assert.equal(full.basis, 'treaty reference, insured schedule and date of loss');
  assert.equal(full.confidence, 1);
});

test('without a reference, cedant with class and period matches; cedant and period alone is left for triage', () => {
  const m = matchNotification({ cedant_name: 'Kenya Re', class: 'Risk XL', date_of_loss: '2027-05-04' }, [SG, KE, OLD]);
  assert.equal(m.candidate.placement_id, 'ke', 'the 2027 year, not the expiring one');
  assert.equal(m.basis, 'cedant, class and period');
  assert.equal(m.confidence, 0.85);
  assert.equal(m.status, 'matched');

  const weak = matchNotification({ cedant_name: 'Kenya Re', date_of_loss: '2027-05-04' }, [SG, KE, OLD]);
  assert.equal(weak.candidate.placement_id, 'ke');
  assert.equal(weak.basis, 'cedant and period');
  assert.equal(weak.confidence, 0.7);
  assert.equal(weak.status, 'unmatched', 'below the threshold — never loaded on its own');
  assert.ok(weak.confidence < MATCH_THRESHOLD);
});

test('the insured schedule matches on its own, with the date of loss making it sure enough', () => {
  const dated = matchNotification({ insured: 'Nakuru Grain Silo', date_of_loss: '2027-03-12' }, [SG, KE]);
  assert.equal(dated.candidate.placement_id, 'ke');
  assert.equal(dated.basis, 'insured schedule and date of loss');
  assert.equal(dated.status, 'matched');
  const undated = matchNotification({ insured: 'Nakuru Grain Silo' }, [SG, KE]);
  assert.equal(undated.confidence, 0.6);
  assert.equal(undated.status, 'unmatched');
});

test('nothing to go on is unmatched, not a guess', () => {
  const none = matchNotification({ insured: 'Unknown Mills', cedant_name: 'Nobody Re' }, [SG, KE]);
  assert.equal(none.candidate, null);
  assert.equal(none.status, 'unmatched');
  assert.equal(matchNotification({ treaty_reference: 'KE-RXL-2027' }, []).candidate, null);
});
