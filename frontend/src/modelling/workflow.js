/* The modelling workflow inserted after the Retentions tab — the Universe
   modelling tool's wizard orders, split by basis exactly as the tool splits
   its PROP and NP wizards. The proportional flow deliberately carries BOTH
   the triangle screens and the straight-stats (no-triangulation) screen: on
   the placement page they are not an either/or, both are to be completed.
   Keys are prefixed "m:" so they never collide with the placement tabs. */

export const PROP_MODELLING_GROUPS = [
  {
    label: 'TRIANGLES',
    tabs: [
      ['m:tri_premium', 'Premium Triangle'],
      ['m:tri_paid', 'Claims Paid Triangle'],
      ['m:tri_os', 'OS Claims Triangle'],
      ['m:tri_incurred', 'Incurred Triangle'],
    ],
  },
  {
    label: 'EXPERIENCE',
    tabs: [['m:straight_stats', 'Straight Stats']],
  },
  {
    label: 'LARGE LOSSES',
    tabs: [
      ['m:large_list', 'Large Loss List'],
      ['m:large_selection', 'Large Loss Selection'],
      ['m:large_pareto', 'Large Loss Pareto'],
    ],
  },
  {
    label: 'CAT LOSSES',
    tabs: [
      ['m:cat_list', 'Cat Loss List'],
      ['m:cat_selection', 'Cat Loss Selection'],
      ['m:cat_pareto', 'Cat Loss Pareto'],
    ],
  },
  {
    label: 'DEV FACTORS',
    tabs: [
      ['m:dev_premium', 'Premium Dev Factors'],
      ['m:dev_paid', 'Paid Claims Dev Factors'],
      ['m:dev_os', 'OS Claims Dev Factors'],
      ['m:dev_incurred', 'Incurred Dev Factors'],
    ],
  },
  {
    label: 'SUMMARIES',
    tabs: [
      ['m:projected_summary', 'Projected Summary'],
      ['m:quick_summary', 'Quick Summary'],
    ],
  },
  {
    label: 'PROFILES',
    tabs: [
      ['m:risk_profile', 'Risk Profile'],
      ['m:claims_profile', 'Claims Profile'],
    ],
  },
  {
    label: 'EXPOSURE',
    tabs: [
      ['m:cresta', 'CRESTA Aggregates'],
      ['m:event_loss_tables', 'Event Loss Tables'],
    ],
  },
];

export const NP_MODELLING_GROUPS = [
  {
    label: 'PREMIUMS',
    tabs: [['m:np_premiums', 'Premiums Table']],
  },
  {
    label: 'LARGE LOSSES',
    tabs: [
      ['m:large_list', 'Large Loss List'],
      ['m:large_selection', 'Large Loss Selection'],
      ['m:large_pareto', 'Large Loss Pareto'],
      ['m:np_large_ldf', 'Large Loss Dev Factors'],
    ],
  },
  {
    label: 'CAT LOSSES',
    tabs: [
      ['m:cat_list', 'Cat Loss List'],
      ['m:cat_selection', 'Cat Loss Selection'],
      ['m:cat_pareto', 'Cat Loss Pareto'],
      ['m:np_cat_ldf', 'Cat Loss Dev Factors'],
    ],
  },
  {
    label: 'EXPERIENCE',
    tabs: [
      ['m:np_excess_dev', 'Excess Dev Factors'],
      ['m:np_historical', 'Historical Performance'],
    ],
  },
  {
    label: 'PROFILES',
    tabs: [
      ['m:risk_profile', 'Risk Profile'],
      ['m:claims_profile', 'Claims Profile'],
    ],
  },
  {
    label: 'EXPOSURE',
    tabs: [
      ['m:cresta', 'CRESTA Aggregates'],
      ['m:event_loss_tables', 'Event Loss Tables'],
    ],
  },
];

/**
 * Which bases the modelling workflow runs on — decided by the structures to
 * quote, as the Universe modelling tool's PROP and NP wizards are decided by
 * the treaty: a proportional structure brings the proportional screens, a
 * non-proportional one the non-proportional screens, and both bring both.
 * With no structure yet, the Treaty Detail treaty type's category decides
 * (proportional or non-proportional); failing that, non-proportional (the
 * placement's layers live there).
 *
 * The non-proportional structures' treaty types filter the NP screens as
 * the tool's wizard does: all Risk XL → no cat screens (cat losses, CRESTA,
 * event loss tables); all CAT XL → no large-loss screens.
 */
/** A structure that says something — a blank default one (no treaty type,
    no terms, no layer) does not decide the wizards. */
export function structureHasContent(st) {
  if (!st) return false;
  if (st.basis === 'PROP') {
    const t = st.prop || {};
    return !!t.treatyType || ['qsLimit', 'surplusMaxRetention', 'numLines', 'commissionPct', 'epi', 'quotaShareEpi', 'surplusEpi']
      .some((k) => t[k] !== '' && t[k] != null);
  }
  return !!st.npTreatyType
    || (st.layers || []).some((r) => (r.name || '').trim() || r.limit || r.attachment || r.premium
      || r.aggLimit || r.attachLrPct || r.limitLrPct);
}

