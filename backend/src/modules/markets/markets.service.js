import { query } from '../../db/pool.js';
import { NotFoundError } from '../../lib/errors.js';
import { complianceFor } from '../../domain/compliance.js';

export const MARKET_TYPES = ['reinsurer', 'insurer', 'broker'];

/**
 * Business done with each counterparty, derived from the line ledger and the
 * approach log. `share` is the signed line where signing has run and the
 * written line before it, so a market's weight reads sensibly at every stage of
 * a placement.
 *
 * The lead/follow split comes from the approach, joined on (layer, market)
 * rather than on `line.approach_id`: a line may be written without naming the
 * approach it came from, and there is at most one approach per market per layer
 * anyway, so the join is exact and catches those lines too.
 */
const BUSINESS_CTE = `
  WITH biz AS (
    SELECT l.market_id,
           COUNT(*)::int                                                          AS lines_count,
           COUNT(*) FILTER (WHERE a.role = 'lead')::int                           AS lead_lines,
           COUNT(*) FILTER (WHERE a.role = 'follow')::int                         AS follow_lines,
           COUNT(*) FILTER (WHERE l.status = 'SIGNED')::int                       AS signed_lines,
           COALESCE(SUM(COALESCE(l.signed_pct, l.written_pct)), 0)::float8        AS total_share,
           COALESCE(SUM(COALESCE(l.signed_pct, l.written_pct))
                    FILTER (WHERE a.role = 'lead'), 0)::float8                    AS lead_share,
           COALESCE(SUM(COALESCE(l.signed_pct, l.written_pct))
                    FILTER (WHERE a.role = 'follow'), 0)::float8                  AS follow_share,
           COALESCE(SUM(l.premium_signed), 0)::float8                             AS premium_signed,
           MAX(l.updated_at)                                                      AS last_line_at
      FROM line l
      LEFT JOIN approach a ON a.layer_id = l.layer_id AND a.market_id = l.market_id
     GROUP BY l.market_id
  ),
  appr AS (
    SELECT market_id,
           COUNT(*)::int                                    AS approaches_count,
           COUNT(*) FILTER (WHERE role = 'lead')::int       AS lead_approaches,
           COUNT(*) FILTER (WHERE role = 'follow')::int     AS follow_approaches,
           COUNT(*) FILTER (WHERE status = 'DECLINED')::int AS declined_approaches
      FROM approach
     GROUP BY market_id
  )
`;

const BUSINESS_COLUMNS = `
  COALESCE(b.lines_count, 0)         AS lines_count,
  COALESCE(b.lead_lines, 0)          AS lead_lines,
  COALESCE(b.follow_lines, 0)        AS follow_lines,
  COALESCE(b.signed_lines, 0)        AS signed_lines,
  COALESCE(b.total_share, 0)         AS total_share,
  COALESCE(b.lead_share, 0)          AS lead_share,
  COALESCE(b.follow_share, 0)        AS follow_share,
  COALESCE(b.premium_signed, 0)      AS premium_signed,
  b.last_line_at                     AS last_line_at,
  COALESCE(ap.approaches_count, 0)   AS approaches_count,
  COALESCE(ap.lead_approaches, 0)    AS lead_approaches,
  COALESCE(ap.follow_approaches, 0)  AS follow_approaches,
  COALESCE(ap.declined_approaches, 0) AS declined_approaches,
  (COALESCE(b.lines_count, 0) > 0)   AS has_business
`;

const SORTS = {
  name: 'm.name ASC',
  share: 'COALESCE(b.total_share, 0) DESC, m.name ASC',
  lead_share: 'COALESCE(b.lead_share, 0) DESC, m.name ASC',
  follow_share: 'COALESCE(b.follow_share, 0) DESC, m.name ASC',
  lines: 'COALESCE(b.lines_count, 0) DESC, m.name ASC',
  recent: 'b.last_line_at DESC NULLS LAST, m.name ASC',
};

/** Split a repeated or comma-separated query param into a clean array. */
export function listParam(value) {
  if (value == null) return [];
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return parts.map((v) => String(v).trim()).filter(Boolean);
}

/**
 * The counterparty list behind the Reinsurers / Insurers / Brokers tabs.
 * Every filter is optional and they compose; `role` and `has_business` are the
 * two that read off the business aggregates rather than the register itself.
 */
