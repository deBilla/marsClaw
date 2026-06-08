import { describe, it, expect } from 'bun:test';
import {
  isTransientError,
  suggestedRetryDelayMs,
  userFriendlyError,
} from '../src/providers/claude-error.ts';

// The real Anthropic 429 the container hands back as result text.
const ACCOUNT_429 =
  'API Error: Request rejected (429) · This request would exceed your account\'s rate limit. Please try again later.';

describe('userFriendlyError', () => {
  it('maps quota errors', () => {
    expect(userFriendlyError('QUOTA_EXHAUSTED for the day')).toContain('daily API quota');
    expect(userFriendlyError('You have exhausted your capacity')).toContain('daily API quota');
  });

  it('maps rate-limit errors', () => {
    expect(userFriendlyError('rate-limit exceeded')).toContain('rate-limited');
    expect(userFriendlyError('429 temporarily over limit')).toContain('rate-limited');
  });

  it('maps auth errors', () => {
    expect(userFriendlyError('UNAUTHENTICATED')).toContain('auth expired');
    expect(userFriendlyError('invalid_token')).toContain('auth expired');
    expect(userFriendlyError('authentication_failed')).toContain('auth expired');
  });

  it('returns null for unknown errors', () => {
    expect(userFriendlyError('something else happened')).toBeNull();
    expect(userFriendlyError('connection timed out')).toBeNull();
  });
});

describe('isTransientError', () => {
  it('matches transient network / 5xx / generic rate-limit', () => {
    expect(isTransientError('rate-limit')).toBe(true);
    expect(isTransientError('429 too many requests')).toBe(true);
    expect(isTransientError('502 bad gateway')).toBe(true);
    expect(isTransientError('socket hang up')).toBe(true);
    expect(isTransientError('fetch failed')).toBe(true);
  });

  it('treats quota-exhausted as NON-transient', () => {
    expect(isTransientError('QUOTA_EXHAUSTED')).toBe(false);
  });

  it('treats auth errors as NON-transient', () => {
    expect(isTransientError('UNAUTHENTICATED')).toBe(false);
    expect(isTransientError('invalid token')).toBe(false);
  });

  it('returns false for non-matching errors', () => {
    expect(isTransientError('some random error')).toBe(false);
  });

  it('treats the real account 429 as transient (so it gets retried)', () => {
    expect(isTransientError(ACCOUNT_429)).toBe(true);
  });
});

describe('suggestedRetryDelayMs', () => {
  it('parses a retry-after header echo (seconds)', () => {
    expect(suggestedRetryDelayMs('retry-after: 30')).toBe(30_000);
    expect(suggestedRetryDelayMs('Retry-After=5')).toBe(5_000);
  });

  it('parses prose delays in s and ms', () => {
    expect(suggestedRetryDelayMs('please try again in 12s')).toBe(12_000);
    expect(suggestedRetryDelayMs('retry after 1.5s')).toBe(1_500);
    expect(suggestedRetryDelayMs('retry in 500ms')).toBe(500);
  });

  it('returns undefined when no delay is advertised', () => {
    expect(suggestedRetryDelayMs(ACCOUNT_429)).toBeUndefined();
    expect(suggestedRetryDelayMs('rate-limit exceeded')).toBeUndefined();
  });
});
