import { query } from './pool.js';

/**
 * Decline reasons (M6, D4).
 *
 * D4: "recording a decline must be as fast as recording a quote — one click
 * plus a reason code. If declining is slower than ignoring, brokers ignore it,
 * and the negative examples the ML model depends on are never captured."
 *
 * This is a starter vocabulary, seeded into an admin-maintained table rather
 * than frozen into a constraint. The list a broking firm actually uses is
 * theirs to set; these are the reasons markets commonly give, and they are
 * meant to be edited.
 */
export const DECLINE_REASONS = [
  { code: 'CAPACITY', name: 'No capacity', description: 'Capacity exhausted or not available for this period' },
  { code: 'APPETITE', name: 'Outside appetite', description: 'Class, peril or risk profile not written' },
  { code: 'PRICE', name: 'Price inadequate', description: 'Rate or terms below the market’s technical minimum' },
  { code: 'TERRITORY', name: 'Territory not written', description: 'Territory outside the market’s licence or appetite' },
  { code: 'AGGREGATE', name: 'Aggregate committed', description: 'Zonal or PML aggregate already committed elsewhere' },
  { code: 'SECURITY', name: 'Cedant or security concern', description: 'Concerns over the cedant, its rating or its data' },
  { code: 'INFORMATION', name: 'Insufficient information', description: 'Submission incomplete or experience data inadequate' },
  { code: 'EXPERIENCE', name: 'Loss experience', description: 'Loss record does not support participation' },
  { code: 'TIMING', name: 'Received too late', description: 'Submission arrived after the market could respond' },
  { code: 'CONFLICT', name: 'Conflict', description: 'Existing relationship or conflict prevents participation' },
  { code: 'RELATIONSHIP', name: 'No relationship', description: 'Minimum relationship or lead criteria not met' },
];

/** Idempotent on code. An edited name or description is left alone. */
export async function seedDeclineReasons(runner = { query }) {
  let inserted = 0;
  for (const [i, r] of DECLINE_REASONS.entries()) {
    const { rows } = await runner.query(
      `INSERT INTO decline_reason (code, name, description, position)
       VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING RETURNING id`,
      [r.code, r.name, r.description, i],
    );
    if (rows[0]) inserted += 1;
  }
  return { inserted };
}
