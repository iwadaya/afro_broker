import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  complianceFor,
  kycStatus,
  ratingStatus,
  securityStatus,
  worstTone,
  RATING_STALE_DAYS,
  KYC_EXPIRING_DAYS,
} from '../../src/domain/compliance.js';

const NOW = new Date('2026-06-01T00:00:00Z');
const daysFromNow = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** A counterparty that clears every gate. */
const clean = (over = {}) => ({
  kyc_status: 'approved',
  kyc_expires_at: daysFromNow(365),
  rating: 'A+',
  rating_as_of: daysFromNow(-30),
  rating_outlook: 'stable',
  security_status: 'approved',
  ...over,
});

test('a clean counterparty clears every gate', () => {
  const c = complianceFor(clean(), NOW);
  assert.equal(c.kyc.tone, 'ok');
  assert.equal(c.rating.tone, 'ok');
  assert.equal(c.security.tone, 'ok');
  assert.equal(c.overall, 'ok');
  assert.equal(c.can_place, true);
  assert.deepEqual(c.blockers, []);
});

test('KYC: not started and rejected block; in progress needs attention', () => {
  assert.equal(kycStatus({ kyc_status: 'not_started' }, NOW).tone, 'blocked');
  assert.equal(kycStatus({}, NOW).tone, 'blocked', 'absent status defaults to not_started');
  assert.equal(kycStatus({ kyc_status: 'rejected' }, NOW).tone, 'blocked');
  assert.equal(kycStatus({ kyc_status: 'in_progress' }, NOW).tone, 'attention');
});

test('KYC: an approved file past its expiry is treated as expired', () => {
  const k = kycStatus({ kyc_status: 'approved', kyc_expires_at: daysFromNow(-1) }, NOW);
  assert.equal(k.status, 'expired');
  assert.equal(k.tone, 'blocked');
  assert.equal(k.days_to_expiry, -1);
});

test('KYC: expiry inside the warning window flags before it lapses', () => {
  const soon = kycStatus({ kyc_status: 'approved', kyc_expires_at: daysFromNow(KYC_EXPIRING_DAYS - 1) }, NOW);
  assert.equal(soon.tone, 'attention');
  const later = kycStatus({ kyc_status: 'approved', kyc_expires_at: daysFromNow(KYC_EXPIRING_DAYS + 1) }, NOW);
  assert.equal(later.tone, 'ok');
});

test('KYC: approved with no expiry date recorded stays ok', () => {
  const k = kycStatus({ kyc_status: 'approved' }, NOW);
  assert.equal(k.tone, 'ok');
  assert.equal(k.days_to_expiry, null);
});

test('rating: absent blocks, sub-A flags, stale flags', () => {
  assert.equal(ratingStatus({}, NOW).tone, 'blocked');
  assert.equal(ratingStatus({ rating: 'BBB', rating_as_of: daysFromNow(-10) }, NOW).tone, 'attention');
  const stale = ratingStatus({ rating: 'A', rating_as_of: daysFromNow(-(RATING_STALE_DAYS + 1)) }, NOW);
  assert.equal(stale.tone, 'attention');
  assert.equal(stale.stale, true);
  assert.equal(stale.acceptable, true);
});

test('rating: an A-grade rating with no confirmation date counts as stale', () => {
  const r = ratingStatus({ rating: 'AA-' }, NOW);
  assert.equal(r.acceptable, true);
  assert.equal(r.stale, true);
  assert.equal(r.tone, 'attention');
});

test('rating: negative outlook flags an otherwise clean rating', () => {
  const r = ratingStatus({ rating: 'A+', rating_as_of: daysFromNow(-5), rating_outlook: 'negative' }, NOW);
  assert.equal(r.tone, 'attention');
  assert.equal(r.acceptable, true);
});

test('security: declined blocks, watch flags', () => {
  assert.equal(securityStatus({ security_status: 'declined' }).tone, 'blocked');
  assert.equal(securityStatus({ security_status: 'watch' }).tone, 'attention');
  assert.equal(securityStatus({}).tone, 'ok', 'absent status defaults to approved');
});

test('the overall status is the worst gate, and blockers are listed', () => {
  const c = complianceFor(clean({ security_status: 'declined', rating: 'BBB' }), NOW);
  assert.equal(c.overall, 'blocked');
  assert.equal(c.can_place, false);
  assert.equal(c.blockers.length, 1);
  assert.match(c.blockers[0], /declined-security/);
});

test('one flagged gate downgrades an otherwise clean counterparty to attention', () => {
  const c = complianceFor(clean({ security_status: 'watch' }), NOW);
  assert.equal(c.overall, 'attention');
  assert.equal(c.can_place, true);
});

test('worstTone ranks blocked over attention over ok', () => {
  assert.equal(worstTone('ok', 'ok'), 'ok');
  assert.equal(worstTone('ok', 'attention'), 'attention');
  assert.equal(worstTone('attention', 'blocked', 'ok'), 'blocked');
});
