import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { query } from '../../src/db/pool.js';
import { config } from '../../src/config.js';
import { bootstrapAdmin, bootstrapWordingLibrary } from '../../src/db/bootstrap.js';

before(async () => {
  await resetDb();
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
});

/** Run a body with config.bootstrapAdmin temporarily overridden. */
async function withBootstrapEnv(values, fn) {
  const saved = { ...config.bootstrapAdmin };
  Object.assign(config.bootstrapAdmin, values);
  try {
    return await fn();
  } finally {
    Object.assign(config.bootstrapAdmin, saved);
  }
}

test('health check answers without auth (used as the platform probe)', async () => {
  await withServer(async (api) => {
    const res = await api('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });
});

// The SPA fallback must never swallow API paths: an unknown /api route has to
// come back as a JSON error, not index.html. Unauthenticated it is a 401 (the
// routers mounted under /api authenticate first, which also avoids advertising
// which routes exist); with a valid token it falls through to a JSON 404.
test('unknown /api routes return JSON, never the SPA shell', async () => {
  const admin = await makeUser('admin');
  await withServer(async (api) => {
    const anon = await api('GET', '/api/nope');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.code, 'unauthorized');

    const authed = await api('GET', '/api/nope', { token: admin.token });
    assert.equal(authed.status, 404);
    assert.equal(authed.body.code, 'route_not_found');
  });
});

test('bootstrap admin creates the first user and can then sign in', async () => {
  await withBootstrapEnv(
    { email: 'first@broking.local', password: 'a-long-enough-password', name: 'First Admin' },
    async () => {
      assert.equal(await bootstrapAdmin({ silent: true }), true);
      const { rows } = await query('SELECT email, role FROM users');
      assert.deepEqual(rows, [{ email: 'first@broking.local', role: 'admin' }]);

      await withServer(async (api) => {
        const res = await api('POST', '/api/auth/login', {
          body: { email: 'first@broking.local', password: 'a-long-enough-password' },
        });
        assert.equal(res.status, 200);
        assert.equal(res.body.user.role, 'admin');
      });
    },
  );
});

test('bootstrap admin is a no-op once any user exists', async () => {
  await makeUser('broker');
  await withBootstrapEnv(
    { email: 'late@broking.local', password: 'a-long-enough-password', name: 'Late' },
    async () => {
      assert.equal(await bootstrapAdmin({ silent: true }), false);
      const { rows } = await query('SELECT 1 FROM users WHERE email = $1', ['late@broking.local']);
      assert.equal(rows.length, 0, 'must not add an admin to a populated system');
    },
  );
});

test('bootstrap admin refuses a weak password rather than creating one', async () => {
  await withBootstrapEnv({ email: 'weak@broking.local', password: 'short', name: 'Weak' }, async () => {
    await assert.rejects(() => bootstrapAdmin({ silent: true }), /at least 12 characters/);
    const { rows } = await query('SELECT count(*)::int AS n FROM users');
    assert.equal(rows[0].n, 0);
  });
});

test('bootstrap admin does nothing when unconfigured', async () => {
  await withBootstrapEnv({ email: '', password: '' }, async () => {
    assert.equal(await bootstrapAdmin({ silent: true }), false);
  });
});

/* --------------------------------------------------- wording library on boot */

/** Run a body with the boot-time library loader temporarily switched on. */
async function withLibrarySeeding(enabled, fn) {
  const saved = config.seedWordingLibraryOnBoot;
  config.seedWordingLibraryOnBoot = enabled;
  try {
    return await fn();
  } finally {
    config.seedWordingLibraryOnBoot = saved;
  }
}

const clauseCount = async () => {
  const { rows } = await query('SELECT count(*)::int AS n FROM wording_clause');
  return rows[0].n;
};

// The bug this guards: migrations create the wording tables but carry no
// clauses, so a deployment that never ran `npm run seed` came up with an empty
// Wording library and no way to fill it.
test('a migrated-but-unseeded database gets its wording library on boot', async () => {
  assert.equal(await clauseCount(), 0, 'migrations alone must not carry clauses');

  await withLibrarySeeding(true, async () => {
    assert.equal(await bootstrapWordingLibrary({ silent: true }), true);
  });

  const seeded = await clauseCount();
  assert.ok(seeded > 100, `expected the full corpus, got ${seeded} clauses`);

  const { rows: forms } = await query(
    `SELECT count(*)::int AS n FROM wording_clause WHERE provenance = 'market_standard'`,
  );
  assert.ok(forms[0].n > 0, 'the authentic market forms must be loaded too');

  const broker = await makeUser('broker');
  await withServer(async (api) => {
    const res = await api('GET', '/api/wordings/clauses?limit=200', { token: broker.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, seeded, 'the library screen must see every clause');
  });
});

test('the boot loader runs once, then leaves the library alone', async () => {
  await withLibrarySeeding(true, async () => {
    assert.equal(await bootstrapWordingLibrary({ silent: true }), true);
    const after = await clauseCount();

    // A firm clears the illustrative corpus to load its own approved wordings.
    await query('DELETE FROM wording_draft_clause');
    await query('DELETE FROM wording_clause');
    assert.equal(await bootstrapWordingLibrary({ silent: true }), false);
    assert.equal(await clauseCount(), 0, 'a deliberately cleared library must stay cleared');
    assert.ok(after > 0);
  });
});

test('the boot loader can be switched off for a release-phase seed', async () => {
  await withLibrarySeeding(false, async () => {
    assert.equal(await bootstrapWordingLibrary({ silent: true }), false);
  });
  assert.equal(await clauseCount(), 0);
});
