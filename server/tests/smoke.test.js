// Import-time smoke test: every route module and the app factory load without a DB.
import { describe, it, expect } from 'vitest';

describe('server modules load', () => {
  it('imports the app factory and routers', async () => {
    const { createApp } = await import('../src/app.js');
    expect(typeof createApp).toBe('function');
    const auth = await import('../src/routes/auth.js');
    const lookups = await import('../src/routes/lookups.js');
    const broking = await import('../src/broking/index.js');
    expect(auth.default).toBeTruthy();
    expect(lookups.default).toBeTruthy();
    expect(broking.default).toBeTruthy();
  });
});
