import { test, before, after } from 'node:test';
import { resetDb, pool } from '../helpers.js';
import { withTransaction } from '../../src/db/pool.js';
import { verifyClaimsWorkspace } from '../fixtures/claimsWorkspace.js';
before(resetDb); after(() => pool.end());
test('claims workspace reconciles retained loss, signed recoveries and independent approval', () => verifyClaimsWorkspace(pool, withTransaction));
