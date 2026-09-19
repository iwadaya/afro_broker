/*
 * One presentation of a pack section, three renderers.
 *
 * Each section's stored data is turned into the same shape — a list of facts
 * and a list of tables — so Excel, CSV and PDF all lay out the same pack, in
 * the same order, with the same figures. An empty section presents as itself:
 * heading, blurb, and the note about what would fill it.
 */

/** Column types drive number formatting in each renderer. */
export const MONEY = 'money';
export const PERCENT = 'percent';
export const NUMBER = 'number';
export const TEXT = 'text';
export const DATE = 'date';

const col = (key, label, type = TEXT) => ({ key, label, type });
/** Postgres hands timestamps back as Date objects; JSON snapshots as strings. */
const iso = (v) => {
  if (!v) return '';
  return v instanceof Date ? v.toISOString() : String(v);
};
const day = (v) => (v ? String(v).slice(0, 10) : '');
const period = (p) => (p?.from ? `${p.from} → ${p.to}` : '');

/** Facts for a section, dropping anything absent. */
const facts = (pairs) => pairs
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([label, value, type]) => ({ label, value, type: type || TEXT }));

const table = (title, columns, rows) => (rows?.length ? [{ title, columns, rows }] : []);

/** "sum_insured_100" → "Sum insured 100%". */
const humanise = (key) => key
  .replace(/_pct$/, '_%')
  .replace(/_100\b/, '_100%')
  .replace(/_/g, ' ')
  .replace(/^./, (c) => c.toUpperCase());

/** Generic fallback: every key of an object as a fact. */
const objectFacts = (data) => facts(Object.entries(data).map(([k, v]) => [
  humanise(k), v, k.endsWith('_pct') ? PERCENT : (typeof v === 'number' ? NUMBER : TEXT),
]));

/** UW-year development matrix → a table with one column per as-at date. */
const trianglePresent = (d) => {
  const columns = [col('year', 'UW Year'), ...d.columns.map((label, i) => col(`c${i}`, label, MONEY))];
  const rows = d.rows.map((r) => ({
    year: r.year,
    ...Object.fromEntries(r.values.map((v, i) => [`c${i}`, v])),
  }));
  return { facts: [], tables: [{ title: 'Development by as-at date', columns, rows }] };
};