export function modellingBases(treatyCategory, structures, npCoverModeOf = () => 'BOTH') {
  const list = (structures || []).filter(structureHasContent);
  let prop = list.some((s) => s.basis === 'PROP');
  let np = list.some((s) => s.basis !== 'PROP');
  if (!prop && !np) {
    prop = treatyCategory === 'PROPORTIONAL';
    np = !prop;
  }
  const npModes = list.filter((s) => s.basis !== 'PROP').map((s) => npCoverModeOf(s.npTreatyType));
  const catDisabled = np && npModes.length > 0 && npModes.every((m) => m === 'RISK');
  const riskDisabled = np && npModes.length > 0 && npModes.every((m) => m === 'CAT');
  return { prop, np, catDisabled, riskDisabled };
}

/** The single basis the screens read when one applies; proportional leads when both do. */
export function primaryBasis(bases) {
  return bases.prop ? 'PROP' : 'NP';
}

/** Back-compatible: one basis from the treaty category or the first structure. */
export function modellingBasis(treatyCategory, structures) {
  return primaryBasis(modellingBases(treatyCategory, structures));
}

const CAT_KEYS = new Set(['m:cat_list', 'm:cat_selection', 'm:cat_pareto', 'm:np_cat_ldf', 'm:cresta', 'm:event_loss_tables']);
const LARGE_KEYS = new Set(['m:large_list', 'm:large_selection', 'm:large_pareto', 'm:np_large_ldf']);

/**
 * The sidebar groups for a set of bases. With both, the two wizards are
 * merged in the tool's order — the shared screens (loss lists, selections,
 * Paretos, profiles, exposure) appear once, with the NP dev factors beside
 * their loss group. The NP-only filters apply to the NP screens; the shared
 * screens go only when no proportional structure keeps them.
 */
export function modellingGroups(bases) {
  const b = typeof bases === 'string' ? { prop: bases === 'PROP', np: bases !== 'PROP' } : (bases || { np: true });
  const drop = (key) => {
    const npOnly = key.startsWith('m:np_');
    if (b.catDisabled && CAT_KEYS.has(key) && (npOnly || !b.prop)) return true;
    if (b.riskDisabled && LARGE_KEYS.has(key) && (npOnly || !b.prop)) return true;
    return false;
  };
  let groups;
  if (b.prop && b.np) {
    groups = [
      PROP_MODELLING_GROUPS[0], // TRIANGLES
      PROP_MODELLING_GROUPS[1], // EXPERIENCE — straight stats
      NP_MODELLING_GROUPS[0], // PREMIUMS
      NP_MODELLING_GROUPS[1], // LARGE LOSSES (with the NP dev factors)
      NP_MODELLING_GROUPS[2], // CAT LOSSES (with the NP dev factors)
      PROP_MODELLING_GROUPS[4], // DEV FACTORS
      { label: 'NP EXPERIENCE', tabs: NP_MODELLING_GROUPS[3].tabs },
      PROP_MODELLING_GROUPS[5], // SUMMARIES
      PROP_MODELLING_GROUPS[6], // PROFILES
      PROP_MODELLING_GROUPS[7], // EXPOSURE
    ];
  } else {
    groups = b.prop ? PROP_MODELLING_GROUPS : NP_MODELLING_GROUPS;
  }
  const seen = new Set();
  return groups
    .map((g) => ({
      label: g.label,
      tabs: g.tabs.filter(([key]) => {
        if (seen.has(key) || drop(key)) return false;
        seen.add(key);
        return true;
      }),
    }))
    .filter((g) => g.tabs.length > 0);
}

/* ── Required screens ──
   Which screens must hold data before a renewal pack goes for approval,
   decided by the quoting structure the way the wizards themselves are: the
   placement screens always; a proportional structure needs the triangles,
   the straight stats, the development factors, the summaries and the risk
   profile; a non-proportional one needs the premiums table and the
   historical performance, plus the large-loss chain (list, selection, dev
   factors, excess dev factors, risk profile) unless every NP structure is a
   CAT cover, and the cat chain (list, selection, dev factors, CRESTA, event
   loss tables) unless every NP structure is a Risk cover. Derived screens
   (incurred triangle, incurred dev factors), the Paretos, the claims profile,
   retentions and the bordereau data are never required. */
const REQUIRED_ALWAYS = ['detail', 'expiring', 'structure'];
const REQUIRED_PROP = [
  'm:tri_premium', 'm:tri_paid', 'm:tri_os', 'm:straight_stats',
  'm:dev_premium', 'm:dev_paid', 'm:dev_os',
  'm:projected_summary', 'm:quick_summary', 'm:risk_profile',
];
const REQUIRED_NP = ['m:np_premiums', 'm:np_historical'];
const REQUIRED_NP_RISK = ['m:large_list', 'm:large_selection', 'm:np_large_ldf', 'm:np_excess_dev', 'm:risk_profile'];
const REQUIRED_NP_CAT = ['m:cat_list', 'm:cat_selection', 'm:np_cat_ldf', 'm:cresta', 'm:event_loss_tables'];

/** The set of screen keys the quoting structure requires, for a set of bases
    (as modellingBases() returns them). */
export function requiredScreens(bases) {
  const b = typeof bases === 'string' ? { prop: bases === 'PROP', np: bases !== 'PROP' } : (bases || { np: true });
  const keys = [...REQUIRED_ALWAYS];
  if (b.prop) keys.push(...REQUIRED_PROP);
  if (b.np) {
    keys.push(...REQUIRED_NP);
    if (!b.riskDisabled) keys.push(...REQUIRED_NP_RISK);
    if (!b.catDisabled) keys.push(...REQUIRED_NP_CAT);
  }
  return new Set(keys);
}

/** Flat [key, label] list in wizard order for Back/Next navigation. */
export function modellingTabList(bases) {
  return modellingGroups(bases).flatMap((g) => g.tabs);
}
