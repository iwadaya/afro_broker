/**
 * Negotiation board — what a market is actually asked to price, and what it
 * came back with.
 *
 * The pack goes out carrying the structures to quote; each structure resolves
 * into the *lines* a market quotes against. A non-proportional structure is
 * quoted layer by layer; a proportional one is quoted as a whole (its
 * commission and terms), so it has a single line and no layer index.
 *
 * A market — usually the lead — may answer with a structure of its own instead
 * of the one it was sent. Those counter-structures carry the same shape and
 * resolve into lines the same way; they belong to the market that proposed
 * them, so they are keyed by id rather than by the position of a sent
 * structure.
 *
 * Pure: it reads the stored structures and the quotes captured so far, and
 * returns what the negotiation screen renders.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The modelling tool's treaty mode for a proportional treaty type name:
 * 'quota', 'surplus' or 'both'. Quota Share & Surplus is both; any surplus,
 * and Fac Oblig, is surplus; anything else reads as quota. The legacy
 * Broker IQ names (QS / Surplus / QS + Surplus) map the same way.
 */
export function propMode(name) {
  const n = String(name || '').trim().toLowerCase();
  if (n === 'qs + surplus') return 'both';
  if (n === 'qs') return 'quota';
  if (n === 'surplus') return 'surplus';
  if (n.includes('quota') && n.includes('surplus')) return 'both';
  if (n.includes('quota')) return 'quota';
  if (n.includes('surplus') || n.includes('fac oblig')) return 'surplus';
  return 'quota';
}

/** Capacity a proportional structure puts up — the tool's total treaty
    capacity: quota → QS limit; both → QS limit + max retention × lines;
    surplus → max retention + max retention × lines. */
export function propCapacity(prop = {}) {
  const mode = propMode(prop.treatyType);
  const maxRet = num(prop.surplusMaxRetention);
  const surplus = maxRet * num(prop.numLines);
  if (mode === 'quota') return num(prop.qsLimit);
  if (mode === 'both') return num(prop.qsLimit) + surplus;
  return maxRet + surplus;
}

/**
 * The terms of one line, column for column with the structure tables.
 *
 * Every one of these is quotable: an underwriter may accept the layer as sent,
 * or come back on any of them. Kept as one flat shape so a quote, the structure
 * it answers and the difference between them all read the same way.
 */
export const TERM_FIELDS = [
  { key: 'layer_name', label: 'Name', kind: 'text' },
  { key: 'layer_type', label: 'Type', kind: 'text' },
  { key: 'limit_amt', label: 'Limit', kind: 'amount' },
  { key: 'attachment', label: 'Attachment', kind: 'amount' },
  { key: 'reinstatements', label: 'Reinstatements', kind: 'text' },
  { key: 'reinstatement_pct', label: 'Reinst. %', kind: 'pct' },
  { key: 'egnpi', label: 'EGNPI', kind: 'amount' },
  { key: 'rate_pct', label: 'Rate %', kind: 'pct' },
  { key: 'aad', label: 'AAD', kind: 'amount' },
  { key: 'order_pct', label: 'Order %', kind: 'pct' },
  { key: 'premium', label: 'Premium 100%', kind: 'amount' },
  { key: 'risk_cover', label: 'Risk', kind: 'flag' },
  { key: 'cat_cover', label: 'CAT', kind: 'flag' },
  { key: 'commission_pct', label: 'Commission %', kind: 'pct' },
];

const TERM_KEYS = TERM_FIELDS.map((f) => f.key);

const numOrNull = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const textOrNull = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

/**
 * ROL — rate on line, premium ÷ limit. Computed, never stored: it is a reading
 * of the two figures beside it, and storing it would let the three disagree.
 */
export function rolOf(terms = {}) {
  const limit = numOrNull(terms.limit_amt);
  const premium = numOrNull(terms.premium);
  if (!limit || !premium || limit <= 0) return null;
  return Number(((premium / limit) * 100).toFixed(4));
}

