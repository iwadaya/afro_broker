import { describe, it, expect } from 'vitest';
import { checkProductionConfig, toBool } from '../../src/config/env.js';

describe('env guards', () => {
  it('toBool accepts the usual truthy spellings', () => {
    expect(toBool('true')).toBe(true); expect(toBool('1')).toBe(true); expect(toBool('yes')).toBe(true);
    expect(toBool('false')).toBe(false); expect(toBool(undefined, true)).toBe(true); expect(toBool('')).toBe(false);
  });
  it('production refuses a missing secret and demo auth', () => {
    const errors = checkProductionConfig({ nodeEnv: 'production', authJwtSecret: '', allowDemoAuth: 'true' });
    expect(errors.some((e) => e.includes('AUTH_JWT_SECRET'))).toBe(true);
    expect(errors.some((e) => e.includes('ALLOW_DEMO_AUTH'))).toBe(true);
  });
  it('production accepts a strong secret', () => {
    expect(checkProductionConfig({ nodeEnv: 'production', authJwtSecret: 'x'.repeat(48) })).toEqual([]);
  });
  it('development enforces nothing', () => {
    expect(checkProductionConfig({ nodeEnv: 'development', authJwtSecret: '' })).toEqual([]);
  });
});
