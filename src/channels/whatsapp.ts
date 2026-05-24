// WhatsApp adapter via Baileys (unofficial, QR-scan auth).
//
// First run: prints a QR code to terminal. Scan it with WhatsApp on your phone
// (Linked devices → Link a device). Auth state is saved to ./data/whatsapp-auth
// for subsequent runs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
  type WAMessage,
  type WAMessageContent,
  type WASocket,
} from 'baileys';
import type { Boom } from '@hapi/boom';
import type { Channel, ChannelInit } from './types.ts';

const PREFIX = 'whatsapp:';
const AUTH_DIR = process.env.NOTHINGCLAW_WHATSAPP_AUTH ?? 'data/whatsapp-auth';
const MEDIA_DIR = process.env.NOTHINGCLAW_WHATSAPP_MEDIA ?? 'data/whatsapp-media';
const VERBOSE = process.env.NOTHINGCLAW_WHATSAPP_VERBOSE === '1';

const logger = pino({ level: VERBOSE ? 'info' : 'silent' });

async function tryDownloadImage(msg: WAMessage): Promise<string | null> {
  if (!msg.message?.imageMessage) return null;
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    mkdirSync(MEDIA_DIR, { recursive: true });
    const mime = msg.message.imageMessage.mimetype ?? 'image/jpeg';
    const ext = (mime.split('/').pop() ?? 'jpg').split(';')[0];
    const id = (msg.key.id ?? `${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '_');
    const filePath = resolve(MEDIA_DIR, `${id}.${ext}`);
    writeFileSync(filePath, buffer as Buffer);
    return filePath;
  } catch (err) {
    console.error('[whatsapp] image download failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

function extractText(m: WAMessageContent | null | undefined): string {
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.ephemeralMessage?.message?.conversation ||
    m.ephemeralMessage?.message?.extendedTextMessage?.text ||
    m.viewOnceMessage?.message?.conversation ||
    m.viewOnceMessage?.message?.extendedTextMessage?.text ||
    ''
  );
}

export async function createWhatsappChannel(opts: ChannelInit): Promise<Channel> {
  mkdirSync(AUTH_DIR, { recursive: true });
  let sock: WASocket = await connect(opts);
  let consecutiveFailures = 0;

  async function connect(opts: ChannelInit): Promise<WASocket> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const s = makeWASocket({ auth: state, logger });

    s.ev.on('creds.update', saveCreds);

    s.ev.on('connection.update', (u) => {
      if (u.qr) {
        console.log('\n[whatsapp] scan this QR with your phone (Settings → Linked devices → Link a device):\n');
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === 'open') {
        consecutiveFailures = 0;
        console.log('[whatsapp] connected');
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        consecutiveFailures++;

        if (loggedOut) {
          console.log('[whatsapp] logged out — delete data/whatsapp-auth/ and re-run to re-link');
          return;
        }

        if (consecutiveFailures >= 5) {
          console.error('[whatsapp] giving up after 5 failed connection attempts.');
          console.error('  - too many linked devices on your account (max 4)');
          console.error('  - WhatsApp blocked the link from this IP / region');
          console.error(`  - last status code: ${code}`);
          return;
        }

        console.log(`[whatsapp] disconnected (code=${code}, reconnecting #${consecutiveFailures})`);
        setTimeout(async () => {
          sock = await connect(opts);
        }, 2000);
      }
    });

    s.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = live new message. 'append' = history sync after pairing —
      // do NOT auto-reply to those, they're things the user already sent/received.
      if (type !== 'notify') {
        if (VERBOSE) console.log(`[whatsapp] ignored ${messages.length} ${type} message(s)`);
        return;
      }
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.key.remoteJid) continue;
        // skip groups by default — only DMs (1:1 chats end in @s.whatsapp.net)
        if (msg.key.remoteJid.endsWith('@g.us')) continue;
        // skip status broadcasts
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const baseText = extractText(msg.message);
        const imagePath = await tryDownloadImage(msg);

        if (!baseText && !imagePath) {
          const kind = msg.message ? Object.keys(msg.message)[0] : 'empty';
          console.log(`[whatsapp] skipped non-text (${kind}) from ${msg.key.remoteJid}`);
          continue;
        }

        // Build a single text payload. For images, embed the absolute path with
        // gemini/claude's @<path> file-include syntax so the agent can see them.
        const fullText = imagePath
          ? baseText
            ? `${baseText}\n\n[user attached an image: @${imagePath}]`
            : `[user attached an image: @${imagePath}]`
          : baseText;

        const threadId = `${PREFIX}${msg.key.remoteJid}`;
        const preview = fullText.slice(0, 80);
        console.log(`[whatsapp] in  ${msg.key.remoteJid}: ${preview}${fullText.length > 80 ? '…' : ''}`);
        try {
          await opts.onMessage(threadId, fullText);
        } catch (err) {
          console.error('[whatsapp] handler error', err);
        }
      }
    });

    return s;
  }

  return {
    async send(threadId: string, text: string) {
      if (!threadId.startsWith(PREFIX)) {
        throw new Error(`whatsapp channel cannot send to thread ${threadId}`);
      }
      const jid = threadId.slice(PREFIX.length);
      console.log(`[whatsapp] out ${jid}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`);
      await sock.sendMessage(jid, { text });
    },
  };
}
