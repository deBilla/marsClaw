// Non-interactive setup writer for the macOS GUI. Reads a JSON payload (argv[3]
// or stdin) and persists it exactly like the interactive `setup` does: runtime
// config → data/config.json (merged with existing), secrets/flags → .env
// (managed keys only, others preserved).
//
//   echo '{"botName":"Mars","provider":"claude","telegramToken":"123:abc"}' \
//     | marsclaw apply-setup
//
// Mirrors the managed-key set in src/cli/setup.ts's writeEnv/writeConfig.

import { randomBytes } from 'node:crypto';
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
  runtime?: 'in-process' | 'container';
}

// Read a single key's value from HOME/.env, or null if absent.
function readEnvKey(key: string): string | null {
  const path = homePath('.env');
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0 && t.slice(0, eq).trim() === key) return t.slice(eq + 1).trim();
  }
  return null;
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
  ...(p.runtime !== undefined ? { runtime: p.runtime } : {}),
});

const envUpdates: Record<string, string | null> = {};
if (p.provider !== undefined) envUpdates.AGENT_PROVIDER = p.provider;
if (p.telegramToken !== undefined) envUpdates.TELEGRAM_BOT_TOKEN = p.telegramToken || null;
if (p.whatsappEnabled !== undefined) envUpdates.MARSCLAW_WHATSAPP = p.whatsappEnabled ? '1' : null;
// Container mode needs two host↔container secrets, minted once if absent (never
// overwritten): MARSCLAW_MCP_TOKEN (host MCP auth — it binds beyond loopback for
// the box) and LLM_PROXY_SESSION_TOKEN (the box's rotatable placeholder bearer,
// which the host proxy swaps for the real provider credential).
if (p.runtime === 'container') {
  if (!readEnvKey('MARSCLAW_MCP_TOKEN')) {
    envUpdates.MARSCLAW_MCP_TOKEN = `mcp-${randomBytes(24).toString('hex')}`;
  }
  if (!readEnvKey('LLM_PROXY_SESSION_TOKEN')) {
    envUpdates.LLM_PROXY_SESSION_TOKEN = `mc-${randomBytes(24).toString('hex')}`;
  }
}
if (Object.keys(envUpdates).length) setEnvKeys(envUpdates);

console.log('config written');
