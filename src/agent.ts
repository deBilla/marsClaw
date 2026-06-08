import type { Database } from 'bun:sqlite';
import { appendMessage } from './db/messages.ts';
import type { Channel } from './channels/types.ts';
import { PROVIDERS, pickProvider } from './providers/registry.ts';
import { runClaudeSdk } from './providers/claude-sdk.ts';
import { runContainerTurn } from './providers/container-client.ts';
import { ClaudeHardError, ClaudeSoftError } from './providers/claude-error.ts';
import { startTypingRefresh, stopTypingRefresh, pauseTypingAfterDelivery } from './lib/typing.ts';
import { log } from './lib/log.ts';
import { loadConfig } from './lib/config.ts';
import { buildTurnContext } from './lib/turn-context.ts';

const provider = pickProvider();
const config = loadConfig();
const AGENT_TIMEOUT_MS = Number(process.env.MARSCLAW_AGENT_TIMEOUT_MS ?? 300_000);

function geminiFriendlyError(msg: string): string {
  // Genuine daily exhaustion — won't clear until the quota resets. ONLY explicit
  // daily markers map here. "exhausted your capacity" / "quota will reset after
  // Ns" are the free tier's *per-minute* throttle (reset in seconds), which
  // gemini-sdk already retries; reporting those as a blown daily quota scared
  // users off when only ~5% of the day was used.
  if (/QUOTA_EXHAUSTED|PerDay|\bDaily\b/i.test(msg)) {
    return `I've hit my daily Gemini quota. Try again later or switch providers (\`bun run setup\` → claude).`;
  }
  if (/rate.?limit|RATE_LIMIT|RESOURCE_EXHAUSTED|exhausted your capacity|quota will reset|PerMinute|429/i.test(
      msg,
    )) {
    return `Gemini is rate-limiting me right now — give it a few seconds and try again.`;
  }
  if (/unauthorized|UNAUTHENTICATED|invalid.*token|expired/i.test(msg)) {
    return `My Gemini auth expired. Re-run setup to refresh the credentials.`;
  }
  return `Sorry — Gemini errored on that one. (${msg.slice(0, 200)})`;
}

export async function handleMessage(
  db: Database,
  channel: Channel,
  threadId: string,
  userText: string,
): Promise<void> {
  appendMessage(db, threadId, 'user', userText);

  // Ambient per-turn context (current local time, timezone, location). Built
  // fresh each message so the agent always knows "now" and where the user is.
  // Stored history stays raw — we only decorate what's sent to the provider.
  const context = buildTurnContext(config);

  // Begin the "typing…" indicator. The refresher fires every 4s while the
  // agent's heartbeat is fresh, so the user sees activity even on long turns.
  startTypingRefresh(threadId, channel);

  try {
    let response: string;
    // Synthetic = a canned error/fallback string, not real model output. Kept
    // out of history so the model never parrots our own outage messages.
    let synthetic = false;
    if (provider.name === 'claude') {
      // Two Claude runtimes share one failover path. Container mode runs the
      // agent unrestricted inside an isolated box over HTTP (Claude-only —
      // Gemini has no container service); in-process runs the SDK here. Both
      // return friendly text for soft errors and throw ClaudeHardError for
      // quota/auth, so the same catch can fail over to Gemini. (Google writes
      // still gate on the host either way — they escape the box.)
      const runClaude =
        config.runtime === 'container'
          ? () => runContainerTurn(db, threadId, `${context}\n\n${userText}`, AGENT_TIMEOUT_MS)
          : () => runClaudeSdk(db, threadId, `${context}\n\n${userText}`, AGENT_TIMEOUT_MS);
      try {
        response = await runClaude();
      } catch (err) {
        if (err instanceof ClaudeHardError && PROVIDERS.gemini.isAuthed()) {
          // Claude is out of quota or auth-broken; fall back to Gemini for
          // this turn so the user still gets an answer.
          log.warn('claude hard error — failing over to gemini', { thread: threadId, kind: err.kind });
          const r = await runGemini(db, threadId, userText, context);
          response = r.text;
          synthetic = r.synthetic;
        } else if (err instanceof ClaudeHardError) {
          response = err.friendly;
          synthetic = true;
        } else if (err instanceof ClaudeSoftError) {
          // Recoverable error that survived retries — send the friendly note but
          // keep it out of history so the model doesn't parrot the outage later.
          response = err.friendly;
          synthetic = true;
        } else {
          throw err;
        }
      }
    } else {
      const r = await runGemini(db, threadId, userText, context);
      response = r.text;
      synthetic = r.synthetic;
    }

    const reply = response.trim();
    if (!reply) {
      console.log(`[agent] ${threadId} produced empty reply — skipping send`);
      return;
    }

    // Persist only real model output; synthetic error/fallback strings are sent
    // but kept out of history so they don't poison future turns.
    if (!synthetic) appendMessage(db, threadId, 'assistant', reply);
    await channel.send(threadId, reply);
    pauseTypingAfterDelivery(threadId);
  } finally {
    stopTypingRefresh(threadId);
  }
}

// A turn's outcome: the text to send, plus whether it's a *synthetic* reply (a
// canned error/fallback string we generated, not real model output). Synthetic
// replies are sent to the user but NEVER written to history — otherwise the
// model reads its own "I've hit my quota" line next turn and keeps parroting it,
// reporting an outage long after the real one cleared.
interface TurnResult {
  text: string;
  synthetic: boolean;
}

async function runGemini(
  db: Database,
  threadId: string,
  userText: string,
  context: string,
): Promise<TurnResult> {
  try {
    // Lazy import: @google/gemini-cli-core pulls in tree-sitter WASM modules that
    // would otherwise load (and, in a compiled binary, be required from disk) on
    // every boot — even for the Claude/default path that never touches Gemini.
    const { runGeminiSdk } = await import('./providers/gemini-sdk.ts');
    const text = await runGeminiSdk(db, threadId, userText, context, AGENT_TIMEOUT_MS);
    return { text, synthetic: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('gemini sdk error', { thread: threadId, err: msg });
    return { text: geminiFriendlyError(msg), synthetic: true };
  }
}
