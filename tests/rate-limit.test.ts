import { describe, it, expect } from 'bun:test';
import { RateLimiter } from '../src/lib/rate-limit.ts';

describe('RateLimiter', () => {
  it('allows under the per-minute cap', () => {
    const r = new RateLimiter({ perMinute: 3, perHour: 1000 });
    expect(r.check('a', 1000).ok).toBe(true);
    expect(r.check('a', 1100).ok).toBe(true);
    expect(r.check('a', 1200).ok).toBe(true);
  });

  it('blocks when burst exhausted', () => {
    const r = new RateLimiter({ perMinute: 2, perHour: 1000 });
    r.check('a', 1000);
    r.check('a', 1100);
    const v = r.check('a', 1200);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe('burst');
      expect(v.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it('frees slots after the window expires', () => {
    const r = new RateLimiter({ perMinute: 1, perHour: 1000 });
    r.check('a', 0);
    expect(r.check('a', 30_000).ok).toBe(false);
    expect(r.check('a', 60_001).ok).toBe(true);
  });

  it('isolates keys', () => {
    const r = new RateLimiter({ perMinute: 1, perHour: 1000 });
    r.check('a', 0);
    expect(r.check('a', 1000).ok).toBe(false);
    expect(r.check('b', 1000).ok).toBe(true);
  });

  it('catches sustained band over an hour', () => {
    const r = new RateLimiter({ perMinute: 100, perHour: 3 });
    r.check('a', 0);
    r.check('a', 1000);
    r.check('a', 2000);
    const v = r.check('a', 3000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('sustained');
  });
});
