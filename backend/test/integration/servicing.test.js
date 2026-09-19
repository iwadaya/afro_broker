import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, pool, withServer } from '../helpers.js';
import { verifyServicing } from '../fixtures/servicing.js';
before(resetDb);
after(() => pool.end());
test('servicing aggregates placed NP records without double counting', () => verifyServicing(pool));
test('servicing dashboard requires authentication', () => withServer(async api => {
  const response = await api('GET', '/api/dashboards/servicing/non-proportional');
  assert.equal(response.status, 401);
}));
