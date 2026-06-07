// Slack adapter — Bolt with Socket Mode (no public webhook needed).
//
// Requires a Slack app with:
//   - Socket Mode enabled
//   - App-level token (xapp-…) with scope: connections:write
//   - Bot token (xoxb-…) with scopes: chat:write, im:history, im:read, im:write,
//     app_mentions:read (for channel mentions, optional)
//   - Event subscriptions: message.im (DMs), app_mention (channels)

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { App, LogLevel } from '@slack/bolt';
import { loadConfig } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { RateLimiter } from '../lib/rate-limit.ts';
import { isSafeAttachmentName } from '../lib/attachment-safety.ts';
import type { Channel, ChannelInit, SendOpts } from './types.ts';

export interface SlackOptions extends ChannelInit {
  botToken: string;
  appToken: string;
}

const PREFIX = 'slack:';
// Under data/shared so the same absolute path is bind-mounted into the agent
// container (runtime='container') and inbound `@/abs/path` markers resolve there.
const MEDIA_DIR = process.env.MARSCLAW_SLACK_MEDIA ?? 'data/shared/slack-media';
// Hard cap on a single inbound attachment, mirroring the WhatsApp adapter: an
// allow-listed but hostile sender shouldn't be able to drive a disk-fill.
// Files over this are dropped before write and treated as a failed download.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Shape of a Slack file object as it appears on a `file_share` message event.
// All fields are optional because Slack omits some for certain file types.
interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
  size?: number;
}

