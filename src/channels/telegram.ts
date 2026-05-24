import TelegramBot from 'node-telegram-bot-api';
import type { Channel, ChannelInit } from './types.ts';

export interface TelegramOptions extends ChannelInit {
  token: string;
}

const PREFIX = 'telegram:';
const TG_MAX = 4000;

export function createTelegramChannel(opts: TelegramOptions): Channel {
  const bot = new TelegramBot(opts.token, { polling: true });

  bot.on('message', async (msg) => {
    if (!msg.text) return;
    const threadId = `${PREFIX}${msg.chat.id}`;
    try {
      await opts.onMessage(threadId, msg.text);
    } catch (err) {
      console.error('[telegram] handler error', err);
    }
  });

  bot.on('polling_error', (err) => console.error('[telegram] polling', err));

  return {
    async send(threadId: string, text: string) {
      if (!threadId.startsWith(PREFIX)) {
        throw new Error(`telegram channel cannot send to thread ${threadId}`);
      }
      const chatId = threadId.slice(PREFIX.length);
      for (const part of chunk(text, TG_MAX)) {
        await bot.sendMessage(chatId, part);
      }
    },
  };
}

function chunk(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}