export async function listMarkets(filters = {}) {
  const where = [];
  const params = [];
  const add = (value) => { params.push(value); return `$${params.length}`; };

  if (filters.type) where.push(`m.type = ${add(filters.type)}`);
  if (filters.q) where.push(`(m.name ILIKE ${add(`%${filters.q}%`)} OR m.group_name ILIKE $${params.length})`);

  const regions = listParam(filters.region);
  if (regions.length) where.push(`lower(m.region) = ANY(${add(regions.map((r) => r.toLowerCase()))})`);

  // The country of domicile — `domicile` has been the country column since the
  // first migration, so country filtering reads it rather than duplicating it.
  const countries = listParam(filters.country);
  if (countries.length) where.push(`lower(m.domicile) = ANY(${add(countries.map((c) => c.toLowerCase()))})`);

  const ratings = listParam(filters.rating);
  if (ratings.length) where.push(`upper(m.rating) = ANY(${add(ratings.map((r) => r.toUpperCase()))})`);

  const security = listParam(filters.security_status);
  if (security.length) where.push(`m.security_status = ANY(${add(security)})`);

  const kyc = listParam(filters.kyc_status);
  if (kyc.length) where.push(`m.kyc_status = ANY(${add(kyc)})`);

  if (filters.has_business === true) where.push('COALESCE(b.lines_count, 0) > 0');
  if (filters.has_business === false) where.push('COALESCE(b.lines_count, 0) = 0');

  // "Acts as lead / as follow": a market counts in a role once it has been
  // approached in it, not only once a line is on the ledger — otherwise a
  // market currently out to quote as lead would drop out of the filter.
  if (filters.role === 'lead') {
    where.push('(COALESCE(b.lead_lines, 0) > 0 OR COALESCE(ap.lead_approaches, 0) > 0)');
  }
  if (filters.role === 'follow') {
    where.push('(COALESCE(b.follow_lines, 0) > 0 OR COALESCE(ap.follow_approaches, 0) > 0)');
  }

  if (filters.min_share != null) where.push(`COALESCE(b.total_share, 0) >= ${add(filters.min_share)}`);
  if (filters.min_lead_share != null) where.push(`COALESCE(b.lead_share, 0) >= ${add(filters.min_lead_share)}`);
  if (filters.min_follow_share != null) where.push(`COALESCE(b.follow_share, 0) >= ${add(filters.min_follow_share)}`);

  const order = SORTS[filters.sort] || SORTS.name;
  const limit = add(filters.limit ?? 50);
  const offset = add(filters.offset ?? 0);

  const { rows } = await query(
    `${BUSINESS_CTE}
     SELECT m.*, ${BUSINESS_COLUMNS},
            COUNT(*) OVER ()::int AS total_count
       FROM market m
       LEFT JOIN biz b ON b.market_id = m.id
       LEFT JOIN appr ap ON ap.market_id = m.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order}
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  const total = rows[0]?.total_count ?? 0;
  return { total, markets: rows.map(({ total_count, ...row }) => shape(row)) };
}

/** Distinct values behind the filter dropdowns, scoped to the active tab. */
export async function facets(type) {
  const params = type ? [type] : [];
  const where = type ? 'WHERE type = $1' : '';
  const [regions, countries, ratings] = await Promise.all([
    query(`SELECT DISTINCT region AS v FROM market ${where} ${where ? 'AND' : 'WHERE'} region IS NOT NULL AND region <> '' ORDER BY 1`, params),
    query(`SELECT DISTINCT domicile AS v FROM market ${where} ${where ? 'AND' : 'WHERE'} domicile IS NOT NULL AND domicile <> '' ORDER BY 1`, params),
    query(`SELECT DISTINCT rating AS v FROM market ${where} ${where ? 'AND' : 'WHERE'} rating IS NOT NULL AND rating <> '' ORDER BY 1`, params),
  ]);
  const values = (r) => r.rows.map((x) => x.v);
  return { regions: values(regions), countries: values(countries), ratings: values(ratings) };
}

/** One counterparty: register row, compliance, group profile, and its business. */
export async function getMarket(id) {
  const { rows } = await query(
    `${BUSINESS_CTE}
     SELECT m.*, ${BUSINESS_COLUMNS}
       FROM market m
       LEFT JOIN biz b ON b.market_id = m.id
       LEFT JOIN appr ap ON ap.market_id = m.id
      WHERE m.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Market');

  const [profile, news, financials, placements, cedant] = await Promise.all([
    query('SELECT * FROM market_profile WHERE market_id = $1', [id]),
    query('SELECT * FROM market_news WHERE market_id = $1 ORDER BY published_at DESC NULLS LAST, created_at DESC LIMIT 20', [id]),
    query('SELECT * FROM market_financial WHERE market_id = $1 ORDER BY year DESC', [id]),
    query(
      `SELECT l.id AS line_id, l.written_pct, l.signed_pct, l.status, l.premium_signed,
              a.role, ly.id AS layer_id, ly.name AS layer_name, ly.currency,
              p.id AS placement_id, p.reference, p.status AS placement_status,
              c.name AS cedant_name
         FROM line l
         JOIN layer ly ON ly.id = l.layer_id
         JOIN placement p ON p.id = ly.placement_id
         LEFT JOIN cedant c ON c.id = p.cedant_id
         LEFT JOIN approach a ON a.layer_id = l.layer_id AND a.market_id = l.market_id
        WHERE l.market_id = $1
        ORDER BY l.updated_at DESC
        LIMIT 50`,
      [id],
    ),
    query('SELECT id, name FROM cedant WHERE market_id = $1 ORDER BY name', [id]),
  ]);

  const market = shape(rows[0]);
  return {
    ...market,
    profile: profile.rows[0] || null,
    news: news.rows,
    financials: financials.rows,
    placements: placements.rows,
    cedants: cedant.rows,
  };
}

/** Attach the derived compliance verdict and split the business aggregates out. */
function shape(row) {
  const {
    lines_count, lead_lines, follow_lines, signed_lines, total_share, lead_share,
    follow_share, premium_signed, last_line_at, approaches_count, lead_approaches,
    follow_approaches, declined_approaches, has_business, ...market
  } = row;
  return {
    ...market,
    compliance: complianceFor(market),
    business: {
      has_business,
      lines_count,
      lead_lines,
      follow_lines,
      signed_lines,
      total_share,
      lead_share,
      follow_share,
      premium_signed,
      last_line_at,
      approaches_count,
      lead_approaches,
      follow_approaches,
      declined_approaches,
    },
  };
}
