import {test,before,after} from 'node:test';
import {resetDb,pool} from '../helpers.js';
import {withTransaction} from '../../src/db/pool.js';
import {verifyPremiumWorkspace} from '../fixtures/premiumWorkspace.js';
before(resetDb);after(()=>pool.end());
test('premium workspace enforces four eyes, immutable notes and signed-share accounting',()=>verifyPremiumWorkspace(pool,withTransaction));
