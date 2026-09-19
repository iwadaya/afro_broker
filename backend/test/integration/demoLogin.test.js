// Demo sign-in: one password for everyone, and the users to pick from on
// the login screen — only while DEMO_PASSWORD is set.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
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
      assert.deepEqual(list.body, { enabled: false, users: [] });
      assert.equal((await api('POST', '/api/auth/login', { body: { email: 'b@demo.test', password: 'password123' } })).status, 200);
    });
  } finally {
    config.demoPassword = saved;
  }
});
