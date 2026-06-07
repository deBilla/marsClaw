import type { Database } from 'bun:sqlite';
import { appendMessage } from './db/messages.ts';
import type { Channel } from './channels/types.ts';
import { PROVIDERS, pickProvider } from './providers/registry.ts';
import { runClaudeSdk } from './providers/claude-sdk.ts';
import { runContainerTurn } from './providers/container-client.ts';
import { ClaudeHardError } from './providers/claude-error.ts';
import { startTypingRefresh, stopTypingRefresh, pauseTypingAfterDelivery } from './lib/typing.ts';
import { log } from './lib/log.ts';
import { loadConfig } from './lib/config.ts';
import { buildTurnContext } from './lib/turn-context.ts';

const provider = pickProvider();
const config = loadConfig();
const AGENT_TIMEOUT_MS = Number(process.env.MARSCLAW_AGENT_TIMEOUT_MS ?? 300_000);

function geminiFriendlyError(msg: string): string {
  if (/QUOTA_EXHAUSTED|exhausted your capacity|quota will reset|RESOURCE_EXHAUSTED/i.test(msg)) {
    return `I've hit my daily Gemini quota. Try again later or switch providers (\`bun run setup\` → claude).`;
  }
  if (/rate.?limit|RATE_LIMIT|429/i.test(msg)) {
    return `I'm being rate-limited. Try again in a minute.`;
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
          response = await runGemini(db, threadId, userText, context);
        } else if (err instanceof ClaudeHardError) {
          response = err.friendly;
        } else {
          throw err;
        }
      }
    } else {
      response = await runGemini(db, threadId, userText, context);
    }

    const reply = response.trim();
    if (!reply) {
      console.log(`[agent] ${threadId} produced empty reply — skipping send`);
      return;
    }

    appendMessage(db, threadId, 'assistant', reply);
    await channel.send(threadId, reply);
    pauseTypingAfterDelivery(threadId);
  } finally {
    stopTypingRefresh(threadId);
  }
}

async function runGemini(
  db: Database,
  threadId: string,
  userText: string,
  context: string,
): Promise<string> {
  try {
    // Lazy import: @google/gemini-cli-core pulls in tree-sitter WASM modules that
    // would otherwise load (and, in a compiled binary, be required from disk) on
    // every boot — even for the Claude/default path that never touches Gemini.
    const { runGeminiSdk } = await import('./providers/gemini-sdk.ts');
    return await runGeminiSdk(db, threadId, userText, context, AGENT_TIMEOUT_MS);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('gemini sdk error', { thread: threadId, err: msg });
    return geminiFriendlyError(msg);
  }
}
