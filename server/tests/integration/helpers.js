// server/tests/integration/helpers.js — shared harness for DB-backed tests
// (pattern from Universe). Boots the Express app with supertest and authenticates
// through the ALLOW_DEMO_AUTH `x-user-id` header as the seeded demo users.
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { closePools, verifyDatabaseConnection, pool } from '../../src/db/pool.js';

export const ORG_A = '00000000-0000-0000-0000-00000000a0b1';
export const ORG_B = '00000000-0000-0000-0000-00000000a0b2';
export const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';
export const BROKER_USER_ID = '00000000-0000-0000-0000-000000000002';
export const OTHER_ORG_USER_ID = '00000000-0000-0000-0000-000000000003';

export const shouldSkipDb = process.env.TEST_WITH_DB !== '1';

/** Pick the ids of seeded reference rows a contract needs. */
export async function refIds() {
  const q = async (sql) => (await pool.query(sql)).rows[0];
  const country = await q(`SELECT country_id AS id FROM public.country WHERE country_code='KE'`);
  const cedant = await q(`SELECT company_id AS id FROM public.companies WHERE company_name='Kenya Re'`);
  const broker = await q(`SELECT broker_id AS id FROM public.brokers WHERE broker_name='Afro-Asian Re Brokers'`);
  const currency = await q(`SELECT currency_id AS id FROM public.currency WHERE currency_code='USD'`);
  const types = (await pool.query(`SELECT treaty_type_id AS id, treaty_type AS name FROM public.treaty_type`)).rows;
  const classes = (await pool.query(`SELECT class_of_business_id AS id, class_of_business AS name FROM public.class_of_business ORDER BY class_of_business`)).rows;
  const type = (name) => types.find((t) => t.name === name)?.id;
  const cls = (name) => classes.find((c) => c.name === name)?.id;
  return { countryId: country.id, cedantId: cedant.id, brokerId: broker.id, currencyId: currency.id, type, cls, classes };
}

export async function bootApp() {
  await verifyDatabaseConnection();
  const app = await createApp();
  const as = (userId = BROKER_USER_ID) => ({
    get: (path) => request(app).get(path).set('x-user-id', userId),
    post: (path, body) => request(app).post(path).set('x-user-id', userId).send(body),
    put: (path, body) => request(app).put(path).set('x-user-id', userId).send(body),
    patch: (path, body) => request(app).patch(path).set('x-user-id', userId).send(body),
    delete: (path) => request(app).delete(path).set('x-user-id', userId),
  });
  return { app, as, anon: request(app) };
}

export { closePools, pool };
