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

/** Thrown for a soft/recoverable error after retries are exhausted (e.g. a
 *  persistent rate limit). `friendly` is sent to the user but, unlike a real
 *  reply, must NOT be written to history — otherwise the model reads its own
 *  "I'm being rate-limited" line next turn and parrots the outage. */
export class ClaudeSoftError extends Error {
  constructor(public readonly friendly: string, message: string) {
    super(message);
    this.name = 'ClaudeSoftError';
  }
}

/** Parse a server-suggested retry delay (ms) from an error string: a
 *  `retry-after: 30` header echo, or prose like "try again in 12s" / "retry in
 *  500ms". Returns undefined when none is advertised. */
export function suggestedRetryDelayMs(msg: string): number | undefined {
  const header = msg.match(/retry-after"?\s*[:=]\s*"?([0-9.]+)/i);
  if (header) {
    const n = parseFloat(header[1]);
    if (!Number.isNaN(n)) return n * 1000; // header is seconds
  }
  const prose = msg.match(/(?:try again|retry)\s+(?:in|after)\s+([0-9.]+)\s*(ms|s)\b/i);
  if (prose) {
    const n = parseFloat(prose[1]);
    if (!Number.isNaN(n)) return prose[2].toLowerCase() === 'ms' ? n : n * 1000;
  }
  return undefined;
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