/** A stored layer, as the flat term shape. */
export function layerTerms(layer = {}, i = 0) {
  return {
    layer_name: textOrNull(layer.name) || `Layer ${i + 1}`,
    layer_type: textOrNull(layer.type),
    limit_amt: numOrNull(layer.limit),
    attachment: numOrNull(layer.attachment),
    reinstatements: textOrNull(layer.reinstatements),
    reinstatement_pct: numOrNull(layer.reinstatement_pct ?? layer.reinstatementPct),
    egnpi: numOrNull(layer.egnpi),
    rate_pct: numOrNull(layer.rate_pct ?? layer.rate),
    aad: numOrNull(layer.aad),
    order_pct: numOrNull(layer.order_pct ?? layer.order),
    premium: numOrNull(layer.premium),
    // Absent means covered: the structure tables default both on.
    risk_cover: layer.risk_cover ?? layer.risk ?? true,
    cat_cover: layer.cat_cover ?? layer.cat ?? true,
    commission_pct: null,
  };
}

/** A proportional structure's terms, in the same flat shape. */
export function propTerms(prop = {}) {
  return {
    layer_name: textOrNull(prop.treatyType) || 'Proportional',
    layer_type: textOrNull(prop.treatyType),
    limit_amt: propCapacity(prop) || null,
    attachment: null,
    reinstatements: null,
    reinstatement_pct: null,
    // A proportional treaty is quoted on its EPI, which `premium` carries —
    // there is no separate premium base to rate against.
    egnpi: null,
    rate_pct: null,
    aad: null,
    order_pct: numOrNull(prop.orderPct ?? prop.order_pct),
    premium: numOrNull(prop.epi),
    risk_cover: true,
    cat_cover: true,
    commission_pct: numOrNull(prop.commissionPct ?? prop.commission_pct),
  };
}

/** The terms a quote carries, falling back to what it was answering. */
export function quotedTerms(quote = {}, original = {}) {
  const out = {};
  for (const key of TERM_KEYS) {
    out[key] = quote[key] === undefined || quote[key] === null ? (original[key] ?? null) : quote[key];
  }
  return out;
}

const sameValue = (kind, a, b) => {
  if (kind === 'flag') return (a ?? true) === (b ?? true);
  if (kind === 'text') return (a ?? '') === (b ?? '');
  const x = numOrNull(a);
  const y = numOrNull(b);
  if (x === null || y === null) return x === y;
  // Stored at 4dp; anything finer is rounding, not a movement in terms.
  return Math.abs(x - y) < 0.00005;
};

/**
 * What a quote moved against the terms it was sent.
 *
 * Compared against the snapshot taken when the quote was captured, not against
 * the structure as it stands now — the broker may have reworked the structure
 * since, and this has to keep saying what the underwriter actually changed.
 */
export function termVariance(quoted = {}, original = {}) {
  const out = [];
  for (const field of TERM_FIELDS) {
    const from = original[field.key] ?? null;
    const to = quoted[field.key] ?? null;
    // A line the structure never had terms for has nothing to have moved from.
    if (from === null && to === null) continue;
    if (!sameValue(field.kind, to, from)) {
      out.push({ field: field.key, label: field.label, kind: field.kind, from, to });
    }
  }
  return out;
}

/**
 * The lines of one structure.
 *
 * @param {object} structure  a structure in stored shape (basis, layers, prop)
 * @param {object} ref        what the lines answer to: { structure_index } for
 *                            a structure that was sent, { market_structure_id }
 *                            for a market's own
 */
export function linesForStructure(structure, ref = {}) {
  const key = {
    structure_index: ref.structure_index ?? null,
    market_structure_id: ref.market_structure_id ?? null,
  };
  if (structure.basis === 'PROP') {
    const prop = structure.prop || {};
    return [{
      ...key,
      layer_index: null,
      label: prop.treatyType || 'Proportional',
      basis: 'PROP',
      capacity: propCapacity(prop),
      // Every column of the line as it was sent — what a quote is read against,
      // and what it starts from when the underwriter accepts it as it stands.
      terms: propTerms(prop),
      // What the cedant is asking for, so a quote can be read against it.
      asked: {
        commission_pct: prop.commissionPct === '' || prop.commissionPct == null ? null : num(prop.commissionPct),
        epi: prop.epi === '' || prop.epi == null ? null : num(prop.epi),
      },
    }];
  }
  return (structure.layers || []).map((l, i) => ({
    ...key,
    layer_index: i,
    label: l.name || `Layer ${i + 1}`,
    basis: 'NP',
    limit: l.limit ?? null,
    attachment: l.attachment ?? null,
    terms: layerTerms(l, i),
    asked: {
      premium: l.premium ?? null,
      rate_pct: l.rate_pct ?? null,
    },
  }));
}

