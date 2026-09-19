import { query } from '../../db/pool.js';
import { HOUSE } from '../../lib/house.js';

/**
 * The book as Portfolio intelligence reads it — who leads each account, who
 * places it and who writes it — read once and shared by the portfolio screen
 * (GET /dashboards/portfolio) and its programme analysis
 * (GET /dashboards/portfolio/programmes), so the two can never disagree.
 *
 * Everything is computed from the placement book on every call; nothing here
 * is a stored counter. The reading of each account:
 *
 *  - our role          Lead when the full 100% order is placed through this
 *                      desk on every layer, Follow when it holds a share of
 *                      it (§1.4) — the calendar's reading — unless the Final
 *                      Placement stage has recorded who leads (`lead_won`),
 *                      which is then authoritative. Null until the account
 *                      has a layer to read an order from.
 *  - lead broker       The house leading the account: us when we lead; the
 *                      other house named at Final Placement when we follow,
 *                      or unknown until it is named.
 *  - lead reinsurer    The Final Placement's lead reinsurer when recorded;
 *                      else the lead-role markets furthest along in the
 *                      marketing (signed > written > agreed > quoted >
 *                      approached — co-leads at the same stage all count,
 *                      a declined lead never does); else the reinsurers the
 *                      pack went out to as lead in the negotiation.
 *  - panel             The reinsurers with a written or signed line on the
 *                      account, from the layer ledger and the Final
 *                      Placement's lines, with the role each was approached in.
 *
 * Money is summed per currency as well as in total because the book holds no
 * FX rates: the UI shows the split beside any cross-currency figure.
 */

export { HOUSE };

/** Statuses that take an account off the book: it was lost, not placed. */
const OFF_BOOK = ['DECLINED', 'NTU', 'LAPSED'];

/** How far a lead-role approach has come — the order the calendar uses. */
const LEAD_RANK = ['SIGNED', 'WRITTEN', 'AGREED', 'QUOTED', 'APPROACHED'];

export const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const num = (v) => (v == null ? null : round2(v));

/** A per-currency money accumulator. `total` is the naive cross-currency sum. */
export function moneyBag() {
  const by_currency = {};
  let total = 0;
  return {
    add(currency, amount) {
      const a = Number(amount || 0);
      if (!a || !currency) return;
      by_currency[currency] = round2((by_currency[currency] || 0) + a);
      total = round2(total + a);
    },
    /** Fold a { total, by_currency } figure in, currency by currency. */
    addMoney(money) {
      for (const [ccy, amt] of Object.entries(money?.by_currency || {})) this.add(ccy, amt);
    },
    value() { return { total: round2(total), by_currency }; },
  };
}

/** `year=2027` scopes the book to the accounts incepting that year; anything else is the whole book. */
export function parseYear(value) {
  return /^\d{4}$/.test(String(value || '')) ? Number(value) : null;
}

/** The key the brokers roll up on: the lead broker's name, or one bucket for a house not yet named. */
export const UNNAMED_BROKER = '__unnamed__';
export const brokerKeyOf = (leadBroker) => (leadBroker ? leadBroker.toLowerCase() : UNNAMED_BROKER);

const SCOPE_WHERE = `
  ($1::int IS NULL OR EXTRACT(YEAR FROM p.inception)::int = $1::int)`;

