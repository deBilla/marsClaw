// Map raw Claude / Anthropic error messages to user-facing friendly text.
// Extracted from claude-sdk.ts so the regex matchers can be unit-tested.

/** Hard, non-retryable errors that may be worth failing over to another provider. */
export type HardErrorKind = 'quota' | 'auth' | 'other';

export function classifyHardError(msg: string): HardErrorKind {
  if (/QUOTA_EXHAUSTED|exhausted your capacity|quota will reset/i.test(msg)) return 'quota';
  if (/unauthorized|UNAUTHENTICATED|invalid.*token|expired|authentication_failed/i.test(msg)) return 'auth';
  return 'other';
}

/** Thrown by runClaudeSdk when the SDK gives back a non-recoverable error.
 *  Caller decides whether to fail over to another provider. */
export class ClaudeHardError extends Error {
  constructor(public readonly kind: HardErrorKind, public readonly friendly: string, message: string) {
    super(message);
    this.name = 'ClaudeHardError';
  }
}

export function userFriendlyError(msg: string): string | null {
  if (/QUOTA_EXHAUSTED|exhausted your capacity|quota will reset/i.test(msg)) {
    return `I've hit my daily API quota. Try again later or switch providers.`;
  }
  if (/rate.?limit|RATE_LIMIT|429.*temporarily/i.test(msg)) {
    return `I'm being rate-limited. Try again in a minute.`;
  }
  if (/unauthorized|UNAUTHENTICATED|invalid.*token|expired|authentication_failed/i.test(msg)) {
    return `My API auth expired. Re-run setup or refresh the credentials.`;
  }
  return null;
}

// Retryable transient errors — short network hiccups, 5xx, generic 429s
// (not the quota-exhausted variant which is permanent for the day).
export function isTransientError(msg: string): boolean {
  if (/QUOTA_EXHAUSTED|exhausted your capacity|quota will reset/i.test(msg)) return false;
  if (/unauthorized|UNAUTHENTICATED|invalid.*token|expired|authentication_failed/i.test(msg)) return false;
  return /rate.?limit|RATE_LIMIT|429|5\d\d|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(msg);
}
