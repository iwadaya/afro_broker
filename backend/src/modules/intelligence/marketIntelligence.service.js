import { query, withTransaction } from '../../db/pool.js';
import { NotFoundError, ForbiddenError, ValidationError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { extractDocumentText } from '../../lib/tabular.js';
import { llmProviders } from '../../lib/llm.js';
import { readBook, moneyBag } from '../dashboards/portfolioBook.js';
import { loadCountries, countryOfDomicile, regionsOf, resolveScope } from './geography.js';
import { attributeAccounts, readRoi, aggregateRoi, isoDay, ATTRIBUTION_MONTHS } from './roi.js';
import { gatherBrief, isConfigured } from '../../integrations/marketBrief.js';

/**
 * Market intelligence — behind the "Market intelligence" button on Portfolio
 * intelligence: what the desk knows about a market, by country and by region
 * of the reference list, from three sources read together on every call.
 *
 *  - the book      the accounts whose cedant is domiciled in the scope, as
 *                  Portfolio intelligence reads them (portfolioBook.js), so
 *                  the two screens can never disagree about an account;
 *  - the brief     what the AI gathered from the internet for the scope —
 *                  market dynamics, the cedants, regulatory change, dated
 *                  developments — with the desk's own material folded in,
 *                  unverified until a person signs it off;
 *  - the desk      the brokers' market visits, each with what it cost and
 *                  the return the book shows for it (roi.js), and the notes
 *                  kept on a cedant, a country or a region. A cedant note
 *                  carries its cedant's country and region and a country
 *                  note its region, so every note rolls up into the scopes
 *                  above it and the next gather sees all of them.
 *
 * A visit or a note belongs to the user who wrote it: only they, or an
 * admin, can change or remove it. Everyone signed in can read everything.
 */

export const NOTE_LEVELS = ['cedant', 'country', 'region'];
const MAX_UPLOAD_CHARS = 60_000;

/** The reference countries, read once per request, with a domicile resolver. */
async function geography() {
  const countries = await loadCountries();
  return { countries, countryOf: (domicile) => countryOfDomicile(domicile, countries) };
}

/** A scope resolved against the list, or 404. */
export async function requireScope(type, key, geo) {
  const g = geo || await geography();
  const scope = resolveScope(type, key, g.countries);
  if (!scope) throw new NotFoundError(type === 'region' ? 'Region' : 'Country');
  return scope;
}

const codesOf = (scope) => new Set(scope.countries.map((c) => c.code));
const publicScope = (scope) => ({
  type: scope.type, key: scope.key, label: scope.label, region: scope.region,
  countries: scope.countries.map((c) => ({ code: c.code, name: c.name, region: c.region })),
});

/** The register's cedants, each resolved to its country. */
async function loadCedants(geo) {
  const { rows } = await query('SELECT id, name, domicile FROM cedant ORDER BY name');
  return rows.map((c) => {
    const country = geo.countryOf(c.domicile);
    return {
      id: c.id, name: c.name, domicile: c.domicile,
      country_code: country?.code || null, country_name: country?.name || null, region: country?.region || null,
    };
  });
}

/** The whole book, each account resolved to its cedant's country. */
async function loadBookAccounts(geo) {
  const { accounts } = await readBook(null);
  return accounts.map((a) => {
    const c = geo.countryOf(a.cedant_country);
    return { ...a, country_code: c?.code || null, country_name: c?.name || null, country_region: c?.region || null };
  });
}

function bookSummary(accounts) {
  const seen = moneyBag();
  const order = moneyBag();
  const brokerage = moneyBag();
  const cedants = new Set();
  let led = 0;
  let followed = 0;
  for (const a of accounts) {
    cedants.add(a.cedant_id);
    seen.add(a.currency, a.total_premium100);
    order.add(a.currency, a.premium_order);
    brokerage.add(a.currency, a.brokerage_expected);
    if (a.broker_role === 'Lead') led += 1;
    else if (a.broker_role === 'Follow') followed += 1;
  }
  return {
    accounts: accounts.length, cedants: cedants.size, accounts_led: led, accounts_followed: followed,
    premium_seen: seen.value(), premium_order: order.value(), brokerage_expected: brokerage.value(),
  };
}

const ai = () => ({ configured: isConfigured(), providers: llmProviders() });

// ---- Visits ----

const VISIT_SELECT = `
  SELECT v.id, v.user_id, u.name AS broker_name, v.country_code, v.country_name, v.region, v.city, v.purpose,
         to_char(v.start_date, 'YYYY-MM-DD') AS start_date, to_char(v.end_date, 'YYYY-MM-DD') AS end_date,
         v.cost_amount, v.cost_currency, v.notes, v.created_at, v.updated_at,
         COALESCE(vc.cedants, '[]'::json) AS cedants,
         COALESCE(n.notes_count, 0) AS notes_count
    FROM market_visit v
    JOIN users u ON u.id = v.user_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', c.id, 'name', c.name) ORDER BY c.name) AS cedants
        FROM market_visit_cedant vc JOIN cedant c ON c.id = vc.cedant_id
       WHERE vc.visit_id = v.id
    ) vc ON TRUE
    LEFT JOIN LATERAL (SELECT COUNT(*)::int AS notes_count FROM market_note n WHERE n.visit_id = v.id) n ON TRUE`;

/** Visits, newest first: all of them, or those in a set of countries, one user's, or one by id. */
export async function listVisits({ codes = null, userId = null, id = null } = {}) {
  const { rows } = await query(
    `${VISIT_SELECT}
      WHERE ($1::text[] IS NULL OR v.country_code = ANY($1::text[]))
        AND ($2::uuid IS NULL OR v.user_id = $2::uuid)
        AND ($3::uuid IS NULL OR v.id = $3::uuid)
      ORDER BY v.start_date DESC, v.created_at DESC`,
    [codes, userId, id],
  );
  return rows;
}

/** Each visit with the accounts credited to it and the return they carry. */
function withRoi(visits, accounts, geo) {
  return visits.map((v) => {
    const attributed = attributeAccounts(v, accounts, geo.countryOf);
    return {
      ...v,
      attributed: attributed.map((a) => ({
        id: a.id, reference: a.reference, cedant_id: a.cedant_id, cedant_name: a.cedant_name, class: a.class,
        inception: isoDay(a.inception), status: a.status, currency: a.currency, brokerage_expected: a.brokerage_expected,
      })),
      roi: readRoi({ amount: v.cost_amount, currency: v.cost_currency }, attributed),
    };
  });
}

/** The visits log: every trip (or one user's, or a scope's) with its return. */
export async function visitsView({ scope = null, userId = null } = {}) {
  const geo = await geography();
  const [accounts, visits] = await Promise.all([
    loadBookAccounts(geo),
    listVisits({ codes: scope ? [...codesOf(scope)] : null, userId }),
  ]);
  const rows = withRoi(visits, accounts, geo);
  return { visits: rows, roi: aggregateRoi(rows), attribution_months: ATTRIBUTION_MONTHS };
}

async function requireVisit(id) {
  const { rows } = await query('SELECT * FROM market_visit WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Market visit');
  return rows[0];
}

/** A visit or a note is its author's; an admin may tidy anyone's. */
function assertOwner(row, user, what) {
  if (row.user_id !== user.id && user.role !== 'admin') {
    throw new ForbiddenError(`Only the ${what}'s author or an admin can change it`);
  }
}

async function checkCedants(ids) {
  const unique = [...new Set(ids || [])];
  if (!unique.length) return [];
  const { rows } = await query('SELECT id FROM cedant WHERE id = ANY($1::uuid[])', [unique]);
  if (rows.length !== unique.length) throw new NotFoundError('Cedant');
  return unique;
}

function requireCountry(geo, code) {
  const country = geo.countryOf(code);
  if (!country) {
    throw new ValidationError('Country is not on the reference list', { fieldErrors: { country_code: ['unknown country'] } });
  }
  return country;
}

function checkDates(start, end) {
  if (isoDay(end) < isoDay(start)) {
    throw new ValidationError('The trip must end on or after the day it starts', { fieldErrors: { end_date: ['before start_date'] } });
  }
}

const currencyOf = (v) => String(v || 'USD').toUpperCase().slice(0, 8);

/** Log a trip for the signed-in broker. */
export async function createVisit(body, user) {
  const geo = await geography();
  const country = requireCountry(geo, body.country_code);
  checkDates(body.start_date, body.end_date);
  const cedantIds = await checkCedants(body.cedant_ids);
  const id = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO market_visit (user_id, country_code, country_name, region, city, purpose, start_date, end_date,
                                 cost_amount, cost_currency, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [user.id, country.code, country.name, country.region || null, body.city || null, body.purpose || null,
        body.start_date, body.end_date, body.cost_amount ?? 0, currencyOf(body.cost_currency), body.notes || null],
    );
    for (const cid of cedantIds) {
      await client.query('INSERT INTO market_visit_cedant (visit_id, cedant_id) VALUES ($1,$2)', [rows[0].id, cid]);
    }
    await audit({
      entityType: 'market_visit', entityId: rows[0].id, action: 'create', userId: user.id,
      detail: { country: country.code, start_date: body.start_date, end_date: body.end_date, cost: body.cost_amount ?? 0, currency: currencyOf(body.cost_currency), cedants: cedantIds.length },
    }, client);
    return rows[0].id;
  });
  return (await listVisits({ id }))[0];
}