const PRESENTERS = {
  info_page: (d) => ({
    facts: facts([
      ['Reference', d.reference], ['Cedant', d.cedant], ['Domicile', d.domicile],
      ['Inception', day(d.inception), DATE], ['Renewal date', day(d.renewal_date), DATE],
      ['Classes of business', (d.classes_of_business || []).join(', ')],
      ['Treaty type', d.treaty_type], ['Currency', d.currency],
      ['Expiring leader', d.expiring_leader || 'not recorded'],
      ['Status', d.status],
      ['Basis of renewal', d.renewal_of ? 'Renewal of the prior year contract' : 'New business'],
      ['Notes', d.notes],
    ]),
    tables: table('Treaty structure', [col('line', 'Structure')],
      (d.treaty_structure || []).map((line) => ({ line }))),
  }),

  historical_epi: (d) => ({
    facts: facts([
      ['EPI to market', d.epi_to_market, MONEY],
      ['Expiring EPI', d.expiring_epi, MONEY],
    ]),
    tables: table('EPI by underwriting year',
      [col('year', 'UW Year'), col('risks', 'Risks', NUMBER), col('epi', 'EPI', MONEY)],
      d.years),
  }),

  triangulation_premium: trianglePresent,
  triangulation_paid: trianglePresent,
  triangulation_os: trianglePresent,

  // The cedant's own words, pasted — one row per line so the breaks survive
  // every renderer.
  ceding_criteria: (d) => ({
    facts: [],
    tables: table('Ceding criteria', [col('line', 'Criteria')],
      String(d.text || '').split('\n').map((s) => s.trim()).filter(Boolean).map((line) => ({ line }))),
  }),

  straight_premium: (d) => ({
    facts: [],
    tables: table('Premium by underwriting year',
      [col('year', 'UW Year'), col('risks', 'Risks', NUMBER), col('premium', 'Premium', MONEY)],
      d.rows),
  }),
  straight_paid: (d) => ({
    facts: [],
    tables: table('Claims paid by underwriting year',
      [col('year', 'UW Year'), col('claims', 'Claims', NUMBER), col('paid', 'Paid', MONEY)],
      d.rows),
  }),
  straight_os: (d) => ({
    facts: [],
    tables: table('Outstanding claims by underwriting year',
      [col('year', 'UW Year'), col('claims', 'Claims', NUMBER), col('outstanding', 'Outstanding', MONEY)],
      d.rows),
  }),

  commissions: (d) => ({
    facts: [],
    tables: table('Commission terms', [
      col('source', 'Terms'), col('treaty_type', 'Treaty type'),
      col('commission_pct', 'Commission %', PERCENT),
      col('profit_commission_pct', 'Profit commission %', PERCENT),
      col('mgmt_expenses_pct', 'Mgmt expenses %', PERCENT),
      col('brokerage_pct', 'Brokerage %', PERCENT),
      col('lpv_pct', 'LPV %', PERCENT),
    ], d.rows),
  }),

  stats_ratios: (d) => ({
    facts: facts([['Commission basis', d.commission_basis]]),
    tables: table('Ratios by underwriting year', [
      col('year', 'UW Year'), col('premium', 'Premium', MONEY), col('incurred', 'Incurred', MONEY),
      col('loss_ratio_pct', 'Loss ratio %', PERCENT),
      col('commission_ratio_pct', 'Commission %', PERCENT),
      col('combined_ratio_pct', 'Combined %', PERCENT),
    ], d.rows),
  }),

  large_losses_by_class: (d) => ({
    facts: facts([
      ['Threshold', d.threshold, MONEY], ['Threshold basis', d.basis],
    ]),
    tables: (d.classes || []).flatMap((c) => table(`${c.class} — large losses`, [
      col('claim_ref', 'Claim'), col('insured', 'Insured'),
      col('date_of_loss', 'Date of loss', DATE), col('cause_of_loss', 'Cause'),
      col('paid', 'Paid', MONEY), col('outstanding', 'Outstanding', MONEY), col('incurred', 'Incurred', MONEY),
    ], c.losses)),
  }),

  cat_losses_by_class: (d) => ({
    facts: facts([['CAT incurred', d.incurred, MONEY]]),
    tables: (d.classes || []).flatMap((c) => table(`${c.class} — CAT losses`, [
      col('claim_ref', 'Claim'), col('date_of_loss', 'Date of loss', DATE),
      col('cause_of_loss', 'Peril'), col('incurred', 'Incurred', MONEY),
    ], c.losses)),
  }),

  risk_profile_by_class: (d) => ({
    facts: [],
    tables: (d.classes || []).flatMap((c) => table(`${c.class} — risk profile`, [
      col('band', 'Sum insured band'), col('risks', 'Risks', NUMBER),
      col('sum_insured_100', 'Sum insured 100%', MONEY), col('premium_ceded', 'Premium ceded', MONEY),
    ], c.bands)),
  }),

  aggregates_by_class: (d) => ({
    facts: [],
    tables: [
      ...table('By region', [
        col('class', 'Class'), col('zone', 'Region'), col('risks', 'Risks', NUMBER),
        col('sum_insured_100', 'Sum insured 100%', MONEY), col('premium_ceded', 'Premium ceded', MONEY),
      ], d.regions),
      ...table('By CRESTA zone', [
        col('class', 'Class'), col('zone', 'CRESTA zone'), col('risks', 'Risks', NUMBER),
        col('sum_insured_100', 'Sum insured 100%', MONEY), col('premium_ceded', 'Premium ceded', MONEY),
      ], d.cresta),
    ],
  }),

  top_risks: (d) => ({
    facts: facts([['Note', d.note]]),
    tables: table('Largest risks by sum insured', [
      col('rank', '#', NUMBER), col('insured', 'Insured'), col('policy_ref', 'Policy'),
      col('class', 'Class'), col('territory', 'Territory'),
      col('sum_insured_100', 'Sum insured 100%', MONEY), col('premium_ceded', 'Premium ceded', MONEY),
    ], d.rows),
  }),

  occupancy_profile: (d) => ({
    facts: [],
    tables: table('By occupancy', [
      col('occupancy', 'Occupancy'), col('risks', 'Risks', NUMBER),
      col('sum_insured_100', 'Sum insured 100%', MONEY), col('premium_ceded', 'Premium ceded', MONEY),
    ], d.rows),
  }),

  special_acceptances: (d) => ({
    facts: [],
    tables: table('Special acceptances', [
      col('type', 'Type'), col('title', 'Title'), col('explanation', 'Explanation'),
      col('effective_date', 'Effective', DATE), col('status', 'Status'),
    ], d.rows),
  }),

  treaty_detail: (d) => ({
    facts: facts([
      ['Reference', d.reference], ['Cedant', d.cedant], ['Domicile', d.domicile],
      ['Class', d.class], ['Currency', d.currency],
      ['Inception', day(d.inception), DATE], ['Expiry', day(d.expiry), DATE],
      ['Status', d.status],
      ['Basis of renewal', d.renewal_of ? 'Renewal of the prior year contract' : 'New business'],
      ['Notes', d.notes],
    ]),
    tables: [],
  }),

  documents: (d) => ({
    facts: [],
    tables: table('Documents', [col('type', 'Document'), col('version', 'Version', NUMBER), col('created_at', 'Generated', DATE)],
      d.documents.map((x) => ({ ...x, created_at: day(x.created_at) }))),
  }),

  // PROP shows its terms, NP its layers, and BOTH shows the proportional
  // section over the non-proportional one.
  expiring_structure: (d) => {
    const label = { PROP: 'Proportional', BOTH: 'Both — proportional and non-proportional' }[d.basis]
      || 'Non-proportional';
    const propFacts = d.basis === 'NP' ? [] : [
      ['Treaty type', d.prop?.treatyType],
      ['QS 100% limit', d.prop?.qsLimit, MONEY], ['Retention %', d.prop?.retentionPct, PERCENT],
      ['Surplus max retention', d.prop?.surplusMaxRetention, MONEY],
      ['Number of lines', d.prop?.numLines, NUMBER],
      ['Commission %', d.prop?.commissionPct, PERCENT], ['EPI', d.prop?.epi, MONEY],
    ];
    const layerTables = d.basis === 'PROP' ? [] : table(
      d.basis === 'BOTH' ? 'Expiring layers — non-proportional section' : 'Expiring layers',
      [
        col('name', 'Layer'), col('type', 'Type'), col('limit', 'Limit', MONEY),
        col('attachment', 'Attachment', MONEY), col('reinstatements', 'Reinstatements'),
        col('premium', 'Premium', MONEY),
      ],
      d.layers,
    );
    return { facts: facts([['Basis', label], ...propFacts]), tables: layerTables };
  },

  structure_to_quote: (d) => ({
    facts: facts([['Structures to quote', d.structures.length, NUMBER]]),
    tables: [
      ...d.structures.flatMap((s) => (s.basis === 'PROP'
        ? table(`Structure ${s.index} — proportional`, [col('term', 'Term'), col('value', 'Value')],
          Object.entries(s.prop || {}).filter(([, v]) => v !== '' && v != null)
            .map(([k, v]) => ({ term: humanise(k), value: v })))
        : table(`Structure ${s.index} — non-proportional`, [
          col('name', 'Layer'), col('limit', 'Limit', MONEY), col('attachment', 'Attachment', MONEY),
          col('reinstatements', 'Reinstatements'), col('reinstatement_pct', 'Reinst. %', PERCENT),
          col('egnpi', 'EGNPI', MONEY), col('rate_pct', 'Rate %', PERCENT), col('aad', 'AAD', MONEY),
          col('order', 'Order %', PERCENT), col('premium', 'Premium', MONEY),
        ], s.layers))),
      ...table('Layers on the placement', [
        col('name', 'Layer'), col('type', 'Type'), col('limit', 'Limit', MONEY),
        col('attachment', 'Attachment', MONEY), col('order_pct', 'Order %', PERCENT),
        col('premium100', 'Premium 100%', MONEY), col('status', 'Status'),
      ], d.placed_layers),
    ],
  }),

  premiums_table: (d) => ({
    facts: [],
    tables: table('Premiums by layer', [
      col('layer', 'Layer'), col('egnpi', 'EGNPI', MONEY), col('rate_pct', 'Rate %', PERCENT),
      col('premium100', 'Premium 100%', MONEY), col('reinstatements', 'Reinstatements'),
      col('reinstatement_pct', 'Reinst. %', PERCENT), col('aad', 'AAD', MONEY),
    ], d.layers),
  }),

  retentions: (d) => ({
    facts: facts([['Treaty full limit (100%)', d.limit, MONEY]]),
    tables: table('Retentions by occupancy', [
      // The stored row keys the class as `class` (see retentionsToPayload).
      col('class', 'Class'), col('category', 'Occupancy'), col('pct', '% of treaty limit', PERCENT),
    ], d.rows),
  }),

  premium_experience: (d) => ({
    facts: facts([
      ['Risks', d.risks, NUMBER], ['Distinct policies', d.distinct_policies, NUMBER],
      ['Sum insured 100%', d.sum_insured_100, MONEY], ['Ceded sum insured', d.si_ceded, MONEY],
      ['Gross premium 100%', d.gross_premium_100, MONEY], ['Premium ceded', d.premium_ceded, MONEY],
      ['Rate on ceded SI', d.ceded_rate_pct, PERCENT],
      ['Inception range', period(d.period?.inception)], ['Expiry range', period(d.period?.expiry)],
    ]),
    tables: [
      ...table('Premium by class of business', [
        col('key', 'Class of business'), col('count', 'Risks', NUMBER),
        col('premium_ceded', 'Premium ceded', MONEY), col('sum_insured_100', 'Sum insured', MONEY),
      ], d.by_class),
      ...table('Premium by territory', [
        col('key', 'Territory'), col('count', 'Risks', NUMBER),
        col('premium_ceded', 'Premium ceded', MONEY), col('sum_insured_100', 'Sum insured', MONEY),
      ], d.by_territory),
    ],
  }),

  claims_experience: (d) => ({
    facts: facts([
      ['Claims', d.claims, NUMBER], ['Paid', d.paid, MONEY], ['Outstanding', d.outstanding, MONEY],
      ['Incurred', d.incurred, MONEY], ['Open claims', d.open_claims, NUMBER],
      ['Closed claims', d.closed_claims, NUMBER], ['Loss dates', period(d.period?.date_of_loss)],
    ]),
    tables: table('Incurred by class of business', [
      col('key', 'Class of business'), col('count', 'Claims', NUMBER),
      col('incurred', 'Incurred', MONEY), col('paid', 'Paid', MONEY),
    ], d.by_class),
  }),

  large_loss_list: (d) => ({
    facts: facts([['Threshold', d.threshold, MONEY], ['Threshold basis', d.basis]]),
    tables: table('Large losses', [
      col('claim_ref', 'Claim'), col('policy_ref', 'Policy'), col('insured', 'Insured'),
      col('date_of_loss', 'Date of loss', DATE), col('cause_of_loss', 'Cause'),
      col('paid', 'Paid', MONEY), col('outstanding', 'Outstanding', MONEY), col('incurred', 'Incurred', MONEY),
    ], d.losses),
  }),

  cat_loss_list: (d) => ({
    facts: facts([['Cat incurred', d.incurred, MONEY]]),
    tables: table('Catastrophe losses', [
      col('claim_ref', 'Claim'), col('date_of_loss', 'Date of loss', DATE),
      col('cause_of_loss', 'Peril'), col('incurred', 'Incurred', MONEY),
    ], d.losses),
  }),

  risk_profile: (d) => ({
    facts: [],
    tables: table('Sum insured banding', [
      col('band', 'Sum insured band'), col('risks', 'Risks', NUMBER),
      col('sum_insured_100', 'Sum insured', MONEY), col('premium_ceded', 'Premium ceded', MONEY),
    ], d.bands),
  }),

  claims_profile: (d) => ({
    facts: [],
    tables: [
      ...table('Incurred by cause of loss', [
        col('key', 'Cause of loss'), col('count', 'Claims', NUMBER), col('incurred', 'Incurred', MONEY),
      ], d.by_cause),
      ...table('Incurred by class of business', [
        col('key', 'Class of business'), col('count', 'Claims', NUMBER), col('incurred', 'Incurred', MONEY),
      ], d.by_class),
      ...table('Largest losses', [
        col('claim_ref', 'Claim'), col('insured', 'Insured'), col('date_of_loss', 'Date of loss', DATE),
        col('cause_of_loss', 'Cause'), col('incurred', 'Incurred', MONEY),
      ], d.largest_losses),
    ],
  }),

  cresta_aggregates: (d) => ({
    facts: [],
    tables: table('Accumulation by zone', [
      col('zone', 'CRESTA zone'), col('risks', 'Risks', NUMBER), col('sum_insured_100', 'Sum insured', MONEY),
    ], d.zones),
  }),

  event_loss_tables: (d) => ({
    facts: facts([['Model / run', d.note]]),
    tables: table('Modelled event losses', [
      col('event_id', 'Event'), col('peril', 'Peril'), col('region', 'Region'),
      col('return_period', 'Return period (yrs)', NUMBER),
      col('gross_loss', 'Gross loss', MONEY), col('net_qs', 'Net of QS', MONEY), col('net_xl', 'Net of XL', MONEY),
      col('ultimate_net_loss', 'Ultimate net loss', MONEY), col('comment', 'Comment'),
    ], d.rows),
  }),

  pricing: (d) => ({
    facts: [],
    tables: [
      ...table('Technical benchmark', [
        col('name', 'Layer'), col('technical_rate_on_line', 'Technical ROL', NUMBER), col('source', 'Source'),
      ], d.technical_view),
      ...table('Quotes received', [
        col('market', 'Market'), col('type', 'Type'), col('rate_on_line', 'ROL', NUMBER),
        col('premium', 'Premium', MONEY), col('status', 'Status'), col('validity', 'Valid to', DATE),
      ], (d.quotes || []).map((q) => ({ ...q, validity: day(q.validity) }))),
    ],
  }),

  wording: (d) => ({
    facts: facts([
      ['Title', d.title], ['Status', d.status], ['Base wording', d.reinsurer || 'Standard'],
      ['Clauses', d.clauses, NUMBER],
    ]),
    tables: [],
  }),
};

