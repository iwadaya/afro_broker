/**
 * Property Cat XL — non-proportional term schema (§1.3, D9).
 *
 * D9 picks this for coverage, not volume: it exercises nearly every
 * non-proportional field — attachment, limit, layering, the reinstatement
 * schedule, EGNPI, rate and the hours clause — and the reinstatement logic is
 * the hard part of M11 regardless, so it gets built once and reused.
 *
 * Money is integer minor units (§2.6); `terms.currency` names the currency for
 * every amount in the document. `money_paths` tells the canonicaliser which
 * fields are amounts, so it never has to guess which numbers are money.
 */

const money = (description) => ({
  type: 'integer',
  minimum: 0,
  description: `${description} — integer minor units of terms.currency (§2.6)`,
});

const pct = (description, max = 100) => ({
  type: 'number', minimum: 0, maximum: max, description,
});

export const PROPERTY_CAT_XL = {
  treaty_type: 'PROPERTY_CAT_XL',
  cob: 'Property',
  basis: 'NP',
  version: 1,
  // Complete at FOT (M8). Everything M11's formulas read that a quote is not
  // obliged to state up front:
  //   RI premium = (recovery / limit) x reinstatement_rate x premium  -> reinstatements
  //   final premium = actual GNPI x rate                              -> egnpi
  //   adjustment = final premium - premium already paid (MDP)         -> mdp
  // deductible, limit, rate and brokerage are required from the first
  // submission, so they are not repeated here.
  fot_required: ['reinstatements', 'egnpi', 'mdp'],
  money_paths: [
    'deductible', 'limit', 'egnpi', 'mdp',
    'aggregate_limit', 'aggregate_deductible',
    'mdp_instalments[].amount',
  ],
  schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Property Cat XL terms',
    type: 'object',
    additionalProperties: false,
    required: ['deductible', 'limit', 'currency', 'rate_pct', 'rate_type', 'brokerage_pct'],
    properties: {
      currency: { type: 'string', minLength: 3, maxLength: 3 },

      // Attachment and limit.
      deductible: money('Attachment / priority'),
      limit: money('Layer limit'),
      layer_no: { type: 'integer', minimum: 1 },
      layer_of: { type: 'integer', minimum: 1 },

      // Reinstatements. An empty array means none; omitted means not yet stated.
      //
      // `count` is HOW MANY reinstatements sit at this rate; `rate_pct` is what
      // they cost. A free reinstatement is therefore rate 0, not count 0 — the
      // two say different things, and conflating them loses one of them.
      //
      // Unlimited reinstatements get their own flag rather than a large
      // integer: "999" would be arithmetically wrong in the aggregate-limit
      // reconciliation below, and indistinguishable from a typo.
      reinstatements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rate_pct'],
          properties: {
            count: { type: 'integer', minimum: 1, description: 'How many reinstatements at this rate' },
            unlimited: { type: 'boolean', description: 'Unlimited reinstatements at this rate' },
            rate_pct: pct('Rate: 100 for the 1st, 50 for the 2nd, 0 for a free reinstatement', 1000),
            // A slip may specify either, both, or neither, so both are plain
            // optional booleans. No `default` keyword: ajv is configured not to
            // apply defaults, so declaring one would promise a value that never
            // materialises and leave the reader to guess which way it went.
            pro_rata_time: { type: 'boolean' },
            pro_rata_amount: { type: 'boolean' },
          },
          // Countable or unlimited — one or the other, and one of them always.
          oneOf: [
            { required: ['count'], not: { required: ['unlimited'] } },
            { required: ['unlimited'], not: { required: ['count'] } },
          ],
        },
      },

      // Rating.
      rate_pct: pct('Rate on EGNPI', 1000),
      rate_type: { enum: ['FLAT', 'SWING', 'VARIABLE'] },
      // A swing rate is meaningless without its bounds; conditionally required below.
      swing_min_pct: pct('Swing rate minimum', 1000),
      swing_max_pct: pct('Swing rate maximum', 1000),
      egnpi: money('Estimated gross net premium income'),

      // Premium.
      mdp: money('Minimum and deposit premium'),
      mdp_instalments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['due_date', 'amount'],
          properties: {
            // A pattern rather than `format: 'date'`: ajv ignores unknown
            // formats unless ajv-formats is loaded, so the format keyword
            // would silently accept anything.
            due_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            amount: money('Instalment amount'),
          },
        },
      },

      // Aggregates. Nullable per §1.3 — many layers carry neither.
      aggregate_limit: { ...money('Aggregate limit'), nullable: true },
      aggregate_deductible: { ...money('Aggregate deductible'), nullable: true },

      // Loss occurrence.
      loss_occurrence: { type: 'string', description: 'Loss occurrence definition' },
      hours_clause: { type: 'integer', minimum: 0, description: 'Hours clause, in hours' },

      // D2 — brokerage sits on the structure terms and versions with them.
      brokerage_pct: pct('Brokerage'),
    },

    allOf: [
      {
        // A layer that says "2 of 4" must say both.
        if: { required: ['layer_no'] },
        then: { required: ['layer_of'] },
      },
      {
        // A swing rate without its min and max cannot be adjusted at year end
        // (M11), which is the only reason to write a swing rate down.
        if: { properties: { rate_type: { const: 'SWING' } }, required: ['rate_type'] },
        then: { required: ['swing_min_pct', 'swing_max_pct'] },
      },
    ],
  },
};
