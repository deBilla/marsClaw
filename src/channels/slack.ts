// Slack adapter — Bolt with Socket Mode (no public webhook needed).
//
// Requires a Slack app with:
//   - Socket Mode enabled
//   - App-level token (xapp-…) with scope: connections:write
//   - Bot token (xoxb-…) with scopes: chat:write, im:history, im:read, im:write,
//     app_mentions:read (for channel mentions, optional)
//   - Event subscriptions: message.im (DMs), app_mention (channels)

import { App, LogLevel } from '@slack/bolt';
import type { Channel, ChannelInit, SendOpts } from './types.ts';

export interface SlackOptions extends ChannelInit {
  botToken: string;
  appToken: string;
}

const PREFIX = 'slack:';

export async function createSlackChannel(opts: SlackOptions): Promise<Channel> {
  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  app.message(async ({ message }) => {
    if ('subtype' in message && message.subtype) return; // edits, joins, bot-sent, etc.
    const m = message as { text?: string; channel?: string; user?: string; bot_id?: string };
    if (m.bot_id) return;
    if (!m.text || !m.channel) return;
    const threadId = `${PREFIX}${m.channel}`;
    try {
      await opts.onMessage(threadId, m.text);
    } catch (err) {
      console.error('[slack] handler error', err);
    }
  });

  app.event('app_mention', async ({ event }) => {
    const e = event as { text?: string; channel?: string };
    if (!e.text || !e.channel) return;
    const threadId = `${PREFIX}${e.channel}`;
    try {
      await opts.onMessage(threadId, e.text);
    } catch (err) {
      console.error('[slack] mention handler error', err);
    }
  });

  app.error(async (err) => {
    console.error('[slack] error', err);
  });

  await app.start();
  console.log('[slack] connected (socket mode)');

  return {
    async send(threadId: string, text: string, _opts?: SendOpts) {
      // _opts.audioPath is silently ignored — Slack file uploads aren't wired yet,
      // so voice replies fall back to the spoken text.
      if (!threadId.startsWith(PREFIX)) {
        throw new Error(`slack channel cannot send to thread ${threadId}`);
      }
      const channel = threadId.slice(PREFIX.length);
      await app.client.chat.postMessage({ channel, text });
    },
  };
}
