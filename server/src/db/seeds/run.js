// server/src/db/seeds/run.js — idempotent seed runner.
//   npm run seed            (from server/)     or   npm run seed  (from the root)
//   npm run seed -- --check  report row counts only
// Runs every seeds/*.sql in name order as one query each. 002 is reference data
// (countries, currencies, brokers, cedants, treaty types, classes); 001 (demo
// organisation + users) and 003 (the two sample contracts) are DEMO data and
// are skipped in production unless --demo is passed or ALLOW_DEMO_AUTH=true.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePools } from '../pool.js';
import { logger } from '../../lib/logger.js';

const seedsDir = dirname(fileURLToPath(import.meta.url));
const CHECK_ONLY = process.argv.includes('--check');
const DEMO_FILES = new Set(['001_demo_users.sql', '003_broking_sample_contracts.sql']);
const INCLUDE_DEMO = process.argv.includes('--demo') || process.env.ALLOW_DEMO_AUTH === 'true' || process.env.NODE_ENV !== 'production';
const TABLES = ['bk_org', 'uw_user', 'country', 'currency', 'brokers', 'companies', 'treaty_type', 'class_of_business', 'bk_contract'];

async function counts() {
  const out = {};
  for (const t of TABLES) {
    try { const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM public.${t}`); out[t] = rows[0].n; }
    catch (err) { out[t] = err.code === '42P01' ? 'missing' : `error: ${err.message.split('\n')[0]}`; }
  }
  return out;
}

(async () => {
  let exitCode = 0;
  try {
    if (CHECK_ONLY) { console.log(JSON.stringify(await counts(), null, 2)); return; }
    const files = (await readdir(seedsDir)).filter((f) => f.endsWith('.sql') && (INCLUDE_DEMO || !DEMO_FILES.has(f))).sort();
    if (!INCLUDE_DEMO) logger.info('seed: demo data skipped in production (pass --demo to load the demo users and sample contracts)');
    for (const file of files) {
      const sql = await readFile(join(seedsDir, file), 'utf8');
      logger.info('seed running', { file });
      await pool.query(sql);
    }
    console.log(JSON.stringify(await counts(), null, 2));
    logger.info('seed complete', { files: files.length });
  } catch (err) {
    logger.error('seed failed', { error: err?.message, stack: err?.stack });
    exitCode = 1;
  } finally {
    await closePools().catch(() => {});
    process.exitCode = exitCode;
  }
})();