async function loadAccounts(year) {
  const { rows } = await query(
    `SELECT p.id, p.reference, p.class, p.status, p.inception, p.expiry, p.currency, p.est_gwp,
            EXTRACT(YEAR FROM p.inception)::int AS inception_year,
            p.cedant_id, c.name AS cedant_name, c.domicile AS cedant_country, reg.region AS cedant_region,
            COALESCE(ly.layer_count, 0) AS layer_count, ly.treaty_types, ly.premium100, ly.premium_order,
            ly.order_share_pct, ly.brokerage_pct, ly.brokerage_expected, ly.full_order,
            f.id AS final_id, f.lead_won, f.lead_broker, f.status AS final_status, f.treaty_type AS final_treaty_type,
            f.lead_reinsurer_id, COALESCE(f.lead_reinsurer_name, fm.name) AS lead_reinsurer_name,
            fm.rating AS lead_reinsurer_rating, fm.region AS lead_reinsurer_region, fm.domicile AS lead_reinsurer_country
     FROM placement p
     JOIN cedant c ON c.id = p.cedant_id
     LEFT JOIN market reg ON reg.id = c.market_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS layer_count,
              string_agg(DISTINCT l.type, ' + ' ORDER BY l.type) AS treaty_types,
              SUM(l.premium100) AS premium100,
              -- The premium behind our order: the share of each layer we are mandated to place.
              SUM(l.premium100 * l.order_pct / 100) AS premium_order,
              CASE WHEN SUM(l.premium100) > 0
                   THEN SUM(l.order_pct * l.premium100) / SUM(l.premium100)
                   ELSE AVG(l.order_pct) END AS order_share_pct,
              CASE WHEN SUM(l.premium100) > 0
                   THEN SUM(l.brokerage_pct * l.premium100) / SUM(l.premium100)
                   ELSE AVG(l.brokerage_pct) END AS brokerage_pct,
              -- Brokerage on our order at the layers' rates: what the account is worth once placed.
              SUM(l.premium100 * l.order_pct / 100 * l.brokerage_pct / 100) AS brokerage_expected,
              BOOL_AND(l.order_pct >= 100) AS full_order
       FROM layer l WHERE l.placement_id = p.id
     ) ly ON TRUE
     LEFT JOIN final_placement f ON f.placement_id = p.id
     LEFT JOIN market fm ON fm.id = f.lead_reinsurer_id
     WHERE ${SCOPE_WHERE}
       AND p.status <> ALL($2::text[])
     ORDER BY p.inception, p.reference`,
    [year, OFF_BOOK],
  );
  return rows;
}

async function countLost(year) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM placement p WHERE ${SCOPE_WHERE} AND p.status = ANY($2::text[])`,
    [year, OFF_BOOK],
  );
  return rows[0].n;
}

/** Lead-role approaches at the furthest stage reached on each account. */
async function loadLeadApproaches(ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    `WITH la AS (
       SELECT l.placement_id, a.market_id, a.status,
              array_position($2::text[], a.status) AS rank
       FROM approach a
       JOIN layer l ON l.id = a.layer_id
       WHERE l.placement_id = ANY($1::uuid[]) AND a.role = 'lead' AND a.status <> 'DECLINED'
     )
     SELECT DISTINCT la.placement_id, la.market_id, la.status,
            m.name, m.rating, m.region, m.domicile
     FROM la
     JOIN market m ON m.id = la.market_id
     WHERE la.rank = (SELECT MIN(x.rank) FROM la x WHERE x.placement_id = la.placement_id)
     ORDER BY la.placement_id, m.name`,
    [ids, LEAD_RANK],
  );
  return rows;
}

/** Reinsurers the pack went to as lead in the negotiation, still in play. */
async function loadLeadNegotiations(ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT n.placement_id, n.market_id, n.status, m.name, m.rating, m.region, m.domicile
     FROM negotiation n
     JOIN market m ON m.id = n.market_id
     WHERE n.placement_id = ANY($1::uuid[]) AND n.role = 'lead' AND n.status IN ('SENT', 'QUOTED')
     ORDER BY n.placement_id, m.name`,
    [ids],
  );
  return rows;
}

/**
 * Every written or signed line on the book: the layer ledger, with the role
 * from the approach on (layer, market), and the Final Placement's lines,
 * with the role the market was sent the pack in.
 */
