// `bun run smoke` — fire a synthetic message through the agent loop end-to-end.
//
// What it does:
//   - Builds a fresh in-memory DB
//   - Constructs a mock Channel that captures sends
//   - Calls handleMessage with a canned prompt
//   - Asserts the agent produced a non-empty reply
//
// This actually runs the Anthropic/Gemini agent — so it costs money. Skip
// in CI; run before/after a deploy or after touching agent.ts.

import { Database } from 'bun:sqlite';
import { runMigrations } from '../db/migrations.ts';
import { handleMessage } from '../agent.ts';
import type { Channel, SendOpts } from '../channels/types.ts';

const PROMPT = process.argv[3] ?? 'Respond with the single word "ok".';

class MockChannel implements Channel {
  sent: { threadId: string; text: string; opts?: SendOpts }[] = [];
  async send(threadId: string, text: string, opts?: SendOpts): Promise<void> {
    this.sent.push({ threadId, text, opts });
  }
  async setTyping(_threadId: string): Promise<void> {
    /* no-op */
  }
}

async function main(): Promise<void> {
  const db = new Database(':memory:');
  runMigrations(db);
  const channel = new MockChannel();
  const threadId = 'smoke:test';

  const t0 = Date.now();
  console.log('→', PROMPT);
  await handleMessage(db, channel, threadId, PROMPT);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (channel.sent.length === 0) {
    console.error(`\x1b[31m✗\x1b[0m no reply produced after ${elapsed}s`);
    process.exit(1);
  }
  const reply = channel.sent[0].text;
  console.log(`← ${reply}`);
  console.log(`\x1b[32m✓\x1b[0m smoke pass in ${elapsed}s, ${reply.length} chars`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\x1b[31m✗\x1b[0m smoke failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