/** A section as facts + tables. Sections without a presenter fall back to
    listing their figures, so a new template section still exports. */
export function presentSection(section) {
  const base = { key: section.key, title: section.title, blurb: section.blurb, status: section.status, note: section.note };
  if (section.status !== 'filled' || !section.data) return { ...base, facts: [], tables: [] };
  const presenter = PRESENTERS[section.key];
  const out = presenter ? presenter(section.data) : { facts: objectFacts(section.data), tables: [] };
  return { ...base, facts: out.facts || [], tables: out.tables || [] };
}

/** The whole pack, ready to render in any format. */
export function presentPack(pack) {
  const snapshot = pack.snapshot || {};
  const placement = snapshot.placement || {};
  return {
    reference: placement.reference || '',
    version: pack.version,
    basis: snapshot.basis,
    basis_label: snapshot.basis === 'PROP' ? 'Proportional' : 'Non-Proportional',
    template_version: snapshot.template_version,
    status: pack.status,
    currency: placement.currency || '',
    placement,
    // The standard page header: every rendered page names these four.
    header: [
      placement.cedant ? `Cedant: ${placement.cedant}` : null,
      placement.cob || placement.class ? `Class: ${placement.cob || placement.class}` : null,
      placement.treaty_type ? `Treaty: ${placement.treaty_type}` : null,
      placement.currency ? `Currency: ${placement.currency}` : null,
    ].filter(Boolean).join('  ·  '),
    summary: snapshot.summary || {},
    generated_at: iso(snapshot.generated_at || pack.created_at),
    groups: snapshot.groups || [],
    sections: (snapshot.sections || []).map(presentSection),
    // The checklist of screens as it stood when the version was created —
    // null on a version cut without one (an API build, or a preview).
    screens: presentScreens(snapshot.screens),
  };
}

