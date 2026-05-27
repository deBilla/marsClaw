import TelegramBot from 'node-telegram-bot-api';
import { createReadStream } from 'node:fs';
import { loadConfig } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import type { Channel, ChannelInit, SendOpts } from './types.ts';

export interface TelegramOptions extends ChannelInit {
  token: string;
}

const PREFIX = 'telegram:';
const TG_MAX = 4000;

export function createTelegramChannel(opts: TelegramOptions): Channel {
  const bot = new TelegramBot(opts.token, { polling: true });

  // Sender allow-list. Non-empty = reject anyone not listed. Empty = accept
  // all, warning once per new chat id so the owner can lock it down.
  const allowed = new Set(loadConfig().allowed_telegram_chats.map((c) => String(c).trim()).filter(Boolean));
  const warnedOpen = new Set<string>();

  bot.on('message', async (msg) => {
    if (!msg.text) return;
    const chatId = String(msg.chat.id);
    if (allowed.size > 0) {
      if (!allowed.has(chatId)) {
        log.warn('telegram rejected — sender not in allow-list', {
          chatId,
          hint: 'add this chat id to allowed_telegram_chats in data/config.json to grant access',
        });
        return;
      }
    } else if (!warnedOpen.has(chatId)) {
      warnedOpen.add(chatId);
      log.warn('telegram allow-list disabled — accepting from any sender', {
        chatId,
        hint: `set allowed_telegram_chats to ["${chatId}"] in data/config.json to restrict to yourself`,
      });
    }
    const threadId = `${PREFIX}${msg.chat.id}`;
    try {
      await opts.onMessage(threadId, msg.text);
    } catch (err) {
      log.error('telegram handler error', { err });
    }
  });

  bot.on('polling_error', (err) => log.error('telegram polling error', { err }));

  return {
    async send(threadId: string, text: string, opts?: SendOpts) {
      if (!threadId.startsWith(PREFIX)) {
        throw new Error(`telegram channel cannot send to thread ${threadId}`);
      }
      const chatId = threadId.slice(PREFIX.length);
      if (opts?.audioPath) {
        await bot.sendVoice(chatId, createReadStream(opts.audioPath));
        return;
      }
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
