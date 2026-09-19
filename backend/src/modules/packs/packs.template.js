/*
 * Renewal pack template.
 *
 * The section list is fixed per basis — proportional and non-proportional each
 * have their own standard running order, ported from the Universe modelling
 * tool's wizard (PROP_WIZARD_ORDER / NP_WIZARD_ORDER and their tab groups). A
 * pack always carries every section for its basis: a section with nothing
 * behind it is marked `empty` and says what would fill it, rather than
 * disappearing. Markets get the same document shape every time, and a gap is
 * visible as a gap.
 *
 * Bumping TEMPLATE_VERSION marks packs built before a change to this list, so
 * an old version can still be read as it was built.
 */

export const TEMPLATE_VERSION = 2;

/** Section keys, grouped into tabs, in the order the pack runs.
    The proportional running order is the broking standard the desk asked
    for: info page, expiring terms, structures to quote, historical EPIs,
    ceding criteria, retentions & occupancies, triangulations, straight
    stats, commissions, ratio stats, losses/profiles/aggregates by class,
    top risks, occupancy and claims profiles, and special acceptances. */
export const PACK_TEMPLATE = {
  PROP: {
    label: 'Proportional',
    groups: [
      { label: 'Info', keys: ['info_page'] },
      { label: 'Structure', keys: ['expiring_structure', 'structure_to_quote'] },
      { label: 'Underwriting', keys: ['historical_epi', 'ceding_criteria', 'retentions'] },
      { label: 'Triangulations', keys: ['triangulation_premium', 'triangulation_paid', 'triangulation_os'] },
      { label: 'Straight Stats', keys: ['straight_premium', 'straight_paid', 'straight_os'] },
      { label: 'Commissions & Ratios', keys: ['commissions', 'stats_ratios'] },
      { label: 'Losses', keys: ['large_losses_by_class', 'cat_losses_by_class', 'claims_profile'] },
      { label: 'Profiles', keys: ['risk_profile_by_class', 'occupancy_profile', 'top_risks'] },
      { label: 'Aggregates', keys: ['aggregates_by_class'] },
      { label: 'Special Acceptances', keys: ['special_acceptances'] },
    ],
  },
  NP: {
    label: 'Non-Proportional',
    groups: [
      { label: 'Setup', keys: ['treaty_detail', 'documents'] },
      { label: 'Structure', keys: ['expiring_structure', 'structure_to_quote', 'premiums_table', 'retentions'] },
      { label: 'Experience', keys: ['premium_experience', 'claims_experience', 'historical_performance'] },
      { label: 'Large Losses', keys: ['large_loss_list', 'large_loss_selection'] },
      { label: 'Cat Losses', keys: ['cat_loss_list'] },
      { label: 'Profiles', keys: ['risk_profile', 'claims_profile'] },
      { label: 'Exposure', keys: ['cresta_aggregates', 'event_loss_tables'] },
      { label: 'Market', keys: ['pricing', 'wording'] },
    ],
  },
};

/**
 * Every section the template can hold: its title, the one-line description
 * that heads it in the pack, and what a market should be told when it is
 * empty. `basis` limits a section to one side; absent means both.
 */
