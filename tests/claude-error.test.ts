import { describe, it, expect } from 'bun:test';
import { isTransientError, userFriendlyError } from '../src/providers/claude-error.ts';

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
});
