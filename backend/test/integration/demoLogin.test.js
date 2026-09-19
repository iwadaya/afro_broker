// Demo sign-in: one password for everyone, and the users to pick from on
// the login screen — only while DEMO_PASSWORD is set.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { query } from '../../src/db/pool.js';
import { config } from '../../src/config.js';
import { bootstrapDemoPassword } from '../../src/db/bootstrap.js';

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => { await resetDb(); });

test('with DEMO_PASSWORD set, every user is reset to it at boot and listed for the login screen', async () => {
  const saved = config.demoPassword;
  config.demoPassword = 'demo2026';
  try {
    await makeUser('broker', 'b@demo.test');
    await makeUser('senior_broker', 's@demo.test');
    await makeUser('underwriter', 'u@demo.test');
    await makeUser('admin', 'a@demo.test');
    assert.equal(await bootstrapDemoPassword({ silent: true }), 4, 'every password reset');
    assert.equal(await bootstrapDemoPassword({ silent: true }), 0, 'and left alone the second time');

    await withServer(async (api) => {
      const list = await api('GET', '/api/auth/demo-users');
      assert.equal(list.status, 200);
      assert.equal(list.body.enabled, true);
      assert.equal(list.body.password, 'demo2026');
      assert.deepEqual(list.body.users.map((u) => u.role), ['broker', 'senior_broker', 'underwriter', 'admin'], 'brokers first');
      assert.equal(list.body.users[0].password_hash, undefined);

      for (const u of list.body.users) {
        const login = await api('POST', '/api/auth/login', { body: { email: u.email, password: 'demo2026' } });
        assert.equal(login.status, 200, `${u.email} signs in with the demo password`);
        assert.equal(login.body.user.role, u.role);
      }
      assert.equal((await api('POST', '/api/auth/login', { body: { email: 'b@demo.test', password: 'password123' } })).status, 401, 'the old password is gone');
    });
  } finally {
    config.demoPassword = saved;
  }
});

test('without DEMO_PASSWORD nothing is reset and the login screen gets no list', async () => {
  const saved = config.demoPassword;
  config.demoPassword = '';
  try {
    await makeUser('broker', 'b@demo.test');
    assert.equal(await bootstrapDemoPassword({ silent: true }), 0);
    await withServer(async (api) => {
      const list = await api('GET', '/api/auth/demo-users');
      assert.deepEqual(list.body, { enabled: false, users: [], auto_login: null });
      assert.equal((await api('POST', '/api/auth/login', { body: { email: 'b@demo.test', password: 'password123' } })).status, 200);
    });
  } finally {
    config.demoPassword = saved;
  }
});

/** Run a body with DEMO_AUTO_LOGIN temporarily set. */
async function withAutoLogin(value, fn) {
  const saved = config.demoAutoLogin;
  config.demoAutoLogin = value;
  try { return await fn(); } finally { config.demoAutoLogin = saved; }
}

test('DEMO_AUTO_LOGIN hands out the named user\'s session with no password, and says who on the login screen', async () => {
  await makeUser('admin', 'a@demo.test');
  const { user: broker } = await makeUser('broker', 'b@demo.test');
  await withAutoLogin('B@demo.test', async () => {
    await withServer(async (api) => {
      const list = await api('GET', '/api/auth/demo-users');
      assert.deepEqual(list.body.auto_login, { email: 'b@demo.test', name: broker.name, role: 'broker' }, 'the email is matched case-insensitively');

      const auto = await api('POST', '/api/auth/auto-login');
      assert.equal(auto.status, 200);
      assert.equal(auto.body.enabled, true);
      assert.equal(auto.body.user.email, 'b@demo.test');
      assert.equal(auto.body.user.password_hash, undefined);
      // The token is a real session for that user.
      const me = await api('GET', '/api/auth/me', { token: auto.body.token });
      assert.equal(me.status, 200);
      assert.equal(me.body.id, broker.id);
      // Still a broker: an admin-only route is refused.
      assert.equal((await api('GET', '/api/auth/users', { token: auto.body.token })).status, 403);
    });
  });
});

test('a bare truthy DEMO_AUTO_LOGIN picks the first user in the demo order', async () => {
  await makeUser('admin', 'a@demo.test');
  await makeUser('underwriter', 'u@demo.test');
  await makeUser('broker', 'zed@demo.test');
  await makeUser('broker', 'ann@demo.test');
  // The helper names every user after its role; the order is by name within a role.
  await query('UPDATE users SET name = $1 WHERE email = $2', ['Zed', 'zed@demo.test']);
  await query('UPDATE users SET name = $1 WHERE email = $2', ['Ann', 'ann@demo.test']);
  await withAutoLogin('1', async () => {
    await withServer(async (api) => {
      const auto = await api('POST', '/api/auth/auto-login');
      assert.equal(auto.body.enabled, true);
      assert.equal(auto.body.user.email, 'ann@demo.test', 'brokers first, then by name');
    });
  });
});

test('auto sign-in is off by default, and off when the user is missing or deactivated', async () => {
  const { user: broker } = await makeUser('broker', 'b@demo.test');
  await withServer(async (api) => {
    const off = await api('POST', '/api/auth/auto-login');
    assert.equal(off.status, 200, 'never an error: the app asks on every fresh load');
    assert.deepEqual(off.body, { enabled: false });
    assert.equal((await api('GET', '/api/auth/demo-users')).body.auto_login, null);
  });
  await withAutoLogin('nobody@demo.test', async () => {
    await withServer(async (api) => {
      assert.deepEqual((await api('POST', '/api/auth/auto-login')).body, { enabled: false }, 'an unknown email');
    });
  });
  await query('UPDATE users SET active = FALSE WHERE id = $1', [broker.id]);
  await withAutoLogin('b@demo.test', async () => {
    await withServer(async (api) => {
      assert.deepEqual((await api('POST', '/api/auth/auto-login')).body, { enabled: false }, 'a deactivated user');
    });
  });
});