export async function createSlackChannel(opts: SlackOptions): Promise<Channel> {
  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  // Sender allow-list. Non-empty = reject any Slack user not listed. Empty =
  // accept all, warning once per new user id so the owner can lock it down.
  const config = loadConfig();
  const allowed = new Set(config.allowed_slack_users.map((u) => String(u).trim()).filter(Boolean));
  const warnedOpen = new Set<string>();
  function senderAllowed(user: string | undefined): boolean {
    const uid = String(user ?? '');
    if (allowed.size === 0) {
      if (uid && !warnedOpen.has(uid)) {
        warnedOpen.add(uid);
        log.warn('slack allow-list disabled — accepting from any user', {
          user: uid,
          hint: `set allowed_slack_users to ["${uid}"] in data/config.json to restrict`,
        });
      }
      return true;
    }
    if (allowed.has(uid)) return true;
    log.warn('slack rejected — sender not in allow-list', {
      user: uid,
      hint: 'add this user id to allowed_slack_users in data/config.json to grant access',
    });
    return false;
  }
  // Per-sender rate limit. A Slack workspace member who knows the bot is up
  // can otherwise drive arbitrary agent turns; Socket Mode delivers everything
  // they DM. Same defaults as the other channels (10/min, 60/hr).
  const limiter =
    config.rate_limit_per_minute > 0 || config.rate_limit_per_hour > 0
      ? new RateLimiter({
          perMinute: config.rate_limit_per_minute || Infinity,
          perHour: config.rate_limit_per_hour || Infinity,
        })
      : null;
  function rateOk(key: string): boolean {
    if (!limiter) return true;
    const v = limiter.check(key);
    if (!v.ok) {
      log.warn('slack rate-limited', { key, reason: v.reason, retryAfterMs: v.retryAfterMs });
      return false;
    }
    return true;
  }

  // Download a Slack-hosted file to MEDIA_DIR and return its local path. Slack
  // files live behind an authenticated URL — a plain GET returns an HTML login
  // page, so we must send the bot token (requires the `files:read` scope).
  async function downloadSlackFile(
    file: SlackFile,
  ): Promise<{ path: string; fileName: string; isImage: boolean } | null> {
    const url = file.url_private_download ?? file.url_private;
    if (!url) return null;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${opts.botToken}` } });
      if (!res.ok) {
        log.warn('slack file download failed', { status: res.status, name: file.name });
        return null;
      }
      // Missing `files:read` makes Slack serve a 200 HTML login page instead of
      // the bytes — detect that so we never hand the agent a junk "file".
      const ctype = res.headers.get('content-type') ?? '';
      if (ctype.includes('text/html') && !(file.mimetype ?? '').includes('html')) {
        log.warn('slack file download returned HTML — bot token likely lacks the files:read scope', {
          name: file.name,
          hint: 'add files:read to the Slack app and reinstall (marsclaw slack connect)',
        });
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FILE_BYTES) {
        log.warn('slack file exceeds size cap — dropping', { name: file.name, bytes: buf.length, cap: MAX_FILE_BYTES });
        return null;
      }
      mkdirSync(MEDIA_DIR, { recursive: true });
      // Sanitise the inbound filename: clear traversal first (isSafeAttachmentName),
      // then strip non-alphanum for cosmetic safety — same order as WhatsApp.
      const rawName = file.name ?? '';
      const safeName = isSafeAttachmentName(rawName) ? rawName : '';
      if (rawName && !safeName) log.warn('slack file had unsafe filename — using fallback', { rawName });
      const sanitised = safeName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const mime = file.mimetype ?? 'application/octet-stream';
      const mimeExt = (mime.split('/').pop() ?? 'bin').split(';')[0];
      const ext = sanitised.includes('.') ? sanitised.split('.').pop()! : file.filetype || mimeExt;
      const id = (file.id ?? `${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '_');
      const filePath = resolve(MEDIA_DIR, `${id}.${ext}`);
      writeFileSync(filePath, buf);
      return { path: filePath, fileName: sanitised || `file.${ext}`, isImage: mime.startsWith('image/') };
    } catch (err) {
      log.warn('slack file download error', { name: file.name, err });
      return null;
    }
  }

  app.message(async ({ message }) => {
    const m = message as {
      subtype?: string;
      text?: string;
      channel?: string;
      user?: string;
      bot_id?: string;
      files?: SlackFile[];
    };
    // Let through plain messages (no subtype) and file uploads (subtype
    // "file_share"). Everything else — edits, joins, topic changes, bot-sent —
    // is noise. Previously ALL subtypes were dropped, which silently swallowed
    // every file the user shared.
    if (m.subtype && m.subtype !== 'file_share') return;
    if (m.bot_id) return;
    if (!m.channel) return;
    if (!senderAllowed(m.user)) return;
    if (!rateOk(m.user ?? m.channel)) return;

    // Build the agent-facing payload: caption text plus an @path marker per
    // file, matching the WhatsApp adapter's convention so the agent treats
    // Slack and WhatsApp attachments identically.
    const parts: string[] = [];
    const caption = (m.text ?? '').trim();
    if (caption) parts.push(caption);
    for (const file of m.files ?? []) {
      const dl = await downloadSlackFile(file);
      if (!dl) {
        parts.push(`[user attached a file "${file.name ?? 'unknown'}" but it could not be downloaded]`);
        continue;
      }
      parts.push(
        dl.isImage
          ? `[user attached an image: @${dl.path}]`
          : `[user attached a document "${dl.fileName}": @${dl.path}]`,
      );
    }
    const fullText = parts.join('\n\n');
    if (!fullText) return; // empty event with nothing usable

    const threadId = `${PREFIX}${m.channel}`;
    log.info('slack in', { channel: m.channel, preview: fullText.slice(0, 80) });
    try {
      await opts.onMessage(threadId, fullText);
    } catch (err) {
      log.error('slack handler error', { err });
    }
  });

  app.event('app_mention', async ({ event }) => {
    const e = event as { text?: string; channel?: string; user?: string };
    if (!e.text || !e.channel) return;
    if (!senderAllowed(e.user)) return;
    if (!rateOk(e.user ?? e.channel)) return;
    const threadId = `${PREFIX}${e.channel}`;
    try {
      await opts.onMessage(threadId, e.text);
    } catch (err) {
      log.error('slack mention handler error', { err });
    }
  });

  app.error(async (err) => {
    log.error('slack error', { err });
  });

  await app.start();
  log.info('slack connected (socket mode)');

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