/** True when a structure has anything a market could price. */
export function isQuotable(structure) {
  if (!structure) return false;
  if (structure.basis === 'PROP') {
    const prop = structure.prop || {};
    return Boolean(prop.treatyType) || propCapacity(prop) > 0;
  }
  return (structure.layers || []).length > 0;
}

/**
 * The structures a market is asked to quote, each with its lines.
 *
 * @param {object[]} structures  the placement's stored `quote_structures`
 */
export function negotiationBoard(structures = []) {
  return structures
    .map((structure, i) => ({ structure, index: i + 1 }))
    .filter(({ structure }) => isQuotable(structure))
    .map(({ structure, index }) => ({
      source: 'sent',
      index,
      basis: structure.basis === 'PROP' ? 'PROP' : 'NP',
      label: `Structure ${index}`,
      lines: linesForStructure(structure, { structure_index: index }),
    }));
}

/**
 * A market's own structures, in the same shape as the sent ones.
 *
 * @param {object[]} rows  negotiation_structure rows
 */
export function marketStructureBoard(rows = []) {
  return rows.map((row) => {
    const structure = { basis: row.basis, ...(row.structure || {}) };
    return {
      source: 'market',
      id: row.id,
      negotiation_id: row.negotiation_id,
      market_name: row.market_name || null,
      basis: row.basis,
      label: row.label,
      notes: row.notes || null,
      lines: linesForStructure(structure, { market_structure_id: row.id }),
    };
  });
}

/**
 * A quote as the screens read it: its full terms, and what they moved against
 * the line as sent. A quote captured before the terms existed has no snapshot,
 * so it falls back to the line's terms and reads as unchanged.
 */
export function withVariance(quote, line = {}) {
  const original = quote.original && Object.keys(quote.original).length
    ? quote.original
    : (line.terms || {});
  const terms = quotedTerms(quote, original);
  return {
    ...quote,
    // A lead quote unless captured as an indication; a row from before the
    // kind was kept reads as lead.
    kind: quote.kind === 'indicative' ? 'indicative' : 'lead',
    terms,
    original,
    rol_pct: rolOf(terms),
    original_rol_pct: rolOf(original),
    variance: quote.status === 'declined' ? [] : termVariance(terms, original),
  };
}

const cellKey = (line) => (line.market_structure_id
  ? `m${line.market_structure_id}:${line.layer_index ?? '-'}`
  : `s${line.structure_index}:${line.layer_index ?? '-'}`);

function indexQuotes(quotes) {
  const byCell = new Map();
  for (const q of quotes) {
    const key = cellKey(q);
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(q);
  }
  return byCell;
}

/** How a line reads across every market that answered it. */
function summarise(cell) {
  const quoted = cell.filter((q) => q.status === 'quoted');
  const figures = (key) => quoted.map((q) => q[key]).filter((v) => v != null).map(Number);
  const premiums = figures('premium');
  const rates = figures('rate_pct');
  const commissions = figures('commission_pct');
  return {
    quoted: quoted.length,
    declined: cell.length - quoted.length,
    // Of those quoted, how many are indications rather than lead quotes.
    indicative: quoted.filter((q) => q.kind === 'indicative').length,
    // Keenest for the cedant: the lowest price, the highest commission.
    best_premium: premiums.length ? Math.min(...premiums) : null,
    best_rate_pct: rates.length ? Math.min(...rates) : null,
    best_commission_pct: commissions.length ? Math.max(...commissions) : null,
    line_pct_total: quoted.reduce((a, q) => a + Number(q.line_pct || 0), 0),
  };
}

