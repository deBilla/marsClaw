// Per-sender token bucket. Caps how often a single user can fire agent
// turns. Without this, anyone who knows your bot's handle can DOS-bill
// you by spamming messages — every inbound runs an Anthropic turn.
//
// Two bands by default:
//   - 10 messages per minute     (burst)
//   - 60 messages per hour       (sustained)
//
// Both must clear for the message to pass. Override via config.json
// `rate_limit_*` fields or per-env vars.

import { log } from './log.ts';

interface Band {
  limit: number;
  windowMs: number;
  // Sliding-window timestamps per key.
  recent: Map<string, number[]>;
}

function makeBand(limit: number, windowMs: number): Band {
  return { limit, windowMs, recent: new Map() };
}

function check(band: Band, key: string, now: number): { ok: boolean; retryAfterMs: number } {
  const stamps = band.recent.get(key) ?? [];
  const cutoff = now - band.windowMs;
  // Drop stamps outside the window.
  let head = 0;
  while (head < stamps.length && stamps[head] < cutoff) head++;
  const live = head === 0 ? stamps : stamps.slice(head);
  if (live.length >= band.limit) {
    const oldest = live[0];
    return { ok: false, retryAfterMs: Math.max(0, oldest + band.windowMs - now) };
  }
  live.push(now);
  band.recent.set(key, live);
  return { ok: true, retryAfterMs: 0 };
}

export interface RateLimiterConfig {
  perMinute: number;
  perHour: number;
}

export class RateLimiter {
  private burst: Band;
  private sustained: Band;
  constructor(cfg: RateLimiterConfig) {
    this.burst = makeBand(cfg.perMinute, 60_000);
    this.sustained = makeBand(cfg.perHour, 60 * 60_000);
  }

  /**
   * Returns `{ ok: true }` if the message passes, else
   * `{ ok: false, reason, retryAfterMs }` describing which band blocked.
   */
  check(key: string, now: number = Date.now()): { ok: true } | { ok: false; reason: string; retryAfterMs: number } {
    const b = check(this.burst, key, now);
    if (!b.ok) {
      log.debug('rate-limit (burst) hit', { key, retryAfterMs: b.retryAfterMs });
      return { ok: false, reason: 'burst', retryAfterMs: b.retryAfterMs };
    }
    const s = check(this.sustained, key, now);
    if (!s.ok) {
      log.debug('rate-limit (sustained) hit', { key, retryAfterMs: s.retryAfterMs });
      return { ok: false, reason: 'sustained', retryAfterMs: s.retryAfterMs };
    }
    return { ok: true };
  }
}
