/**
 * Counterparty compliance — pure logic, no I/O.
 *
 * A market is only usable capacity if it clears three independent gates:
 *
 *   KYC       onboarding file approved and not expired
 *   Rating    a financial-strength rating that is present and not stale
 *   Security  the broker's own approved / watch / declined list
 *
 * Each gate resolves to a tone (`ok` | `attention` | `blocked`); the overall
 * status is the worst of the three, so a single blocking gate blocks the
 * counterparty regardless of how healthy the others look.
 */

/** Ratings we treat as investment-grade security for the "acceptable" flag. */
const ACCEPTABLE_RATING = /^(A|AA|AAA)([+-]|\+\+)?$/i;

/** A rating older than this is stale — agencies review at least annually. */
export const RATING_STALE_DAYS = 400;

/** KYC expiring within this window is flagged before it lapses. */
export const KYC_EXPIRING_DAYS = 60;

const TONE_RANK = { ok: 0, attention: 1, blocked: 2 };

/** The worst tone wins. */
export function worstTone(...tones) {
  return tones.reduce((worst, t) => (TONE_RANK[t] > TONE_RANK[worst] ? t : worst), 'ok');
}

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** KYC gate: approved and in date, or it needs work. */
export function kycStatus(market, now = new Date()) {
  const status = market.kyc_status || 'not_started';
  const expires = toDate(market.kyc_expires_at);
  const daysToExpiry = expires ? daysBetween(now, expires) : null;

  if (status === 'rejected') {
    return { gate: 'kyc', status, tone: 'blocked', detail: 'KYC rejected', days_to_expiry: daysToExpiry };
  }
  if (status === 'approved' && daysToExpiry != null && daysToExpiry < 0) {
    return { gate: 'kyc', status: 'expired', tone: 'blocked', detail: 'KYC lapsed — refresh required', days_to_expiry: daysToExpiry };
  }
  if (status === 'expired') {
    return { gate: 'kyc', status, tone: 'blocked', detail: 'KYC lapsed — refresh required', days_to_expiry: daysToExpiry };
  }
  if (status === 'approved') {
    const expiring = daysToExpiry != null && daysToExpiry <= KYC_EXPIRING_DAYS;
    return {
      gate: 'kyc',
      status,
      tone: expiring ? 'attention' : 'ok',
      detail: expiring ? `KYC expires in ${daysToExpiry} day(s)` : 'KYC approved',
      days_to_expiry: daysToExpiry,
    };
  }
  if (status === 'in_progress') {
    return { gate: 'kyc', status, tone: 'attention', detail: 'KYC in progress', days_to_expiry: daysToExpiry };
  }
  return { gate: 'kyc', status: 'not_started', tone: 'blocked', detail: 'KYC not started', days_to_expiry: daysToExpiry };
}

/** Rating gate: present, acceptable, and reviewed recently enough to trust. */
export function ratingStatus(market, now = new Date()) {
  const value = market.rating || null;
  const asOf = toDate(market.rating_as_of);
  const ageDays = asOf ? daysBetween(asOf, now) : null;
  const stale = ageDays != null ? ageDays > RATING_STALE_DAYS : asOf === null;
  const acceptable = value ? ACCEPTABLE_RATING.test(value.trim()) : false;

  if (!value) {
    return { gate: 'rating', value: null, tone: 'blocked', acceptable: false, stale: true, age_days: null, detail: 'No rating held' };
  }
  if (!acceptable) {
    return {
      gate: 'rating',
      value,
      tone: 'attention',
      acceptable: false,
      stale,
      age_days: ageDays,
      detail: `Rating ${value} is below the A- security threshold`,
    };
  }
  if (stale) {
    return {
      gate: 'rating',
      value,
      tone: 'attention',
      acceptable: true,
      stale: true,
      age_days: ageDays,
      detail: asOf ? `Rating ${value} last confirmed ${ageDays} day(s) ago` : `Rating ${value} has no confirmation date`,
    };
  }
  const outlook = market.rating_outlook;
  if (outlook === 'negative') {
    return { gate: 'rating', value, tone: 'attention', acceptable: true, stale: false, age_days: ageDays, detail: `Rating ${value} on negative outlook` };
  }
  return { gate: 'rating', value, tone: 'ok', acceptable: true, stale: false, age_days: ageDays, detail: `Rating ${value}${outlook ? ` (${outlook})` : ''}` };
}

/** Security gate: the broker's own approved / watch / declined list. */
export function securityStatus(market) {
  const status = market.security_status || 'approved';
  if (status === 'declined') {
    return { gate: 'security', status, tone: 'blocked', detail: 'On the declined-security list' };
  }
  if (status === 'watch') {
    return { gate: 'security', status, tone: 'attention', detail: 'On security watch' };
  }
  return { gate: 'security', status, tone: 'ok', detail: 'Security approved' };
}

/**
 * Full compliance picture for a market. `overall` is the worst gate; `can_place`
 * is false as soon as any gate blocks — that is the check placement should make
 * before approaching a market.
 */
export function complianceFor(market, now = new Date()) {
  const kyc = kycStatus(market, now);
  const rating = ratingStatus(market, now);
  const security = securityStatus(market);
  const overall = worstTone(kyc.tone, rating.tone, security.tone);
  return {
    kyc,
    rating,
    security,
    overall,
    can_place: overall !== 'blocked',
    blockers: [kyc, rating, security].filter((g) => g.tone === 'blocked').map((g) => g.detail),
  };
}
