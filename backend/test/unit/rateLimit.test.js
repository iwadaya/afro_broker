import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { rateLimit } from '../../src/middleware/rateLimit.js';
import { errorHandler } from '../../src/middleware/error.js';

/** Mount a handler behind the limiter and return a caller + a cleanup fn. */
async function harness(limiterOpts, handler) {
  const app = express();
  app.get('/x', rateLimit(limiterOpts), handler);
  app.use(errorHandler);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async () => {
    const resp = await fetch(`${base}/x`);
    return { status: resp.status, retryAfter: resp.headers.get('retry-after') };
  };
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

const fail = (_req, res) => res.status(401).json({ error: 'nope' });
const succeed = (_req, res) => res.json({ ok: true });

test('blocks once the failure budget is spent, with Retry-After', async () => {
  const { call, close } = await harness({ max: 3, windowMs: 60_000 }, fail);
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await call()).status, 401);
    const blocked = await call();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.retryAfter) > 0, 'sets a Retry-After header');
  } finally {
    await close();
  }
});

test('successful requests never consume the budget', async () => {
  const { call, close } = await harness({ max: 2, windowMs: 60_000 }, succeed);
  try {
    for (let i = 0; i < 20; i += 1) assert.equal((await call()).status, 200);
  } finally {
    await close();
  }
});

test('onlyFailures:false counts every request', async () => {
  const { call, close } = await harness({ max: 2, windowMs: 60_000, onlyFailures: false }, succeed);
  try {
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 429);
  } finally {
    await close();
  }
});

test('the window expires and the budget comes back', async () => {
  const { call, close } = await harness({ max: 1, windowMs: 40 }, fail);
  try {
    assert.equal((await call()).status, 401);
    assert.equal((await call()).status, 429);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await call()).status, 401, 'budget resets after the window');
  } finally {
    await close();
  }
});

test('buckets are keyed independently', async () => {
  let who = 'a';
  const { call, close } = await harness({ max: 1, windowMs: 60_000, keyOf: () => who }, fail);
  try {
    assert.equal((await call()).status, 401);
    assert.equal((await call()).status, 429);
    who = 'b';
    assert.equal((await call()).status, 401, 'a different key has its own budget');
  } finally {
    await close();
  }
});

test('disabled means pass-through', async () => {
  const { call, close } = await harness({ max: 1, windowMs: 60_000, enabled: false }, fail);
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await call()).status, 401);
  } finally {
    await close();
  }
});