export const PACK_SECTIONS = {
  /* ── The standard proportional running order ─────────────────────────
     `required: true` feeds the pack tracker: a required section still
     empty is what stands between the pack and going to market. */
  info_page: {
    title: 'Info Page',
    blurb: 'Cedant, renewal date, classes of business, treaty structure and the expiring leader.',
    required: true,
    empty_note: 'Complete the treaty detail on the placement.',
  },
  historical_epi: {
    title: 'Historical EPIs',
    blurb: 'Estimated premium income by underwriting year, with the EPI put to market.',
    basis: 'PROP',
    required: true,
    empty_note: 'Needs a premium bordereau with an underwriting-year column, or an EPI on the structure terms.',
  },
  ceding_criteria: {
    title: 'Cedant Ceding Criteria',
    blurb: 'How the cedant cedes to the treaty: net retentions, fac usage and cession rules by class.',
    required: true,
    empty_note: 'Enter the structures to quote (retention, limit, surplus lines or layers) and the table of retentions — the ceding criteria are read from them.',
  },
  triangulation_premium: {
    title: 'Triangulation — Premium',
    blurb: 'Premium development: underwriting year against each bordereau as-at date.',
    empty_note: 'Needs premium bordereaux over more than one as-at date with an underwriting-year column.',
  },
  triangulation_paid: {
    title: 'Triangulation — Claims Paid',
    blurb: 'Paid development: underwriting year against each bordereau as-at date.',
    empty_note: 'Needs claims bordereaux over more than one as-at date with an underwriting-year column.',
  },
  triangulation_os: {
    title: 'Triangulation — O/S Claims',
    blurb: 'Outstanding development: underwriting year against each bordereau as-at date.',
    empty_note: 'Needs claims bordereaux over more than one as-at date with an underwriting-year column.',
  },
  straight_premium: {
    title: 'Straight Stats — Premium',
    blurb: 'Premium by underwriting year from the latest bordereau position.',
    required: true,
    empty_note: 'No premium bordereau with an underwriting-year column imported.',
  },
  straight_paid: {
    title: 'Straight Stats — Claims Paid',
    blurb: 'Paid claims by underwriting year from the latest bordereau position.',
    required: true,
    empty_note: 'No claims bordereau with an underwriting-year column imported.',
  },
  straight_os: {
    title: 'Straight Stats — O/S Claims',
    blurb: 'Outstanding claims by underwriting year from the latest bordereau position.',
    required: true,
    empty_note: 'No claims bordereau with an underwriting-year column imported.',
  },
  commissions: {
    title: 'Commissions',
    blurb: 'Commission, profit commission and related terms — expiring against the structures to quote.',
    basis: 'PROP',
    required: true,
    empty_note: 'No commission terms on the expiring structure or the structures to quote.',
  },
  stats_ratios: {
    title: 'Stats — Ratios',
    blurb: 'Loss, commission and combined ratios by underwriting year.',
    required: true,
    empty_note: 'Needs premium and claims by underwriting year, plus a commission on the terms.',
  },
  large_losses_by_class: {
    title: 'Large Losses by Class',
    blurb: 'Losses above the large-loss threshold, grouped by class of business.',
    required: true,
    empty_note: 'No claims bordereau imported, or no loss reaches the threshold.',
  },
  cat_losses_by_class: {
    title: 'CAT Losses by Class',
    blurb: 'Catastrophe-peril losses, grouped by class of business.',
    empty_note: 'No catastrophe-coded losses in the claims bordereaux.',
  },
  risk_profile_by_class: {
    title: 'Risk Profile by Class',
    blurb: 'Sum insured banding per class of business.',
    required: true,
    empty_note: 'No premium bordereau imported.',
  },
  aggregates_by_class: {
    title: 'Aggregates by Class',
    blurb: 'Accumulations by region and CRESTA zone, per class of business.',
    empty_note: 'No territory or CRESTA column in the bordereaux — ask the cedant for a zoned aggregate.',
  },
  top_risks: {
    title: 'Top Risks',
    blurb: 'The largest risks by sum insured — top 10 and top 20 views.',
    empty_note: 'No premium bordereau imported.',
  },
  occupancy_profile: {
    title: 'Occupancy Profiles',
    blurb: 'Risks, sums insured and premium by occupancy category.',
    empty_note: 'No occupancy column in the premium bordereaux.',
  },
  special_acceptances: {
    title: 'Special Acceptances',
    blurb: 'Special acceptances on the placement: type, explanation and status.',
    required: true,
    empty_note: 'No special acceptances raised — record them on the placement if any exist.',
  },

  /* ── Shared / legacy sections ──────────────────────────────────────── */
  treaty_detail: {
    title: 'Treaty Detail',
    blurb: 'Cedant, period, class, currency and broker.',
    empty_note: 'Treaty detail has not been completed on the placement.',
  },
  documents: {
    title: 'Documents',
    blurb: 'Slips, cover notes and closings generated for this placement.',
    empty_note: 'No documents generated yet.',
  },
  expiring_structure: {
    title: 'Expiring Terms & Structure',
    blurb: 'Last year’s contract and its underwriting limits, for year-on-year comparison.',
    required: true,
    empty_note: 'No expiring structure recorded — new business, or the prior year has not been captured.',
  },
  structure_to_quote: {
    title: 'Structure(s) to Quote',
    blurb: 'The structures markets are being asked to quote, with the underwriting limits of the classes quoted.',
    required: true,
    empty_note: 'No structure to quote has been built.',
  },
  premiums_table: {
    title: 'Premiums Table',
    blurb: 'EGNPI and premium by layer.',
    basis: 'NP',
    empty_note: 'No EGNPI or layer premium captured on the structure.',
  },
  retentions: {
    title: 'Table of Retention & Occupancies',
    blurb: 'Occupancy capacity as a % of the treaty limit, by risk class.',
    required: true,
    empty_note: 'No table of retentions captured.',
  },
  premium_experience: {
    title: 'Premium Experience',
    blurb: 'Written and ceded premium from the premium bordereaux.',
    empty_note: 'No premium bordereau imported.',
  },
  claims_experience: {
    title: 'Claims Experience',
    blurb: 'Paid, outstanding and incurred from the claims bordereaux.',
    empty_note: 'No claims bordereau imported.',
  },
  historical_performance: {
    title: 'Historical Performance',
    blurb: 'Premium against incurred, with the resulting ratios.',
    basis: 'NP',
    empty_note: 'Needs both a premium and a claims bordereau.',
  },
  large_loss_list: {
    title: 'Large Loss List',
    blurb: 'Losses above the large-loss threshold, largest first.',
    empty_note: 'No claims bordereau imported, or no loss reaches the threshold.',
  },
  large_loss_selection: {
    title: 'Large Loss Selection',
    blurb: 'Which large losses are treated as non-attritional.',
    empty_note: 'No large losses to select from.',
  },
  cat_loss_list: {
    title: 'Cat Loss List',
    blurb: 'Losses from catastrophe perils, by event.',
    empty_note: 'No catastrophe-coded losses in the claims bordereaux.',
  },
  risk_profile: {
    title: 'Risk Profile',
    blurb: 'Sum insured banding: risk count and premium per band.',
    empty_note: 'No premium bordereau imported.',
  },
  claims_profile: {
    title: 'Claims Profile',
    blurb: 'Incurred by cause of loss and by class of business.',
    empty_note: 'No claims bordereau imported.',
  },
  cresta_aggregates: {
    title: 'CRESTA Aggregates',
    blurb: 'Accumulation by CRESTA zone.',
    empty_note: 'No CRESTA zone column in the bordereaux — ask the cedant for a zoned aggregate.',
  },
  event_loss_tables: {
    title: 'Event Loss Tables',
    blurb: 'Modelled event losses and return periods.',
    empty_note: 'No modelled output loaded — enter the cat vendor\'s event loss table on the Event Loss Tables screen; it does not come from the bordereaux.',
  },
  pricing: {
    title: 'Pricing & Market Response',
    blurb: 'Technical benchmark against quotes received.',
    empty_note: 'No markets approached yet.',
  },
  wording: {
    title: 'Wording',
    blurb: 'The draft wording and its clause set.',
    empty_note: 'No draft wording built for this placement.',
  },
};

/** Section keys for a basis, in running order. */
export function sectionKeys(basis) {
  const template = PACK_TEMPLATE[basis] || PACK_TEMPLATE.NP;
  return template.groups.flatMap((g) => g.keys)
    .filter((key) => {
      const only = PACK_SECTIONS[key]?.basis;
      return !only || only === basis;
    });
}

/** Tab groups for a basis, with sections that do not apply removed. */
export function templateGroups(basis) {
  const keys = new Set(sectionKeys(basis));
  return (PACK_TEMPLATE[basis] || PACK_TEMPLATE.NP).groups
    .map((g) => ({ label: g.label, keys: g.keys.filter((k) => keys.has(k)) }))
    .filter((g) => g.keys.length > 0);
}