/**
 * The board: every structure that went out, plus any a market answered with,
 * each line carrying the quotes against it and how it reads across the market.
 *
 * @param {object[]} structures        stored `quote_structures`
 * @param {object[]} quotes            negotiation_quote rows
 * @param {object[]} [marketStructures] negotiation_structure rows
 */
export function boardWithQuotes(structures = [], quotes = [], marketStructures = []) {
  const byCell = indexQuotes(quotes);
  const attach = (entry) => ({
    ...entry,
    lines: entry.lines.map((line) => {
      const cell = (byCell.get(cellKey(line)) || []).map((q) => withVariance(q, line));
      return { ...line, quotes: cell, summary: summarise(cell) };
    }),
  });
  return [
    ...negotiationBoard(structures).map(attach),
    ...marketStructureBoard(marketStructures).map(attach),
  ];
}

/** True when every line of a structure was answered with a decline. */
export function isDeclined(lines) {
  return lines.length > 0 && lines.every((l) => l.quote && l.quote.status === 'declined');
}

/**
 * How a market's answer on a structure reads: an indication when every line
 * it priced is one, a lead quote otherwise. A decline carries no kind, so a
 * structure declined outright reads as lead by default — there is nothing
 * to mark.
 *
 * @param {object[]} lines  [{ line, quote }] — one per line, quote null when awaited
 */
export function structureKind(lines) {
  const priced = lines.filter((l) => l.quote && l.quote.status === 'quoted');
  return priced.length && priced.every((l) => l.quote.kind === 'indicative') ? 'indicative' : 'lead';
}

/**
 * One market's quote sheet: every structure it was sent — with whatever it has
 * already said filled in — followed by any structure of its own.
 *
 * This is what the capture screen renders: pick a market, and the structures it
 * was sent are pulled through ready for the rest of the detail.
 *
 * @param {object[]} structures        stored `quote_structures`
 * @param {object[]} marketStructures  this market's negotiation_structure rows
 * @param {object[]} quotes            this market's negotiation_quote rows
 */
export function quoteSheet(structures = [], marketStructures = [], quotes = []) {
  const byCell = indexQuotes(quotes);
  const fill = (entry) => {
    const lines = entry.lines.map((line) => {
      const quote = (byCell.get(cellKey(line)) || [])[0] || null;
      return { ...line, quote: quote ? withVariance(quote, line) : null };
    });
    return { ...entry, lines, declined: isDeclined(lines), indicative: structureKind(lines) === 'indicative' };
  };
  return [
    ...negotiationBoard(structures).map(fill),
    ...marketStructureBoard(marketStructures).map(fill),
  ];
}

/**
 * Where a market stands once its quotes are in: quoted if it has priced
 * anything, declined if it answered every line it was given with a decline.
 */
export function marketStanding(quotes = []) {
  if (!quotes.length) return 'SENT';
  if (quotes.some((q) => q.status === 'quoted')) return 'QUOTED';
  return 'DECLINED';
}

// ---------------------------------------------------------------------------
// The quotes read by reinsurer, the programme they add up to, and the rate on
// line compared layer by layer. Pure, like the rest of this module: they read
// the board (boardWithQuotes) and the markets holding the pack.
// ---------------------------------------------------------------------------

const round4 = (n) => Number(Number(n).toFixed(4));
const round2 = (n) => Number(Number(n).toFixed(2));

/** The premium a quote stands at: what was quoted, else the line as sent. */
export const quotedPremium = (quote) => numOrNull(quote?.terms?.premium ?? quote?.premium);

/**
 * The programme a market's answers on one non-proportional structure add up
 * to: the layers it priced, its premium and limit across them, and the rate
 * on line those two make — premium over limit, never stored.
 *
 * @param {object[]} entries  [{ line, quote }] — one per layer, quote null when awaited
 */