/** Correct a trip: its own author, or an admin. */
export async function updateVisit(id, body, user) {
  const existing = await requireVisit(id);
  assertOwner(existing, user, 'trip');
  const geo = await geography();
  const fields = {};
  if (body.country_code !== undefined) {
    const country = requireCountry(geo, body.country_code);
    Object.assign(fields, { country_code: country.code, country_name: country.name, region: country.region || null });
  }
  for (const k of ['city', 'purpose', 'notes']) if (body[k] !== undefined) fields[k] = body[k] || null;
  if (body.start_date !== undefined) fields.start_date = body.start_date;
  if (body.end_date !== undefined) fields.end_date = body.end_date;
  checkDates(fields.start_date ?? existing.start_date, fields.end_date ?? existing.end_date);
  if (body.cost_amount !== undefined) fields.cost_amount = body.cost_amount;
  if (body.cost_currency !== undefined) fields.cost_currency = currencyOf(body.cost_currency);
  const cedantIds = body.cedant_ids !== undefined ? await checkCedants(body.cedant_ids) : null;

  await withTransaction(async (client) => {
    const keys = Object.keys(fields);
    if (keys.length) {
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      await client.query(`UPDATE market_visit SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
    }
    if (cedantIds) {
      await client.query('DELETE FROM market_visit_cedant WHERE visit_id = $1', [id]);
      for (const cid of cedantIds) {
        await client.query('INSERT INTO market_visit_cedant (visit_id, cedant_id) VALUES ($1,$2)', [id, cid]);
      }
    }
    await audit({
      entityType: 'market_visit', entityId: id, action: 'update', userId: user.id,
      detail: { ...fields, ...(cedantIds ? { cedants: cedantIds.length } : {}) },
    }, client);
  });
  return (await listVisits({ id }))[0];
}

/** Remove a trip, and the notes taken on it. */
export async function deleteVisit(id, user) {
  const existing = await requireVisit(id);
  assertOwner(existing, user, 'trip');
  await withTransaction(async (client) => {
    await client.query('DELETE FROM market_visit WHERE id = $1', [id]);
    await audit({ entityType: 'market_visit', entityId: id, action: 'delete', userId: user.id, detail: { country: existing.country_code } }, client);
  });
}

// ---- Notes ----

const NOTE_SELECT = `
  SELECT n.id, n.user_id, u.name AS author_name, n.visit_id, n.level, n.cedant_id, c.name AS cedant_name,
         n.country_code, n.country_name, n.region, to_char(n.noted_on, 'YYYY-MM-DD') AS noted_on,
         n.title, n.body, n.attachment_name, n.created_at, n.updated_at,
         v.purpose AS visit_purpose, to_char(v.start_date, 'YYYY-MM-DD') AS visit_start_date,
         v.country_name AS visit_country_name
    FROM market_note n
    JOIN users u ON u.id = n.user_id
    LEFT JOIN cedant c ON c.id = n.cedant_id
    LEFT JOIN market_visit v ON v.id = n.visit_id`;

/**
 * Notes, newest first. In a country's scope: the notes on that country and
 * on its cedants, plus the notes on the region it sits in; in a region's:
 * everything in the region. Without a scope: every note.
 */
export async function listNotes({ scope = null, cedantId = null, visitId = null, level = null, id = null, limit = 500 } = {}) {
  const codes = scope ? [...codesOf(scope)] : null;
  const region = scope?.region || null;
  const regionScope = scope?.type === 'region';
  const { rows } = await query(
    `${NOTE_SELECT}
      WHERE ($1::text[] IS NULL
             OR n.country_code = ANY($1::text[])
             OR (n.level = 'region' AND n.region = $2::text)
             OR ($3::boolean AND n.region = $2::text))
        AND ($4::uuid IS NULL OR n.cedant_id = $4::uuid)
        AND ($5::uuid IS NULL OR n.visit_id = $5::uuid)
        AND ($6::text IS NULL OR n.level = $6::text)
        AND ($7::uuid IS NULL OR n.id = $7::uuid)
      ORDER BY n.noted_on DESC, n.created_at DESC
      LIMIT $8`,
    [codes, region, regionScope, cedantId, visitId, level, id, limit],
  );
  return rows;
}

async function requireNote(id) {
  const { rows } = await query('SELECT * FROM market_note WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Note');
  return rows[0];
}

/** The note's text: what was typed, and what an uploaded file says, read out. */
async function noteText(body, file, existing = '') {
  let text = String(body ?? existing ?? '').trim();
  let attachmentName = null;
  if (file?.filename && file?.data) {
    const extracted = (await extractDocumentText(file.filename, file.data)).trim().slice(0, MAX_UPLOAD_CHARS);
    if (!extracted) throw new ValidationError(`Nothing readable in ${file.filename}`);
    text = [text, extracted].filter(Boolean).join('\n\n');
    attachmentName = file.filename;
  }
  if (!text) throw new ValidationError('A note needs some text, typed or uploaded');
  return { text, attachmentName };
}

/** Where a note sits: its cedant, country and region, from what was given. */
async function noteScope(body, geo) {
  if (body.level === 'cedant') {
    if (!body.cedant_id) throw new ValidationError('A cedant note names its cedant', { fieldErrors: { cedant_id: ['required'] } });
    const { rows } = await query('SELECT id, name, domicile FROM cedant WHERE id = $1', [body.cedant_id]);
    if (!rows[0]) throw new NotFoundError('Cedant');
    const country = geo.countryOf(rows[0].domicile);
    return { cedant_id: rows[0].id, country_code: country?.code || null, country_name: country?.name || null, region: country?.region || null };
  }
  if (body.level === 'country') {
    const country = requireCountry(geo, body.country_code);
    return { cedant_id: null, country_code: country.code, country_name: country.name, region: country.region || null };
  }
  const scope = resolveScope('region', body.region, geo.countries);
  if (!scope) throw new ValidationError('Region is not on the reference list', { fieldErrors: { region: ['unknown region'] } });
  return { cedant_id: null, country_code: null, country_name: null, region: scope.key };
}

/** Keep a note on a cedant, a country or a region — typed, or read from an uploaded file. */
export async function createNote(body, user) {
  const geo = await geography();
  const where = await noteScope(body, geo);
  if (body.visit_id) await requireVisit(body.visit_id);
  const { text, attachmentName } = await noteText(body.body, body.file);
  const { rows } = await query(
    `INSERT INTO market_note (user_id, visit_id, level, cedant_id, country_code, country_name, region,
                              noted_on, title, body, attachment_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, CURRENT_DATE),$9,$10,$11) RETURNING id`,
    [user.id, body.visit_id || null, body.level, where.cedant_id, where.country_code, where.country_name, where.region,
      body.noted_on || null, body.title || null, text, attachmentName],
  );
  await audit({
    entityType: 'market_note', entityId: rows[0].id, action: 'create', userId: user.id,
    detail: { level: body.level, cedant_id: where.cedant_id, country: where.country_code, region: where.region, visit_id: body.visit_id || null, attachment: attachmentName },
  });
  return (await listNotes({ id: rows[0].id }))[0];
}

/** Amend a note's text, title, date or trip: its author, or an admin. */
export async function updateNote(id, body, user) {
  const existing = await requireNote(id);
  assertOwner(existing, user, 'note');
  const fields = {};
  if (body.title !== undefined) fields.title = body.title || null;
  if (body.noted_on !== undefined) fields.noted_on = body.noted_on;
  if (body.visit_id !== undefined) {
    if (body.visit_id) await requireVisit(body.visit_id);
    fields.visit_id = body.visit_id || null;
  }
  if (body.body !== undefined || body.file) {
    const { text, attachmentName } = await noteText(body.body, body.file, existing.body);
    fields.body = text;
    if (attachmentName) fields.attachment_name = attachmentName;
  }
  const keys = Object.keys(fields);
  if (keys.length) {
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await query(`UPDATE market_note SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
    await audit({ entityType: 'market_note', entityId: id, action: 'update', userId: user.id, detail: { fields: keys } });
  }
  return (await listNotes({ id }))[0];
}

export async function deleteNote(id, user) {
  const existing = await requireNote(id);
  assertOwner(existing, user, 'note');
  await query('DELETE FROM market_note WHERE id = $1', [id]);
  await audit({ entityType: 'market_note', entityId: id, action: 'delete', userId: user.id, detail: { level: existing.level } });
}

// ---- The brief ----

const BRIEF_SELECT = `
  SELECT b.*, gu.name AS gathered_by_name, vu.name AS verified_by_name
    FROM market_intel_brief b
    LEFT JOIN users gu ON gu.id = b.gathered_by
    LEFT JOIN users vu ON vu.id = b.verified_by`;

async function loadBrief(scopeType, scopeKey) {
  const { rows } = await query(`${BRIEF_SELECT} WHERE b.scope_type = $1 AND b.scope_key = $2`, [scopeType, scopeKey]);
  return rows[0] || null;
}

/** Sign a gathered brief off once it has been checked against its sources. */
export async function verifyBrief(id, user) {
  const { rows } = await query(
    `UPDATE market_intel_brief SET verified = TRUE, verified_by = $2, verified_at = now(), updated_at = now()
      WHERE id = $1 RETURNING scope_type, scope_key`,
    [id, user.id],
  );
  if (!rows[0]) throw new NotFoundError('Market brief');
  await audit({ entityType: 'market_intel_brief', entityId: id, action: 'verify', userId: user.id });
  return loadBrief(rows[0].scope_type, rows[0].scope_key);
}

/** Everything the desk holds on a scope, cut for the gather. */
async function briefContext(scope, geo) {
  const codes = codesOf(scope);
  const [accounts, cedants, visits, notes] = await Promise.all([
    loadBookAccounts(geo), loadCedants(geo), listVisits({ codes: [...codes] }), listNotes({ scope }),
  ]);
  return {
    scope,
    book: {
      accounts: accounts
        .filter((a) => a.country_code && codes.has(a.country_code))
        .sort((a, b) => String(isoDay(b.inception)).localeCompare(String(isoDay(a.inception)))),
    },
    cedants: cedants.filter((c) => c.country_code && codes.has(c.country_code)),
    visits,
    notes,
  };
}

/**
 * Gather the brief for a scope from the internet, folding in the desk's own
 * material, and store it as the scope's current brief — unverified, replacing
 * the last gather. Throws `LlmUnavailableError` (503) with nothing written
 * when the research cannot run. `clients` is the test injection point.
 */
export async function gather({ type, key }, user, clients) {
  const geo = await geography();
  const scope = await requireScope(type, key, geo);
  const context = await briefContext(scope, geo);
  const brief = await gatherBrief(context, clients);
  const json = (v) => JSON.stringify(v || []);
  const { rows } = await query(
    `INSERT INTO market_intel_brief (scope_type, scope_key, scope_label, headline, market_dynamics, cedants, regulatory,
                                     developments, opportunities, from_the_desk, citations, notes_used, visits_used,
                                     provider, model, gathered_at, gathered_by, verified, verified_by, verified_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),$16,FALSE,NULL,NULL,now())
     ON CONFLICT (scope_type, scope_key) DO UPDATE SET
       scope_label = EXCLUDED.scope_label, headline = EXCLUDED.headline,
       market_dynamics = EXCLUDED.market_dynamics, cedants = EXCLUDED.cedants, regulatory = EXCLUDED.regulatory,
       developments = EXCLUDED.developments, opportunities = EXCLUDED.opportunities,
       from_the_desk = EXCLUDED.from_the_desk, citations = EXCLUDED.citations,
       notes_used = EXCLUDED.notes_used, visits_used = EXCLUDED.visits_used,
       provider = EXCLUDED.provider, model = EXCLUDED.model,
       gathered_at = now(), gathered_by = EXCLUDED.gathered_by,
       verified = FALSE, verified_by = NULL, verified_at = NULL, updated_at = now()
     RETURNING id`,
    [scope.type, scope.key, scope.label, brief.headline || null, json(brief.market_dynamics), json(brief.cedants),
      json(brief.regulatory), json(brief.developments), json(brief.opportunities), brief.from_the_desk,
      json(brief.citations), context.notes.length, context.visits.length, brief.provider, brief.model, user.id],
  );
  await audit({
    entityType: 'market_intel_brief', entityId: rows[0].id, action: 'gather', userId: user.id,
    detail: { scope: scope.type, key: scope.key, provider: brief.provider, model: brief.model, notes: context.notes.length, visits: context.visits.length },
  });
  return { ...await scopeView({ type: scope.type, key: scope.key }), gather: { provider: brief.provider, model: brief.model } };
}

// ---- The screen's read models ----

/**
 * The map: every region and country on the list with what the desk holds
 * on it — accounts and cedants on the book, cedants on the register, trips,
 * notes and whether a brief has been gathered — and the register's cedants
 * resolved to their countries, for the pickers.
 */
export async function overview() {
  const geo = await geography();
  const [accounts, cedants, visitRows, noteRows, briefRows] = await Promise.all([
    loadBookAccounts(geo),
    loadCedants(geo),
    query('SELECT country_code, COUNT(*)::int AS n FROM market_visit GROUP BY country_code').then((r) => r.rows),
    query('SELECT country_code, region, level, COUNT(*)::int AS n FROM market_note GROUP BY country_code, region, level').then((r) => r.rows),
    query('SELECT id, scope_type, scope_key, gathered_at, verified FROM market_intel_brief').then((r) => r.rows),
  ]);
  const visitsByCountry = new Map(visitRows.map((r) => [r.country_code, r.n]));
  const briefs = new Map(briefRows.map((b) => [`${b.scope_type}:${b.scope_key}`, { id: b.id, gathered_at: b.gathered_at, verified: b.verified }]));
  const sum = (rows, pick) => rows.filter(pick).reduce((n, r) => n + r.n, 0);

  const regions = regionsOf(geo.countries).map((r) => {
    const countries = r.countries.map((c) => {
      const onBook = accounts.filter((a) => a.country_code === c.code);
      return {
        code: c.code, name: c.name, region: c.region,
        accounts: onBook.length,
        cedants_on_book: new Set(onBook.map((a) => a.cedant_id)).size,
        cedants: cedants.filter((x) => x.country_code === c.code).length,
        visits: visitsByCountry.get(c.code) || 0,
        notes: sum(noteRows, (n) => n.country_code === c.code),
        brief: briefs.get(`country:${c.code}`) || null,
      };
    });
    const onBook = accounts.filter((a) => a.country_region === r.region);
    return {
      region: r.region,
      accounts: onBook.length,
      cedants_on_book: new Set(onBook.map((a) => a.cedant_id)).size,
      cedants: cedants.filter((x) => x.region === r.region).length,
      visits: countries.reduce((n, c) => n + c.visits, 0),
      notes: sum(noteRows, (n) => n.region === r.region),
      brief: briefs.get(`region:${r.region}`) || null,
      countries,
    };
  });

  return {
    ai: ai(),
    attribution_months: ATTRIBUTION_MONTHS,
    regions,
    cedants,
    totals: {
      accounts: accounts.length,
      accounts_unresolved: accounts.filter((a) => !a.country_code).length,
      visits: visitRows.reduce((n, r) => n + r.n, 0),
      notes: noteRows.reduce((n, r) => n + r.n, 0),
      briefs: briefRows.length,
    },
  };
}

/**
 * One scope in full: the brief, our book in the market (the treaty year
 * narrows this alone — a trip's return spans years), the register's cedants
 * there, the trips with their returns, and the notes.
 */
export async function scopeView({ type, key, year = null }) {
  const geo = await geography();
  const scope = await requireScope(type, key, geo);
  const codes = codesOf(scope);
  const [accountsAll, cedantsAll, visitRows, notes, brief] = await Promise.all([
    loadBookAccounts(geo), loadCedants(geo), listVisits({ codes: [...codes] }), listNotes({ scope }), loadBrief(scope.type, scope.key),
  ]);
  const inScope = accountsAll.filter((a) => a.country_code && codes.has(a.country_code));
  const visits = withRoi(visitRows, inScope, geo);
  const yearScoped = year ? inScope.filter((a) => a.inception_year === year) : inScope;
  return {
    scope: publicScope(scope),
    year,
    ai: ai(),
    attribution_months: ATTRIBUTION_MONTHS,
    brief,
    book: { accounts: yearScoped, summary: bookSummary(yearScoped) },
    cedants: cedantsAll.filter((c) => c.country_code && codes.has(c.country_code)),
    visits,
    roi: aggregateRoi(visits),
    notes,
  };
}
