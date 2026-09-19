import bcrypt from 'bcryptjs';
import { query, withAdvisoryLock } from './pool.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { seedWordingLibrary } from './seedWordings.js';
import { seedMarketClauses } from './seedMarketClauses.js';
import { installTermSchemas } from '../domain/termSchemas/index.js';
import { seedDeclineReasons } from './seedDeclineReasons.js';

/** Arbitrary but fixed key, so every instance contends on the same lock. */
const WORDING_LIBRARY_LOCK = 49172301;
const TERM_SCHEMA_LOCK = 49172302;
const WORDING_LIBRARY_ENTITY = 'wording_library';

/**
 * Demo sign-in: reset every user's password to DEMO_PASSWORD at boot, so a
 * demonstration deployment signs in as anyone with one known password. A
 * no-op without the variable. Idempotent: a user whose password already is
 * the demo password is left alone.
 */
export async function bootstrapDemoPassword({ silent = false } = {}) {
  const password = config.demoPassword;
  if (!password) return 0;
  const { rows } = await query('SELECT id, email, password_hash FROM users');
  let reset = 0;
  for (const u of rows) {
    if (await bcrypt.compare(password, u.password_hash)) continue;
    const hash = await bcrypt.hash(password, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, u.id]);
    reset += 1;
  }
  if (reset && !silent) console.log(`demo sign-in: reset ${reset} user password${reset === 1 ? '' : 's'} to DEMO_PASSWORD`);
  return reset;
}

/**
 * Create the first admin account on a fresh deployment.
 *
 * Managed platforms often give you no shell on the free tier, so there is no
 * way to run the seed script against the live database — without this the app
 * would deploy with an empty users table and no way to sign in. It only ever
 * fires when the users table is completely empty, so it cannot be used to
 * re-add or resurrect an account later; once you have signed in, provision
 * further users through `POST /api/auth/register` and clear these env vars.
 */
export async function bootstrapAdmin({ silent = false } = {}) {
  const { email, password, name } = config.bootstrapAdmin;
  if (!email || !password) return false;

  if (password.length < 12) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
  }

  const { rows } = await query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return false;

  const hash = await bcrypt.hash(password, 10);
  // ON CONFLICT guards the case of two instances booting against the same
  // fresh database at once.
  const inserted = await query(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO NOTHING`,
    [email, name, hash],
  );
  if (inserted.rowCount && !silent) {
    console.log(`bootstrapped initial admin: ${email}`);
  }
  return inserted.rowCount > 0;
}

/**
 * Load the wording library on a fresh deployment.
 *
 * The clause corpus ships as a seed script (`npm run seed`), and the managed
 * platforms this deploys to give you no shell to run it with — so without this
 * the Wording library screen comes up empty ("0 clauses · 0 authentic market
 * forms"), with no way to fill it short of typing every clause in by hand.
 * Migrations create the tables; they deliberately carry no clause data, because
 * the corpus is content a firm may replace rather than schema.
 *
 * It fires only when this database has never been seeded, which is recorded as
 * an audit event rather than inferred from the library being empty: a firm that
 * clears the illustrative drafting to load its own approved wordings must not
 * find ours back in the library after the next restart. Both seeders are
 * idempotent regardless, and neither overwrites a clause anyone has edited.
 */
export async function bootstrapWordingLibrary({ silent = false } = {}) {
  if (!config.seedWordingLibraryOnBoot) return false;

  // Serialise instances booting against the same fresh database.
  return withAdvisoryLock(WORDING_LIBRARY_LOCK, async () => {
    if (await wordingLibrarySeeded()) return false;

    const library = await seedWordingLibrary();
    const market = await seedMarketClauses();
    await markWordingLibrarySeeded({ ...library, ...market, via: 'boot' });

    if (!silent) {
      console.log(
        `seeded wording library: ${library.standard} standard clauses, `
        + `${library.market} house clauses, ${market.upgraded + market.inserted} market-standard forms`,
      );
    }
    return true;
  });
}

/** Whether this database has ever had the wording library loaded. */
export async function wordingLibrarySeeded() {
  const { rows } = await query(
    `SELECT 1 FROM audit_event
     WHERE entity_type = $1 AND action = 'seeded' LIMIT 1`,
    [WORDING_LIBRARY_ENTITY],
  );
  return rows.length > 0;
}

/**
 * Record that the library has been loaded, so boot leaves it alone from here
 * on. `npm run seed` marks it too — an operator who seeds by hand and then
 * clears the corpus should not have it come back at the next restart.
 */
export async function markWordingLibrarySeeded(detail = {}) {
  if (await wordingLibrarySeeded()) return false;
  await audit({
    entityType: WORDING_LIBRARY_ENTITY, entityId: null, action: 'seeded', detail,
  });
  return true;
}

/**
 * Load the term schemas on a fresh deployment (§1.3, D9).
 *
 * Migrations create `term_schema` but carry no rows, for the same reason they
 * carry no clauses: schema content is seed data, not structure. Without this a
 * fresh deployment comes up unable to create a single structure, since every
 * one validates against a schema that would not be there.
 *
 * Idempotent on (treaty_type, cob, version), so an existing schema is never
 * rewritten — a schema that has already validated a structure must not change
 * underneath it.
 */
export async function bootstrapTermSchemas({ silent = false } = {}) {
  return withAdvisoryLock(TERM_SCHEMA_LOCK, async () => {
    const { installed, drifted } = await installTermSchemas();
    if (installed.length && !silent) {
      console.log(`installed term schemas: ${installed.map((s) => s.treaty_type).join(', ')}`);
    }
    // Loud, and never silently reconciled: the stored schema is the one that
    // validated the structures already in this database.
    for (const d of drifted) console.warn(`term schema drift: ${d.message}`);

    // M6/D4 — the decline reason vocabulary. Without it a decline cannot be
    // recorded at all, since a reason code is required.
    const { inserted } = await seedDeclineReasons();
    if (inserted && !silent) console.log(`seeded ${inserted} decline reasons`);

    return installed.length > 0 || inserted > 0;
  });
}