async function loadPanelLines(ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT ly.placement_id, li.market_id, m.name, m.rating, m.region, m.domicile,
            a.role, li.status, li.written_pct, li.signed_pct, li.premium_signed,
            ly.currency, ly.premium100
     FROM line li
     JOIN layer ly ON ly.id = li.layer_id
     JOIN market m ON m.id = li.market_id
     LEFT JOIN approach a ON a.layer_id = li.layer_id AND a.market_id = li.market_id
     WHERE ly.placement_id = ANY($1::uuid[]) AND li.status IN ('WRITTEN', 'SIGNED')
     UNION ALL
     SELECT f.placement_id, fl.market_id, m.name, m.rating, m.region, m.domicile,
            n.role, upper(fl.status), fl.written_pct, fl.signed_pct, NULL::numeric,
            p.currency, NULL::numeric
     FROM final_placement_line fl
     JOIN final_placement f ON f.id = fl.final_placement_id
     JOIN placement p ON p.id = f.placement_id
     JOIN market m ON m.id = fl.market_id
     LEFT JOIN negotiation n ON n.placement_id = f.placement_id AND n.market_id = fl.market_id
     WHERE f.placement_id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

/** The Brokers tab of the register, so a named lead broker links to its entry. */
async function loadRegisterBrokers() {
  const { rows } = await query(
    "SELECT id, name, region, domicile FROM market WHERE type = 'broker' ORDER BY name",
  );
  return rows;
}

export const groupBy = (rows, key) => {
  const out = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
};

/** The share a line carries: signed once signing has run, written until then. */
export const lineShare = (li) => Number(li.signed_pct ?? li.written_pct ?? 0);

/** Who leads an account, in order of authority: recorded, marketed, sent. */
function leadReinsurersOf(row, approaches, negotiations) {
  if (row.lead_reinsurer_id || row.lead_reinsurer_name) {
    return [{
      market_id: row.lead_reinsurer_id, name: row.lead_reinsurer_name,
      rating: row.lead_reinsurer_rating, region: row.lead_reinsurer_region, country: row.lead_reinsurer_country,
      source: 'final', status: row.final_status,
    }];
  }
  const fromApproach = approaches.get(row.id) || [];
  if (fromApproach.length) {
    return fromApproach.map((a) => ({
      market_id: a.market_id, name: a.name, rating: a.rating, region: a.region, country: a.domicile,
      source: 'approach', status: a.status,
    }));
  }
  return (negotiations.get(row.id) || []).map((n) => ({
    market_id: n.market_id, name: n.name, rating: n.rating, region: n.region, country: n.domicile,
    source: 'negotiation', status: n.status,
  }));
}

/** Our role on the account and the house leading it — see the header note. */
function brokerReading(row) {
  if (row.final_id) {
    const lead = !!row.lead_won;
    return {
      broker_role: lead ? 'Lead' : 'Follow',
      lead_broker: lead ? (row.lead_broker || HOUSE) : (row.lead_broker || null),
      role_source: 'final',
    };
  }
  if (row.layer_count > 0) {
    return {
      broker_role: row.full_order ? 'Lead' : 'Follow',
      lead_broker: row.full_order ? HOUSE : null,
      role_source: 'order',
    };
  }
  return { broker_role: null, lead_broker: null, role_source: null };
}

/**
 * Read the book in one scope. Returns the portfolio screen's payload —
 * summary, lead reinsurers, the reinsurer panel, the brokers and the
 * accounts — plus `lines`, every written or signed line with its account,
 * market, role and share, for analyses that need to cut the panel further.
 */
export async function readBook(year) {
  const [rows, lost, registerBrokers] = await Promise.all([
    loadAccounts(year), countLost(year), loadRegisterBrokers(),
  ]);
  const ids = rows.map((r) => r.id);
  const [leadApproaches, leadNegotiations, panelLines] = await Promise.all([
    loadLeadApproaches(ids), loadLeadNegotiations(ids), loadPanelLines(ids),
  ]);
  const approachesBy = groupBy(leadApproaches, 'placement_id');
  const negotiationsBy = groupBy(leadNegotiations, 'placement_id');
  const linesBy = groupBy(panelLines, 'placement_id');

  // ---- the accounts, one row each ----
  const accounts = rows.map((row) => {
    const reading = brokerReading(row);
    const leads = leadReinsurersOf(row, approachesBy, negotiationsBy);
    const panel = new Map();
    for (const li of linesBy.get(row.id) || []) {
      const cur = panel.get(li.market_id) || {
        market_id: li.market_id, name: li.name, role: li.role || null, lines: 0, share: 0, signed: false,
      };
      cur.lines += 1;
      cur.share = round2(cur.share + lineShare(li));
      cur.signed = cur.signed || li.status === 'SIGNED';
      if (!cur.role && li.role) cur.role = li.role;
      panel.set(li.market_id, cur);
    }
    return {
      id: row.id,
      reference: row.reference,
      cedant_id: row.cedant_id,
      cedant_name: row.cedant_name,
      cedant_country: row.cedant_country,
      cedant_region: row.cedant_region,
      class: row.class,
      treaty_types: row.treaty_types || row.final_treaty_type || null,
      status: row.status,
      inception: row.inception,
      inception_year: row.inception_year,
      expiry: row.expiry,
      currency: row.currency,
      est_gwp: num(row.est_gwp),
      layer_count: row.layer_count,
      total_premium100: num(row.premium100),
      premium_order: num(row.premium_order),
      order_share_pct: num(row.order_share_pct),
      brokerage_pct: num(row.brokerage_pct),
      brokerage_expected: num(row.brokerage_expected),
      ...reading,
      lead_won: row.final_id ? !!row.lead_won : null,
      final_status: row.final_status || null,
      lead_reinsurers: leads,
      lead_reinsurer: leads.map((l) => l.name).join(' + ') || null,
      lead_source: leads[0]?.source || null,
      panel: [...panel.values()].sort((a, b) => b.share - a.share || a.name.localeCompare(b.name)),
      panel_size: panel.size,
    };
  });

  // ---- who is leading: one row per lead reinsurer ----
  const leaders = new Map();
  for (const a of accounts) {
    for (const l of a.lead_reinsurers) {
      const key = l.market_id || `name:${String(l.name).toLowerCase()}`;
      const cur = leaders.get(key) || {
        market_id: l.market_id, name: l.name, rating: l.rating, region: l.region, country: l.country,
        accounts_led: 0, confirmed: 0, premium_led: moneyBag(), accounts: [],
      };
      cur.accounts_led += 1;
      if (l.source === 'final') cur.confirmed += 1;
      cur.premium_led.add(a.currency, a.total_premium100);
      cur.accounts.push({
        id: a.id, reference: a.reference, cedant_name: a.cedant_name, class: a.class,
        status: a.status, broker_role: a.broker_role, source: l.source, stage: l.status,
      });
      leaders.set(key, cur);
    }
  }
  const lead_reinsurers = [...leaders.values()]
    .map((r) => ({ ...r, premium_led: r.premium_led.value() }))
    .sort((x, y) => y.accounts_led - x.accounts_led
      || y.premium_led.total - x.premium_led.total
      || x.name.localeCompare(y.name));

  // ---- who is writing: one row per reinsurer on a panel ----
  const panels = new Map();
  for (const li of panelLines) {
    const cur = panels.get(li.market_id) || {
      market_id: li.market_id, name: li.name, rating: li.rating, region: li.region, country: li.domicile,
      accounts: new Set(), lines: 0, lead_lines: 0, follow_lines: 0, signed_lines: 0,
      share_total: 0, premium_signed: moneyBag(), premium_on_lines: moneyBag(),
    };
    const share = lineShare(li);
    cur.accounts.add(li.placement_id);
    cur.lines += 1;
    if (li.role === 'lead') cur.lead_lines += 1;
    if (li.role === 'follow') cur.follow_lines += 1;
    if (li.status === 'SIGNED') cur.signed_lines += 1;
    cur.share_total = round2(cur.share_total + share);
    cur.premium_signed.add(li.currency, li.premium_signed);
    if (li.premium100 != null) cur.premium_on_lines.add(li.currency, Number(li.premium100) * share / 100);
    panels.set(li.market_id, cur);
  }
  const reinsurers = [...panels.values()].map((r) => ({
    market_id: r.market_id, name: r.name, rating: r.rating, region: r.region, country: r.country,
    accounts: r.accounts.size, lines: r.lines, lead_lines: r.lead_lines, follow_lines: r.follow_lines,
    signed_lines: r.signed_lines,
    share_total: r.share_total,
    avg_line_pct: r.lines ? round2(r.share_total / r.lines) : null,
    premium_signed: r.premium_signed.value(),
    premium_on_lines: r.premium_on_lines.value(),
    accounts_led: leaders.get(r.market_id)?.accounts_led || 0,
  })).sort((x, y) => y.accounts - x.accounts
    || y.premium_on_lines.total - x.premium_on_lines.total
    || x.name.localeCompare(y.name));

  // ---- who is placing: one row per lead broker ----
  const registerByName = new Map(registerBrokers.map((b) => [b.name.toLowerCase(), b]));
  const brokers = new Map();
  for (const a of accounts) {
    if (!a.broker_role) continue; // nothing to attribute until the account has an order
    const key = brokerKeyOf(a.lead_broker);
    const cur = brokers.get(key) || {
      key,
      name: a.lead_broker || null,
      is_house: !!a.lead_broker && a.lead_broker.toLowerCase() === HOUSE.toLowerCase(),
      register_id: a.lead_broker ? registerByName.get(a.lead_broker.toLowerCase())?.id || null : null,
      accounts_count: 0, confirmed: 0, premium: moneyBag(), premium_order: moneyBag(), accounts: [],
    };
    cur.accounts_count += 1;
    if (a.role_source === 'final') cur.confirmed += 1;
    cur.premium.add(a.currency, a.total_premium100);
    cur.premium_order.add(a.currency, a.premium_order);
    cur.accounts.push({
      id: a.id, reference: a.reference, cedant_name: a.cedant_name, class: a.class, status: a.status,
      broker_role: a.broker_role, order_share_pct: a.order_share_pct, lead_reinsurer: a.lead_reinsurer,
    });
    brokers.set(key, cur);
  }
  const brokerRows = [...brokers.values()]
    .map((b) => ({ ...b, premium: b.premium.value(), premium_order: b.premium_order.value() }))
    .sort((x, y) => Number(y.is_house) - Number(x.is_house)
      || y.accounts_count - x.accounts_count
      || (x.name || 'zzz').localeCompare(y.name || 'zzz'));

  // ---- the headline ----
  const premiumSeen = moneyBag();
  const premiumOrder = moneyBag();
  const brokerageExpected = moneyBag();
  const estGwp = moneyBag();
  const cedants = new Set();
  let led = 0;
  let followed = 0;
  let unplaced = 0;
  for (const a of accounts) {
    cedants.add(a.cedant_id);
    premiumSeen.add(a.currency, a.total_premium100);
    premiumOrder.add(a.currency, a.premium_order);
    brokerageExpected.add(a.currency, a.brokerage_expected);
    estGwp.add(a.currency, a.est_gwp);
    if (a.broker_role === 'Lead') led += 1;
    else if (a.broker_role === 'Follow') followed += 1;
    else unplaced += 1;
  }
  const seen = premiumSeen.value();
  const order = premiumOrder.value();

  return {
    year,
    house: HOUSE,
    summary: {
      accounts: accounts.length,
      cedants: cedants.size,
      accounts_led: led,
      accounts_followed: followed,
      accounts_unplaced: unplaced,
      accounts_lost: lost,
      premium_seen: seen,
      premium_order: order,
      order_share_pct: seen.total > 0 ? round2((order.total / seen.total) * 100) : null,
      est_gwp: estGwp.value(),
      brokerage_expected: brokerageExpected.value(),
      reinsurers_on_panel: reinsurers.length,
      lead_reinsurers: lead_reinsurers.length,
      other_brokers: brokerRows.filter((b) => !b.is_house && b.name).length,
    },
    lead_reinsurers,
    reinsurers,
    brokers: brokerRows,
    accounts,
    lines: panelLines,
  };
}
