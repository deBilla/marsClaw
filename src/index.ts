import { copyFileSync, existsSync } from 'node:fs';
import { initDb, markOutboxDelivered, takePendingOutbox } from './db.ts';
import { createTelegramChannel } from './channels/telegram.ts';
import { ChannelRouter } from './channels/router.ts';
import { handleMessage } from './agent.ts';
import { printRunningBanner } from './cli/branding.ts';

// Ensure local-only memory file exists before any agent runs against it.
if (!existsSync('MEMORY.md') && existsSync('MEMORY.template.md')) {
  copyFileSync('MEMORY.template.md', 'MEMORY.md');
}

const db = initDb();
const inFlight = new Map<string, Promise<void>>();
const router = new ChannelRouter();

// Single dispatcher all channels share. Serializes per-thread so we never run
// two agent subprocesses for the same chat at once.
const onMessage = (threadId: string, text: string) => {
  const prev = inFlight.get(threadId) ?? Promise.resolve();
  const next = prev.then(() => handleMessage(db, router, threadId, text)).catch((err) => {
    console.error(`[agent] ${threadId}`, err);
  });
  inFlight.set(
    threadId,
    next.finally(() => {
      if (inFlight.get(threadId) === next) inFlight.delete(threadId);
    }),
  );
};

// Telegram
if (process.env.TELEGRAM_BOT_TOKEN) {
  const ch = createTelegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN, onMessage });
  router.register('telegram', ch);
  console.log('[nothingclaw] telegram enabled');
}

// Slack (lazy-loaded so non-Slack users don't pay the import cost)
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  const { createSlackChannel } = await import('./channels/slack.ts');
  const ch = await createSlackChannel({
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    onMessage,
  });
  router.register('slack', ch);
  console.log('[nothingclaw] slack enabled');
}

// WhatsApp (Baileys, QR-scan auth on first run)
if (process.env.NOTHINGCLAW_WHATSAPP === '1') {
  const { createWhatsappChannel } = await import('./channels/whatsapp.ts');
  const ch = await createWhatsappChannel({ onMessage });
  router.register('whatsapp', ch);
  console.log('[nothingclaw] whatsapp enabled');
}

if (router.list().length === 0) {
  console.error('No channels enabled. Run `bun run setup` to wire one up.');
  process.exit(1);
}

// Outbox drain — delivers messages the agent queued via mcp send_message / speak.
// `draining` guard prevents concurrent ticks from racing on the same row:
// without it, a slow send (e.g. while WhatsApp is reconnecting) gets re-fetched
// by the next tick and delivered multiple times.
let draining = false;
const drainTimer = setInterval(async () => {
  if (draining) return;
  draining = true;
  try {
    const pending = takePendingOutbox(db, 20);
    for (const row of pending) {
      try {
        await router.send(row.thread_id, row.text, row.audio_path ? { audioPath: row.audio_path } : undefined);
        markOutboxDelivered(db, row.id);
      } catch (err) {
        console.error(`[outbox] deliver ${row.id}`, err);
      }
    }
  } finally {
    draining = false;
  }
}, 500);

const shutdown = () => {
  clearInterval(drainTimer);
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

printRunningBanner(router.list(), process.env.AGENT_PROVIDER ?? 'gemini');