export function programmeRollup(entries = []) {
  const layers = entries.length;
  const quoted = entries.filter((e) => e.quote && e.quote.status === 'quoted');
  const declined = entries.filter((e) => e.quote && e.quote.status === 'declined').length;
  let premiumTotal = 0;
  let limitTotal = 0;
  let priced = 0;
  for (const { line, quote } of quoted) {
    const premium = quotedPremium(quote);
    const limit = numOrNull(quote.terms?.limit_amt ?? line.limit);
    if (premium == null || limit == null) continue;
    premiumTotal += premium;
    limitTotal += limit;
    priced += 1;
  }
  const lines = quoted.map((e) => numOrNull(e.quote.line_pct)).filter((v) => v != null);
  return {
    layers,
    quoted: quoted.length,
    declined,
    awaited: layers - quoted.length - declined,
    complete: layers > 0 && quoted.length === layers,
    priced_layers: priced,
    premium_total: priced ? round2(premiumTotal) : null,
    limit_total: priced ? round2(limitTotal) : null,
    rol_pct: priced && limitTotal > 0 ? round4((premiumTotal / limitTotal) * 100) : null,
    line_pct_min: lines.length ? Math.min(...lines) : null,
    line_pct_max: lines.length ? Math.max(...lines) : null,
  };
}

/** The lines of a structure paired with one market's answer on each. */
const answersOf = (structure, negotiationId) => structure.lines.map((line) => ({
  line,
  quote: line.quotes.find((q) => q.negotiation_id === negotiationId) || null,
}));

/**
 * The quotes by reinsurer: for every market holding the pack, each structure
 * it was sent — quoted on the structure as sent, or answered with a structure
 * of its own — and, for a non-proportional structure, the programme its
 * layer quotes add up to.
 *
 * @param {object[]} board    boardWithQuotes()
 * @param {object[]} markets  the negotiations (id, market_id, market_name, role, status)
 */
export function quotesByUnderwriter(board = [], markets = []) {
  const sentCount = board.filter((s) => s.source !== 'market').length;
  return markets.map((m) => {
    const structures = [];
    for (const structure of board) {
      if (structure.source === 'market' && structure.negotiation_id !== m.id) continue;
      const lines = answersOf(structure, m.id);
      const answered = lines.some((l) => l.quote);
      const declined = lines.length > 0 && lines.every((l) => l.quote?.status === 'declined');
      structures.push({
        source: structure.source,
        index: structure.index ?? null,
        id: structure.id ?? null,
        label: structure.label,
        basis: structure.basis,
        own: structure.source === 'market',
        answered,
        declined,
        // Lead quote or indication — what this market's answer on it is.
        kind: structureKind(lines),
        lines,
        rollup: structure.basis === 'NP' ? programmeRollup(lines) : null,
      });
    }
    return {
      negotiation_id: m.id,
      market_id: m.market_id,
      market_name: m.market_name,
      role: m.role,
      status: m.status,
      structures,
      summary: {
        structures_sent: sentCount,
        answered: structures.filter((s) => s.answered && !s.own).length,
        own: structures.filter((s) => s.own).length,
      },
    };
  });
}

/** The keenest quote on a line: the lowest premium, else the lowest rate. */
function keenest(quotes) {
  const quoted = quotes.filter((q) => q.status === 'quoted');
  const priced = quoted.filter((q) => quotedPremium(q) != null);
  if (priced.length) return priced.reduce((a, b) => (quotedPremium(b) < quotedPremium(a) ? b : a));
  const rated = quoted.filter((q) => (q.rol_pct ?? q.rate_pct) != null);
  if (rated.length) return rated.reduce((a, b) => ((b.rol_pct ?? b.rate_pct) < (a.rol_pct ?? a.rate_pct) ? b : a));
  return null;
}

/**
 * The combined quote on every non-proportional structure: each market's
 * layers with its programme total, and the best of the market — the keenest
 * quote on each layer, whichever market gave it, added up into a programme.
 */
