/**
 * Property Surplus — proportional term schema (§1.3, D9).
 *
 * D9 picks Surplus rather than Quota Share deliberately: Surplus is the
 * demanding proportional shape — lines, retention, max cession, sliding-scale
 * commission, profit commission — and Quota Share is a near-subset that falls
 * out cheaply afterwards. Building QS first does not give you Surplus.
 *
 * Money is integer minor units (§2.6); `terms.currency` names the currency.
 */

const money = (description) => ({
  type: 'integer',
  minimum: 0,
  description: `${description} — integer minor units of terms.currency (§2.6)`,
});

const pct = (description, max = 100) => ({
  type: 'number', minimum: 0, maximum: max, description,
});

export const PROPERTY_SURPLUS = {
  treaty_type: 'PROPERTY_SURPLUS',
  cob: 'Property',
  basis: 'PROP',
  version: 1,
  // Complete at FOT (M8). M11 defers proportional claims and premium, so this
  // is the smaller set: the premium base, and a commission stated one way or
  // the other — a firm order that does not say what it pays is not firm.
  fot_required: ['epi', ['commission_pct', 'sliding_scale']],
  money_paths: ['retention', 'max_cession', 'epi', 'event_limit'],
  schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Property Surplus terms',
    type: 'object',
    additionalProperties: false,
    required: ['retention', 'currency', 'brokerage_pct'],
    properties: {
      currency: { type: 'string', minLength: 3, maxLength: 3 },

      // Cession. A surplus cedes in lines of the retention; a quota share cedes
      // a flat percentage. §1.3 allows either, so exactly one must be present.
      lines_ceded: { type: 'number', minimum: 0, description: 'Number of lines (surplus)' },
      cession_pct: pct('Flat cession'),

      retention: money('Cedant retention, one line'),
      max_cession: money('Maximum cession'),

      // Commission. Either a flat rate or a sliding scale, not both.
      commission_pct: pct('Flat ceding commission'),
      sliding_scale: {
        type: 'object',
        additionalProperties: false,
        required: ['provisional_pct', 'min_pct', 'max_pct', 'bands'],
        properties: {
          provisional_pct: pct('Provisional commission'),
          min_pct: pct('Minimum commission'),
          max_pct: pct('Maximum commission'),
          bands: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['loss_ratio_from_pct', 'loss_ratio_to_pct', 'commission_pct'],
              properties: {
                loss_ratio_from_pct: pct('Band lower bound', 1000),
                // Nullable so the final band can say "and above". A loss ratio
                // can exceed any finite bound, so a closed top band leaves the
                // upper tail with no commission at all. termRules.js requires
                // the last band to be the open-ended one.
                loss_ratio_to_pct: {
                  anyOf: [pct('Band upper bound', 1000), { type: 'null' }],
                  description: 'Band upper bound; null on the final band, meaning "and above"',
                },
                commission_pct: pct('Commission within the band'),
              },
            },
          },
        },
      },

      // Profit commission.
      profit_commission_pct: pct('Profit commission'),
      pc_expenses_pct: pct('Reinsurer expenses for the profit commission calculation'),
      pc_deficit_carryforward_yrs: {
        type: 'integer', minimum: 0, maximum: 20,
        description: 'Years a deficit is carried forward',
      },

      epi: money('Estimated premium income'),
      event_limit: money('Event limit'),

      // D2 — brokerage sits on the structure terms.
      brokerage_pct: pct('Brokerage'),
    },

    allOf: [
      {
        // A proportional structure that says neither how many lines nor what
        // percentage it cedes does not describe a cession at all.
        anyOf: [{ required: ['lines_ceded'] }, { required: ['cession_pct'] }],
      },
      {
        // Both together is a contradiction, not extra detail.
        not: { required: ['lines_ceded', 'cession_pct'] },
      },
      {
        // A flat commission and a sliding scale are two different answers to
        // the same question; M11 would not know which to pay on.
        not: { required: ['commission_pct', 'sliding_scale'] },
      },
      {
        // Profit commission without an expense allowance is not computable.
        if: { required: ['profit_commission_pct'] },
        then: { required: ['pc_expenses_pct'] },
      },
    ],
  },
};
