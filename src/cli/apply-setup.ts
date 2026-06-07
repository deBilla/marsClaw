// Non-interactive setup writer for the macOS GUI. Reads a JSON payload (argv[3]
// or stdin) and persists it exactly like the interactive `setup` does: runtime
// config → data/config.json (merged with existing), secrets/flags → .env
// (managed keys only, others preserved).
//
//   echo '{"botName":"Mars","provider":"claude","telegramToken":"123:abc"}' \
//     | marsclaw apply-setup
//
// Mirrors the managed-key set in src/cli/setup.ts's writeEnv/writeConfig.

import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from '../lib/atomic.ts';
import { writeConfig } from '../lib/config.ts';
import { homePath } from '../lib/paths.ts';
import type { ProviderName } from '../providers/types.ts';

interface Payload {
  botName?: string;
  ownerName?: string;
  timezone?: string;
  location?: string;
  provider?: ProviderName;
  telegramToken?: string;
  whatsappEnabled?: boolean;
  ownerPhone?: string;
  voiceEnabled?: boolean;
}

// Replace the given managed keys in .env, preserving every other line
// (including comments and unmanaged keys). A null value drops the key.
function setEnvKeys(updates: Record<string, string | null>): void {
  const path = homePath('.env');
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const managed = new Set(Object.keys(updates));
  const kept = existing.split('\n').filter((l) => {
    if (!l.trim() || l.trim().startsWith('#')) return true;
    return !managed.has(l.split('=')[0].trim());
  });
  for (const [k, v] of Object.entries(updates)) {
    if (v !== null) kept.push(`${k}=${v}`);
  }
  writeAtomic(path, kept.join('\n').replace(/\n+$/, '') + '\n');
}

const raw = process.argv[3] ?? readFileSync(0, 'utf-8');
const p = JSON.parse(raw) as Payload;

writeConfig({
  ...(p.botName !== undefined ? { bot_name: p.botName } : {}),
  ...(p.ownerName !== undefined ? { owner_name: p.ownerName } : {}),
  ...(p.timezone !== undefined ? { timezone: p.timezone } : {}),
  ...(p.location !== undefined ? { location: p.location } : {}),
  ...(p.provider !== undefined ? { agent_provider: p.provider } : {}),
  ...(p.ownerPhone !== undefined ? { owner_phone: p.ownerPhone } : {}),
  ...(p.voiceEnabled !== undefined ? { voice_enabled: p.voiceEnabled } : {}),
});

const envUpdates: Record<string, string | null> = {};
if (p.provider !== undefined) envUpdates.AGENT_PROVIDER = p.provider;
if (p.telegramToken !== undefined) envUpdates.TELEGRAM_BOT_TOKEN = p.telegramToken || null;
if (p.whatsappEnabled !== undefined) envUpdates.MARSCLAW_WHATSAPP = p.whatsappEnabled ? '1' : null;
if (Object.keys(envUpdates).length) setEnvKeys(envUpdates);

console.log('config written');