/** The screen checklist as one table: group, screen, then a column per class
    of business (a single "Data" column when the placement has one class). */
export function presentScreens(screens) {
  if (!screens?.rows?.length) return null;
  const cobs = screens.cobs?.length ? screens.cobs : [''];
  const classCols = cobs.map((c, i) => col(`c${i}`, c || 'Data'));
  const rows = screens.rows.map((r) => ({
    group: r.group,
    screen: r.label + (r.required ? ' *' : ''),
    ...Object.fromEntries(cobs.map((_, i) => {
      // A placement-level screen has one answer, shown under every class.
      const done = r.scope === 'placement' ? r.done[0] : r.done[i];
      return [`c${i}`, done ? 'Yes' : 'No'];
    })),
  }));
  return {
    filled: screens.filled ?? 0,
    total: screens.total ?? rows.length,
    missing: screens.missing || [],
    required_missing: screens.required_missing || [],
    columns: [col('group', 'Group'), col('screen', 'Screen'), ...classCols],
    rows,
  };
}

/** File name a market would recognise: reference, version, date. */
export function packFilename(pack, extension) {
  const ref = (pack.snapshot?.placement?.reference || 'renewal-pack').replace(/[^A-Za-z0-9._-]+/g, '-');
  const date = iso(pack.created_at || new Date()).slice(0, 10);
  return `${ref}_RenewalPack_v${pack.version}_${date}.${extension}`;
}