export function combinedQuotes(board = [], markets = []) {
  return board.filter((s) => s.basis === 'NP').map((structure) => {
    const participants = structure.source === 'market'
      ? markets.filter((m) => m.id === structure.negotiation_id)
      : markets;
    const byMarket = participants.map((m) => {
      const lines = answersOf(structure, m.id);
      return {
        negotiation_id: m.id,
        market_id: m.market_id,
        market_name: m.market_name,
        role: m.role,
        kind: structureKind(lines),
        layers: lines.map(({ line, quote }) => ({
          layer_index: line.layer_index,
          label: line.label,
          status: quote ? quote.status : 'awaited',
          kind: quote?.status === 'quoted' ? quote.kind : null,
          premium: quote?.status === 'quoted' ? quotedPremium(quote) : null,
          rol_pct: quote?.status === 'quoted' ? (quote.rol_pct ?? null) : null,
          rate_pct: quote?.status === 'quoted' ? (numOrNull(quote.rate_pct)) : null,
          line_pct: quote?.status === 'quoted' ? numOrNull(quote.line_pct) : null,
        })),
        rollup: programmeRollup(lines),
      };
    }).filter((m) => m.rollup.quoted > 0 || m.rollup.declined > 0);

    const bestLayers = structure.lines.map((line) => {
      const best = keenest(line.quotes || []);
      return {
        layer_index: line.layer_index,
        label: line.label,
        limit: line.limit ?? null,
        quoted: (line.quotes || []).filter((q) => q.status === 'quoted').length,
        negotiation_id: best?.negotiation_id ?? null,
        market_id: best?.market_id ?? null,
        market_name: best?.market_name ?? null,
        // The keenest quote may be an indication: it is still the keenest,
        // but the reading says so.
        kind: best ? best.kind : null,
        premium: best ? quotedPremium(best) : null,
        rol_pct: best?.rol_pct ?? null,
        rate_pct: best ? numOrNull(best.rate_pct) : null,
        line_pct: best ? numOrNull(best.line_pct) : null,
      };
    });
    const priced = bestLayers.filter((l) => l.premium != null && l.limit != null);
    const premiumTotal = priced.reduce((a, l) => a + l.premium, 0);
    const limitTotal = priced.reduce((a, l) => a + Number(l.limit), 0);
    return {
      source: structure.source,
      index: structure.index ?? null,
      id: structure.id ?? null,
      label: structure.label,
      layers: structure.lines.length,
      by_market: byMarket,
      best: {
        layers: bestLayers,
        premium_total: priced.length ? round2(premiumTotal) : null,
        limit_total: priced.length ? round2(limitTotal) : null,
        rol_pct: priced.length && limitTotal > 0 ? round4((premiumTotal / limitTotal) * 100) : null,
        complete: structure.lines.length > 0 && priced.length === structure.lines.length,
        indicative: bestLayers.some((l) => l.kind === 'indicative'),
        markets: [...new Set(bestLayers.map((l) => l.market_name).filter(Boolean))],
      },
    };
  });
}

/**
 * The expiring layers in one shape, from either place they are kept: the
 * expiring structure recorded on the placement, else the prior year's layer
 * rows. Each carries its own rate on line, premium over limit.
 */
export function normaliseExpiringLayers(expiringStructure = null, priorLayers = []) {
  const fromStructure = expiringStructure && expiringStructure.basis !== 'PROP'
    ? (expiringStructure.layers || [])
    : [];
  const source = fromStructure.length ? fromStructure : (priorLayers || []);
  return source.map((l, i) => {
    const limit = numOrNull(l.limit ?? l.limit_amt);
    const premium = numOrNull(l.premium ?? l.premium100);
    return {
      name: textOrNull(l.name) || `Layer ${i + 1}`,
      limit,
      attachment: numOrNull(l.attachment),
      premium,
      rol_pct: rolOf({ limit_amt: limit, premium }),
    };
  }).filter((l) => l.limit != null || l.premium != null);
}

/** The expiring layer a line compares with: the same name, else the same position. */
function matchExpiringLayer(expiring, line, position) {
  if (!expiring?.length) return null;
  const name = String(line.label || '').trim().toLowerCase();
  const byName = expiring.filter((e) => String(e.name || '').trim().toLowerCase() === name);
  if (byName.length === 1) return byName[0];
  return expiring[position] || null;
}

