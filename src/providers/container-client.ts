// Host-side client for runtime='container'. Instead of running the Claude SDK
// in-process (runClaudeSdk), the host posts each turn to the agent container's
// HTTP control channel and relays the reply. The container holds no DB, so the
// host carries the resume id down and persists the sessionId the container
// returns.
//
// The host keeps everything else: per-thread serialization, the outbox drain,
// the approval interceptor, sqlite history. This is purely the agent-invocation
// swap (see src/agent.ts handleMessage).

import type { Database } from 'bun:sqlite';
import { getThreadSession, setThreadSession, clearThreadSession } from '../db/sessions.ts';
import { loadHistory } from '../db/messages.ts';
import { loadConfig } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { ensureContainerUp, recordActivity } from './container-runtime.ts';
import { ClaudeHardError, classifyHardError, userFriendlyError } from './claude-error.ts';

const PROVIDER_NAME = 'claude';
const SEED_TURNS = 20;

// The Claude CLI sometimes surfaces an upstream API failure (rate limit, quota,
// auth) as the assistant RESULT TEXT rather than a thrown error — it begins
// "API Error: …". Detect that distinctive prefix so we can translate it like a
// real error instead of relaying the raw string to the user.
function looksLikeApiError(text: string): boolean {
  return /^API Error\b/i.test(text.trim());
}

// Apply the same error contract as runClaudeSdk: throw ClaudeHardError for
// quota/auth (so handleMessage can fail over to Gemini), otherwise return
// friendly text. `raw` is the error string (from a thrown turn or an API-error
// result). Returns friendly text, or throws ClaudeHardError.
function interpretError(raw: string): string {
  const kind = classifyHardError(raw);
  const friendly = userFriendlyError(raw);
  if (kind !== 'other') {
    throw new ClaudeHardError(kind, friendly ?? 'My API auth/quota failed.', raw);
  }
  return friendly ?? `Sorry — my agent runtime hit an error on that one. Try again in a moment.`;
}

// The container resumes from its OWN ~/.claude transcript store. A session id
// stored from a prior IN-PROCESS run (host's ~/.claude) — or one purged on the
// container side — won't resolve there. Detect that and retry fresh, mirroring
// the in-process STALE_SESSION_RE handling in claude-sdk.ts.
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

// Fold prior sqlite history into the first message of a fresh container session
// so a provider switch / fresh box doesn't lose context. Mirrors the in-process
// prependHistory (claude-sdk.ts). The trailing row is the current user message
// (already appended by handleMessage), so drop it to avoid duplication.
function prependHistory(db: Database, threadId: string, userText: string): string {
  const rows = loadHistory(db, threadId, SEED_TURNS + 1);
  const prior = rows.length > 0 && rows[rows.length - 1]?.role === 'user' ? rows.slice(0, -1) : rows;
  if (prior.length === 0) return userText;
  const lines: string[] = [
    '[Conversation history from a previous session — context only, do not respond to old messages.]',
    '',
  ];
  for (const m of prior) lines.push(`${m.role === 'user' ? 'User' : 'You'}: ${m.text}`);
  lines.push('', '[End history.]', '');
  return `${lines.join('\n')}${userText}`;
}

interface TurnResponse {
  reply?: string;
  sessionId?: string | null;
  error?: string;
  kind?: string;
}

/**
 * Run one agent turn in the container. Drop-in replacement for runClaudeSdk's
 * signature so handleMessage can branch with minimal change.
 */
export async function runContainerTurn(
  db: Database,
  threadId: string,
  userText: string,
  timeoutMs: number,
): Promise<string> {
  const cfg = loadConfig();
  const base = cfg.container_turn_url.replace(/\/+$/, '');

  // Lazy-start the container on demand (nanoclaw's wake-on-message, shared-
  // container variant). First message after idle pays the cold start; warm
  // afterwards. recordActivity() below defers the idle stop.
  await ensureContainerUp();
  recordActivity();

  const resumeId = getThreadSession(db, threadId, PROVIDER_NAME);
  // No prior container session → seed history into the message (one-time cost).
  const text = resumeId ? userText : prependHistory(db, threadId, userText);

  let data = await postTurn(base, threadId, text, timeoutMs, resumeId);

  // Stale resume id (e.g. a session from a prior in-process run, or purged on
  // the container side) → clear it and retry once as a fresh session, seeding
  // history into the message so context isn't lost.
  if (data.error && resumeId && STALE_SESSION_RE.test(data.error)) {
    log.info('container stale session — clearing and retrying fresh', { thread: threadId });
    clearThreadSession(db, threadId);
    const seeded = prependHistory(db, threadId, userText);
    data = await postTurn(base, threadId, seeded, timeoutMs, null);
  }

  // Thrown/HTTP error from the turn → friendly text, or ClaudeHardError (→ the
  // caller fails over to Gemini) for quota/auth.
  if (data.error) {
    log.error('container turn error', { thread: threadId, err: data.error });
    return interpretError(data.error);
  }

  const reply = data.reply ?? '';
  // The CLI may hand back an upstream API failure AS the result text (e.g. a
  // 429). Translate it instead of relaying the raw "API Error: …" to the user.
  if (looksLikeApiError(reply)) {
    log.warn('container turn returned API-error result text', { thread: threadId, preview: reply.slice(0, 120) });
    return interpretError(reply);
  }

  if (data.sessionId) setThreadSession(db, threadId, PROVIDER_NAME, data.sessionId);
  return reply;
}

// POST one turn to the container. Returns the parsed body; transport/HTTP
// failures are normalized into `{ error }` so the caller's retry logic is uniform.
async function postTurn(
  base: string,
  threadId: string,
  text: string,
  timeoutMs: number,
  resumeId: string | null,
): Promise<TurnResponse> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs + 30_000);
  try {
    const res = await fetch(`${base}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId, text, timeoutMs, resumeId }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as TurnResponse;
    if (!res.ok && !data.error) return { error: `container returned ${res.status}` };
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('container turn transport error', { thread: threadId, err: msg, url: base });
    return { error: `agent container unreachable at ${base} (${msg})` };
  } finally {
    clearTimeout(abortTimer);
  }
}

/** Host-initiated stop → interrupt the in-flight container turn for a thread. */
export async function interruptContainerThread(threadId: string): Promise<boolean> {
  const cfg = loadConfig();
  const base = cfg.container_turn_url.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/interrupt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId }),
    });
    const data = (await res.json().catch(() => ({}))) as { interrupted?: boolean };
    return Boolean(data.interrupted);
  } catch (err) {
    log.warn('container interrupt failed', { thread: threadId, err });
    return false;
  }
}
