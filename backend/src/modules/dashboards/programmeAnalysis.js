import { HOUSE, moneyBag, round2, groupBy, lineShare, brokerKeyOf, UNNAMED_BROKER } from './portfolioBook.js';

/**
 * Programme analysis — the book's programmes read by who places each one and
 * who writes it, for the charts behind Portfolio intelligence's "Analyse
 * programmes" button.
 *
 * A programme is an account with an order to read: a layer on the placement,
 * or a Final Placement recording who leads it. An account with neither is on
 * the book but not yet structured, and is counted as such rather than dropped.
 *
 * Everything here is derived from the one reading of the book in
 * portfolioBook.js, so the analysis can never disagree with the portfolio
 * screen: our role and the lead broker come from the order or Final
 * Placement, the lines from the layer ledger and the Final Placement's lines,
 * each with the role the reinsurer was approached in. "Premium on lines" is a
 * layer's premium at 100% times the line's share — what each reinsurer's lines
 * carry; a Final Placement line has no layer premium and counts as a line and
 * a share but no premium.
 *
 * Money is summed per currency as well as in total, since the book holds no
 * FX rates; the UI notes a mixed figure beside its total.
 */

const byName = (x, y) => String(x.name || '').localeCompare(String(y.name || ''));

/** The treaty types on a programme: the layers' distinct types, joined ' + ' by the reading. */
function typesOf(treatyTypes) {
  const types = String(treatyTypes || '').split(' + ').map((t) => t.trim()).filter(Boolean);
  return types.length ? types : ['Not recorded'];
}

/** a − b, currency by currency, for "the rest of the order" behind a house's programmes. */
function moneyMinus(a, b) {
  const by_currency = {};
  for (const [ccy, amt] of Object.entries(a.by_currency || {})) {
    const rest = round2(amt - (b.by_currency?.[ccy] || 0));
    if (rest) by_currency[ccy] = rest;
  }
  return { total: round2(a.total - b.total), by_currency };
}