/**
 * The rate on line compared layer by layer: for every non-proportional
 * structure, its layers down the side and the reinsurers that answered
 * across the top, each cell that reinsurer's rate on line on that layer.
 * The layer as sent and, where the prior year is known, the expiring layer
 * stand beside them, and the keenest quote on each layer is marked.
 *
 * @param {object[]} board           boardWithQuotes()
 * @param {object[]} expiringLayers  normaliseExpiringLayers()
 * @param {object[]} markets         the negotiations holding the pack
 */
export function rolComparison(board = [], expiringLayers = [], markets = []) {
  return board.filter((s) => s.basis === 'NP').map((structure) => {
    const holders = structure.source === 'market'
      ? markets.filter((m) => m.id === structure.negotiation_id)
      : markets;
    const participants = holders.filter((m) => structure.lines
      .some((line) => (line.quotes || []).some((q) => q.negotiation_id === m.id)));

    const rows = structure.lines.map((line, i) => {
      const cells = {};
      let best = null;
      for (const m of participants) {
        const q = (line.quotes || []).find((x) => x.negotiation_id === m.id) || null;
        let cell;
        if (!q) cell = { status: 'awaited' };
        else if (q.status === 'declined') cell = { status: 'declined' };
        else {
          const value = q.rol_pct ?? numOrNull(q.rate_pct);
          cell = {
            status: 'quoted',
            kind: q.kind,
            rol_pct: q.rol_pct ?? null,
            rate_pct: numOrNull(q.rate_pct),
            premium: quotedPremium(q),
            line_pct: numOrNull(q.line_pct),
            measure: q.rol_pct != null ? 'rol' : (q.rate_pct != null ? 'rate' : null),
            value,
            best: false,
          };
          if (value != null && (best === null || value < best.value)) best = { negotiation_id: m.id, value };
        }
        cells[m.id] = cell;
      }
      if (best) cells[best.negotiation_id].best = true;
      const expiring = structure.source === 'market' ? null : matchExpiringLayer(expiringLayers, line, i);
      return {
        layer_index: line.layer_index,
        label: line.label,
        limit: line.limit ?? null,
        attachment: line.attachment ?? null,
        sent: {
          premium: numOrNull(line.terms?.premium),
          rate_pct: numOrNull(line.terms?.rate_pct),
          rol_pct: rolOf(line.terms || {}),
        },
        expiring,
        cells,
        best_negotiation_id: best?.negotiation_id ?? null,
      };
    });
    const foot = Object.fromEntries(participants.map((m) => [m.id, programmeRollup(answersOf(structure, m.id))]));
    const expiringTotal = rows.reduce((acc, r) => {
      if (!r.expiring || r.expiring.premium == null || r.expiring.limit == null) return acc;
      return { premium: acc.premium + r.expiring.premium, limit: acc.limit + r.expiring.limit, layers: acc.layers + 1 };
    }, { premium: 0, limit: 0, layers: 0 });
    return {
      source: structure.source,
      index: structure.index ?? null,
      id: structure.id ?? null,
      label: structure.label,
      markets: participants.map((m) => ({ negotiation_id: m.id, market_id: m.market_id, market_name: m.market_name, role: m.role })),
      rows,
      foot,
      has_expiring: rows.some((r) => r.expiring),
      expiring_programme: expiringTotal.layers
        ? { premium_total: round2(expiringTotal.premium), limit_total: round2(expiringTotal.limit), rol_pct: expiringTotal.limit > 0 ? round4((expiringTotal.premium / expiringTotal.limit) * 100) : null }
        : null,
      sent_programme: (() => {
        const priced = rows.filter((r) => r.sent.premium != null && r.limit != null);
        const premium = priced.reduce((a, r) => a + r.sent.premium, 0);
        const limit = priced.reduce((a, r) => a + Number(r.limit), 0);
        return priced.length ? { premium_total: round2(premium), limit_total: round2(limit), rol_pct: limit > 0 ? round4((premium / limit) * 100) : null } : null;
      })(),
    };
  });
}
