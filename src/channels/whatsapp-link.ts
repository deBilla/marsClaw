// One-shot WhatsApp device-linking for the setup flow.
//
// The full channel adapter (createWhatsappChannel) wires message handling,
// rate limiting, pairing, etc. — too heavy for "just print a QR and wait until
// the phone links." This is the minimal version: open a socket, render the QR,
// resolve once the connection reaches 'open' (creds saved to AUTH_DIR), then
// close WITHOUT logging out so the saved credentials persist for `bun run start`.

import { mkdirSync } from 'node:fs';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';
import type { Boom } from '@hapi/boom';

const AUTH_DIR = process.env.NOTHINGCLAW_WHATSAPP_AUTH ?? 'data/whatsapp-auth';

export type LinkStatus = 'already-linked' | 'linked' | 'timeout' | 'failed';

export interface LinkResult {
  status: LinkStatus;
  detail?: string;
}

// Renders a QR (if WhatsApp isn't already linked) and resolves when the phone
// completes the link or the timeout elapses. Never throws — callers branch on
// `status` and fall back to the first-start QR if anything goes sideways.
export async function linkWhatsapp(opts: { timeoutMs?: number } = {}): Promise<LinkResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  if (state.creds.registered) return { status: 'already-linked' };

  const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });
  sock.ev.on('creds.update', saveCreds);

  return await new Promise<LinkResult>((resolve) => {
    let settled = false;
    const finish = (r: LinkResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close the socket but keep the freshly written creds — `sock.logout()`
      // would unlink the device, which is the opposite of what we want.
      try {
        sock.end(undefined);
      } catch (err) {
        void err;
      }
      resolve(r);
    };

    const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

    let printedQr = false;
    sock.ev.on('connection.update', (u) => {
      if (u.qr && !printedQr) {
        printedQr = true;
        console.log('\n  Scan this with WhatsApp → Settings → Linked devices → Link a device:\n');
        qrcode.generate(u.qr, { small: true });
      } else if (u.qr) {
        // Baileys refreshes the QR every ~20s; redraw so a slow scan still works.
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === 'open') {
        // Give a final creds.update a beat to flush before we tear down.
        setTimeout(() => finish({ status: 'linked' }), 1500);
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          finish({ status: 'failed', detail: 'logged out during linking' });
        }
        // Other close codes (restartRequired, timed out) just let the overall
        // timeout decide — we don't auto-reconnect in this one-shot path.
      }
    });
  });
}