const mean = (xs) => (xs.length ? round2(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

/** A reinsurer tallied inside a broker's row, or a broker inside a reinsurer's. */
function tally(seed) {
  return {
    ...seed,
    programmes: new Set(), lines: 0, lead_lines: 0, follow_lines: 0, signed_lines: 0,
    share_total: 0, premium_on_lines: moneyBag(),
  };
}

function tallyLine(t, li, programmeId) {
  t.programmes.add(programmeId);
  t.lines += 1;
  if (li.role === 'lead') t.lead_lines += 1;
  if (li.role === 'follow') t.follow_lines += 1;
  if (li.status === 'SIGNED') t.signed_lines += 1;
  const share = lineShare(li);
  t.share_total = round2(t.share_total + share);
  if (li.premium100 != null) t.premium_on_lines.add(li.currency, Number(li.premium100) * share / 100);
}

const closeTally = (t) => ({
  ...t, programmes: t.programmes.size, premium_on_lines: t.premium_on_lines.value(),
});

const byWeight = (x, y) => y.programmes - x.programmes
  || y.premium_on_lines.total - x.premium_on_lines.total
  || byName(x, y);

export function analyseProgrammes(book) {
  const { accounts, lines, brokers: brokerRows, reinsurers: panelRows } = book;

  // ---- the programmes: every account with an order to read ----
  const structured = accounts.filter((a) => a.broker_role);
  const structuredIds = new Set(structured.map((a) => a.id));
  const linesBy = groupBy(lines.filter((li) => structuredIds.has(li.placement_id)), 'placement_id');

  const programmes = structured.map((a) => {
    const ls = linesBy.get(a.id) || [];
    const onLines = moneyBag();
    for (const li of ls) {
      if (li.premium100 != null) onLines.add(li.currency, Number(li.premium100) * lineShare(li) / 100);
    }
    return {
      id: a.id,
      reference: a.reference,
      cedant_id: a.cedant_id,
      cedant_name: a.cedant_name,
      cedant_country: a.cedant_country,
      cedant_region: a.cedant_region,
      class: a.class,
      treaty_types: a.treaty_types,
      inception: a.inception,
      year: a.inception_year,
      status: a.status,
      currency: a.currency,
      layers: a.layer_count,
      premium100: a.total_premium100,
      premium_order: a.premium_order,
      order_share_pct: a.order_share_pct,
      brokerage_pct: a.brokerage_pct,
      brokerage_expected: a.brokerage_expected,
      broker_role: a.broker_role,
      role_source: a.role_source,
      lead_broker: a.lead_broker,
      broker_key: brokerKeyOf(a.lead_broker),
      lead_reinsurer: a.lead_reinsurer,
      lead_source: a.lead_source,
      panel: a.panel,
      panel_size: a.panel_size,
      lines: ls.length,
      signed_lines: ls.filter((li) => li.status === 'SIGNED').length,
      premium_on_lines: onLines.value(),
    };
  });
  const programmeById = new Map(programmes.map((p) => [p.id, p]));

  // ---- by broker: the house placing each programme ----
  const brokers = new Map();
  const brokerSeed = (key, p) => {
    const known = brokerRows.find((b) => b.key === key);
    return {
      key,
      name: known?.name ?? p?.lead_broker ?? null,
      is_house: known?.is_house ?? (!!p?.lead_broker && p.lead_broker.toLowerCase() === HOUSE.toLowerCase()),
      register_id: known?.register_id ?? null,
      programmes: 0, led: 0, followed: 0, layers: 0, lines: 0, signed_lines: 0, programmes_with_lines: 0,
      panel_sizes: [], programme_ids: [],
      premium: moneyBag(), premium_order: moneyBag(), premium_on_lines: moneyBag(),
      classes: new Map(), treaty_types: new Map(), reinsurers: new Map(),
    };
  };
  for (const p of programmes) {
    const b = brokers.get(p.broker_key) || brokerSeed(p.broker_key, p);
    b.programmes += 1;
    if (p.broker_role === 'Lead') b.led += 1; else b.followed += 1;
    b.layers += p.layers;
    b.lines += p.lines;
    b.signed_lines += p.signed_lines;
    if (p.lines) { b.programmes_with_lines += 1; b.panel_sizes.push(p.panel_size); }
    b.premium.add(p.currency, p.premium100);
    b.premium_order.add(p.currency, p.premium_order);
    b.premium_on_lines.addMoney(p.premium_on_lines);
    b.programme_ids.push(p.id);

    const c = b.classes.get(p.class) || { class: p.class, programmes: 0, premium: moneyBag(), premium_order: moneyBag() };
    c.programmes += 1;
    c.premium.add(p.currency, p.premium100);
    c.premium_order.add(p.currency, p.premium_order);
    b.classes.set(p.class, c);

    for (const type of typesOf(p.treaty_types)) {
      const t = b.treaty_types.get(type) || { type, programmes: 0 };
      t.programmes += 1;
      b.treaty_types.set(type, t);
    }
    for (const li of linesBy.get(p.id) || []) {
      const r = b.reinsurers.get(li.market_id) || tally({ market_id: li.market_id, name: li.name });
      tallyLine(r, li, p.id);
      b.reinsurers.set(li.market_id, r);
    }
    brokers.set(p.broker_key, b);
  }
  const brokerOut = [...brokers.values()].map((b) => {
    const premium = b.premium.value();
    const order = b.premium_order.value();
    return {
      key: b.key,
      name: b.name,
      is_house: b.is_house,
      register_id: b.register_id,
      programmes: b.programmes,
      led: b.led,
      followed: b.followed,
      layers: b.layers,
      lines: b.lines,
      signed_lines: b.signed_lines,
      programmes_with_lines: b.programmes_with_lines,
      reinsurer_count: b.reinsurers.size,
      avg_panel_size: mean(b.panel_sizes),
      premium,
      premium_order: order,
      // What the lead house places beyond our order — nothing when we lead.
      premium_rest: moneyMinus(premium, order),
      order_share_pct: premium.total > 0 ? round2((order.total / premium.total) * 100) : null,
      premium_on_lines: b.premium_on_lines.value(),
      classes: [...b.classes.values()]
        .map((c) => ({ ...c, premium: c.premium.value(), premium_order: c.premium_order.value() }))
        .sort((x, y) => y.programmes - x.programmes || y.premium.total - x.premium.total || x.class.localeCompare(y.class)),
      treaty_types: [...b.treaty_types.values()]
        .sort((x, y) => y.programmes - x.programmes || x.type.localeCompare(y.type)),
      reinsurers: [...b.reinsurers.values()].map(closeTally).sort(byWeight),
      programme_ids: b.programme_ids,
    };
  }).sort((x, y) => Number(y.is_house) - Number(x.is_house)
    || y.programmes - x.programmes
    || y.premium.total - x.premium.total
    || (x.name || 'zzz').localeCompare(y.name || 'zzz'));

  // ---- by reinsurer: who writes the programmes, cut by broker, class and role ----
  const reinsurers = new Map(panelRows.map((r) => [r.market_id, {
    ...r,
    brokers: new Map(), classes: new Map(), programme_ids: new Set(),
    roles: { lead: new Set(), follow: new Set(), none: new Set() },
    premium_lead: moneyBag(), premium_follow: moneyBag(), premium_unroled: moneyBag(),
  }]));
  for (const li of lines) {
    const p = programmeById.get(li.placement_id);
    const r = reinsurers.get(li.market_id);
    if (!p || !r) continue;
    r.programme_ids.add(p.id);
    const roleKey = li.role === 'lead' ? 'lead' : li.role === 'follow' ? 'follow' : 'none';
    r.roles[roleKey].add(p.id);
    if (li.premium100 != null) {
      const bag = roleKey === 'lead' ? r.premium_lead : roleKey === 'follow' ? r.premium_follow : r.premium_unroled;
      bag.add(li.currency, Number(li.premium100) * lineShare(li) / 100);
    }
    const b = r.brokers.get(p.broker_key) || tally({
      key: p.broker_key,
      name: p.lead_broker || null,
      is_house: !!p.lead_broker && p.lead_broker.toLowerCase() === HOUSE.toLowerCase(),
    });
    tallyLine(b, li, p.id);
    r.brokers.set(p.broker_key, b);
    const c = r.classes.get(p.class) || tally({ class: p.class });
    tallyLine(c, li, p.id);
    r.classes.set(p.class, c);
  }
  const reinsurerOut = [...reinsurers.values()]
    .filter((r) => r.programme_ids.size)
    .map((r) => {
      // A programme reads by the strongest role the reinsurer holds on it.
      const lead = r.roles.lead.size;
      const follow = [...r.roles.follow].filter((id) => !r.roles.lead.has(id)).length;
      const unroled = [...r.roles.none].filter((id) => !r.roles.lead.has(id) && !r.roles.follow.has(id)).length;
      return {
        market_id: r.market_id,
        name: r.name,
        rating: r.rating,
        region: r.region,
        country: r.country,
        programmes: r.programme_ids.size,
        programmes_lead: lead,
        programmes_follow: follow,
        programmes_unroled: unroled,
        programmes_led: r.accounts_led,
        lines: r.lines,
        lead_lines: r.lead_lines,
        follow_lines: r.follow_lines,
        signed_lines: r.signed_lines,
        share_total: r.share_total,
        avg_line_pct: r.avg_line_pct,
        premium_on_lines: r.premium_on_lines,
        premium_signed: r.premium_signed,
        premium_lead: r.premium_lead.value(),
        premium_follow: r.premium_follow.value(),
        premium_unroled: r.premium_unroled.value(),
        brokers: [...r.brokers.values()].map(closeTally)
          .sort((x, y) => Number(y.is_house) - Number(x.is_house) || byWeight(x, y)),
        classes: [...r.classes.values()].map(closeTally)
          .sort((x, y) => y.programmes - x.programmes || y.premium_on_lines.total - x.premium_on_lines.total || x.class.localeCompare(y.class)),
        programme_ids: [...r.programme_ids],
      };
    })
    .sort(byWeight);

  // ---- by class of business and by treaty year ----
  const classes = new Map();
  const years = new Map();
  for (const p of programmes) {
    const c = classes.get(p.class) || {
      class: p.class, programmes: 0, led: 0, followed: 0, layers: 0, lines: 0,
      premium: moneyBag(), premium_order: moneyBag(), premium_on_lines: moneyBag(), reinsurers: new Set(), brokers: new Set(),
    };
    const y = years.get(p.year) || {
      year: p.year, programmes: 0, led: 0, followed: 0, layers: 0, lines: 0, signed_lines: 0,
      premium: moneyBag(), premium_order: moneyBag(), premium_on_lines: moneyBag(),
      reinsurers: new Set(), brokers: new Set(), cedants: new Set(),
    };
    for (const g of [c, y]) {
      g.programmes += 1;
      if (p.broker_role === 'Lead') g.led += 1; else g.followed += 1;
      g.layers += p.layers;
      g.lines += p.lines;
      g.premium.add(p.currency, p.premium100);
      g.premium_order.add(p.currency, p.premium_order);
      g.premium_on_lines.addMoney(p.premium_on_lines);
      g.brokers.add(p.broker_key);
      for (const li of linesBy.get(p.id) || []) g.reinsurers.add(li.market_id);
    }
    y.signed_lines += p.signed_lines;
    y.cedants.add(p.cedant_id);
    classes.set(p.class, c);
    years.set(p.year, y);
  }
  const closeGroup = (g) => ({
    ...g,
    premium: g.premium.value(),
    premium_order: g.premium_order.value(),
    premium_on_lines: g.premium_on_lines.value(),
    reinsurers: g.reinsurers.size,
    brokers: g.brokers.size,
    ...(g.cedants ? { cedants: g.cedants.size } : {}),
  });
  const classOut = [...classes.values()].map(closeGroup)
    .sort((x, y) => y.programmes - x.programmes || y.premium.total - x.premium.total || x.class.localeCompare(y.class));
  const yearOut = [...years.values()].map(closeGroup).sort((x, y) => x.year - y.year);

  // ---- the headline, and how concentrated the panel is ----
  const premiumSeen = moneyBag();
  const premiumOrder = moneyBag();
  const premiumOnLines = moneyBag();
  const premiumSigned = moneyBag();
  const brokerageExpected = moneyBag();
  const cedants = new Set();
  const panelSizes = [];
  let lineCount = 0;
  let signedCount = 0;
  for (const p of programmes) {
    cedants.add(p.cedant_id);
    premiumSeen.add(p.currency, p.premium100);
    premiumOrder.add(p.currency, p.premium_order);
    premiumOnLines.addMoney(p.premium_on_lines);
    brokerageExpected.add(p.currency, p.brokerage_expected);
    lineCount += p.lines;
    signedCount += p.signed_lines;
    if (p.lines) panelSizes.push(p.panel_size);
  }
  for (const r of reinsurerOut) premiumSigned.addMoney(r.premium_signed);
  const seen = premiumSeen.value();
  const order = premiumOrder.value();
  const onLines = premiumOnLines.value();

  // Concentration: how much of the premium on lines the biggest writers carry.
  const ranked = reinsurerOut.slice().sort((x, y) => y.premium_on_lines.total - x.premium_on_lines.total || byName(x, y));
  let concentration = null;
  if (onLines.total > 0) {
    let cumulative = 0;
    const curve = ranked.map((r, i) => {
      cumulative = round2(cumulative + r.premium_on_lines.total);
      return {
        rank: i + 1,
        market_id: r.market_id,
        name: r.name,
        premium_on_lines: r.premium_on_lines.total,
        share_pct: round2((r.premium_on_lines.total / onLines.total) * 100),
        cumulative_pct: round2((cumulative / onLines.total) * 100),
      };
    });
    const topShare = (n) => (curve.length ? curve[Math.min(n, curve.length) - 1].cumulative_pct : null);
    concentration = {
      basis: 'premium_on_lines',
      reinsurers: curve.length,
      top1_pct: topShare(1),
      top3_pct: topShare(3),
      top5_pct: topShare(5),
      top10_pct: topShare(10),
      curve,
    };
  }

  return {
    year: book.year,
    house: book.house,
    summary: {
      programmes: programmes.length,
      accounts_on_book: accounts.length,
      accounts_unstructured: accounts.length - programmes.length,
      cedants: cedants.size,
      layers: programmes.reduce((n, p) => n + p.layers, 0),
      programmes_led: programmes.filter((p) => p.broker_role === 'Lead').length,
      programmes_followed: programmes.filter((p) => p.broker_role === 'Follow').length,
      programmes_with_lines: panelSizes.length,
      programmes_unnamed_broker: brokers.get(UNNAMED_BROKER)?.programmes || 0,
      brokers: brokerOut.filter((b) => b.name).length,
      other_brokers: brokerOut.filter((b) => b.name && !b.is_house).length,
      reinsurers: reinsurerOut.length,
      lines: lineCount,
      signed_lines: signedCount,
      premium_seen: seen,
      premium_order: order,
      order_share_pct: seen.total > 0 ? round2((order.total / seen.total) * 100) : null,
      premium_on_lines: onLines,
      premium_signed: premiumSigned.value(),
      brokerage_expected: brokerageExpected.value(),
      avg_panel_size: mean(panelSizes),
      concentration,
    },
    brokers: brokerOut,
    reinsurers: reinsurerOut,
    classes: classOut,
    years: yearOut,
    programmes,
  };
}
