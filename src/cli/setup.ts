// Interactive setup: pick provider, install CLI, trigger login, enable WhatsApp,
// write .env + data/config.json. Idempotent — re-running picks up current state
// as defaults.

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PROVIDERS } from '../providers/registry.ts';
import type { Provider, ProviderName } from '../providers/types.ts';
import { printBanner } from './branding.ts';
import { writeAtomic } from '../lib/atomic.ts';
import { loadConfig, writeConfig } from '../lib/config.ts';

const rl = createInterface({ input: stdin, output: stdout });

const bold  = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok    = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const info  = (s: string) => console.log(`  ${s}`);
const warn  = (s: string) => console.log(`\x1b[33m!\x1b[0m ${s}`);

async function ask(prompt: string, def?: string): Promise<string> {
  const suffix = def !== undefined ? ` [${def}]` : '';
  const ans = (await rl.question(`${prompt}${suffix}: `)).trim();
  return ans || def || '';
}

async function yesNo(prompt: string, def: boolean): Promise<boolean> {
  const dStr = def ? 'Y/n' : 'y/N';
  while (true) {
    const raw = (await rl.question(`${prompt} (${dStr}): `)).trim().toLowerCase();
    if (!raw) return def;
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
    warn('Please answer y or n.');
  }
}

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function run(bin: string, args: string[], opts: { stdio?: 'inherit' | 'pipe' } = {}): number {
  const r = spawnSync(bin, args, { stdio: opts.stdio ?? 'inherit' });
  return r.status ?? 1;
}

function envHas(key: string): boolean {
  if (!existsSync('.env')) return false;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*1\\s*$`, 'm');
  return re.test(readFileSync('.env', 'utf-8'));
}

// Phone → digits only (country code + number, no + / spaces / dashes), the
// shape WhatsApp uses in a @s.whatsapp.net JID.
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

// A short, unambiguous pairing code the owner sends as a WhatsApp message to
// complete pairing. Alphabet omits 0/O/1/I/L to avoid typos on a phone.
function genPairCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[bytes[i] % alphabet.length];
  return `link-${s}`;
}

async function askBotName(current: string): Promise<string> {
  bold('1. Bot name');
  info('The persona name your bot uses when chatting.');
  const name = await ask('  Bot name', current);
  return name || current;
}

async function askOwnerName(current: string): Promise<string> {
  bold('2. Your name');
  info('What should the bot call you? It uses this to address you.');
  return await ask('  Your name', current || undefined);
}

async function pickProviderInteractive(current: ProviderName): Promise<Provider> {
  bold('3. Agent provider');
  info(`Current: ${current}`);
  info('  [g] Gemini CLI  (Google,    npm @google/gemini-cli)');
  info('  [c] Claude Code (Anthropic, npm @anthropic-ai/claude-code)');
  const defLetter = current === 'claude' ? 'c' : 'g';
  while (true) {
    const c = (await ask('  Choice (g/c)', defLetter)).toLowerCase();
    if (c === 'g' || c === 'gemini') return PROVIDERS.gemini;
    if (c === 'c' || c === 'claude') return PROVIDERS.claude;
    warn('Please enter "g" or "c".');
  }
}

async function ensureProviderInstalled(p: Provider): Promise<void> {
  bold(`4. Install ${p.bin}`);
  const found = which(p.bin);
  if (found) {
    ok(`Found: ${found}`);
    return;
  }
  info(`Installing ${p.npmPackage} via npm -g …`);
  if (run('npm', ['install', '-g', p.npmPackage]) !== 0) {
    throw new Error(
      `Failed to install ${p.npmPackage}. Re-run with sudo, or fix your npm prefix ` +
      `(npm config set prefix ~/.npm-global) and add ~/.npm-global/bin to PATH.`,
    );
  }
  if (!which(p.bin)) {
    throw new Error(`${p.bin} installed but not on PATH. Open a new shell and re-run setup.`);
  }
  ok(`Installed ${p.bin}`);
}

function resetTerminal(): void {
  // setRawMode throws on non-TTY stdin; we guard with isTTY but Bun's stdin
  // can transition mid-call. Swallow because raw-mode failure here is
  // strictly cosmetic — the `stty sane` call below corrects most cases.
  // eslint-disable-next-line no-catch-all/no-catch-all
  try {
    if (stdin.isTTY) stdin.setRawMode(false);
  } catch {
    /* non-TTY or already cooked */
  }
  spawnSync('stty', ['sane'], { stdio: 'ignore' });
  stdout.write('\x1b[2J\x1b[H');
}

async function triggerLogin(p: Provider): Promise<void> {
  bold(`5. Log in to ${p.name}`);

  if (p.isAuthed()) {
    ok('Already logged in.');
    return;
  }

  info(`Launching ${p.bin}. Your browser will open for OAuth — complete it there.`);
  info("You don't need to do anything in this terminal. Setup resumes automatically when login completes.");
  await new Promise((r) => setTimeout(r, 800));

  const child = spawn(p.bin, [], { stdio: 'inherit' });

  await new Promise<void>((resolveP) => {
    let killed = false;
    const start = Date.now();
    const TIMEOUT_MS = 5 * 60_000;

    const poll = setInterval(() => {
      if (killed) return;
      if (p.isAuthed()) {
        killed = true;
        clearInterval(poll);
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2000);
      } else if (Date.now() - start > TIMEOUT_MS) {
        killed = true;
        clearInterval(poll);
        child.kill('SIGTERM');
      }
    }, 500);

    child.on('close', () => {
      clearInterval(poll);
      resetTerminal();
      resolveP();
    });
  });

  if (p.isAuthed()) {
    ok(`Logged in to ${p.name}.`);
  } else {
    warn("Login did not complete. You can re-run setup later (it's idempotent).");
  }
}

interface ChannelChoices {
  whatsappEnabled: boolean;
  ownerPhone: string;
  voiceEnabled: boolean;
}

async function askChannels(currentVoice: boolean, currentPhone: string): Promise<ChannelChoices> {
  bold('6. WhatsApp + voice');

  const whatsappAlready = envHas('NOTHINGCLAW_WHATSAPP');
  info('Connects via Baileys (unofficial WhatsApp library) — QR scan from your phone.');
  if (whatsappAlready) info('  Currently enabled in .env.');
  warn('Unofficial: not endorsed by Meta. Use at your own risk.');
  const whatsappEnabled = await yesNo('  Enable WhatsApp?', true);

  let ownerPhone = '';
  if (whatsappEnabled) {
    if (!whatsappAlready) {
      info('  On first `bun run start`, a QR code prints in the terminal.');
      info('  WhatsApp → Settings → Linked devices → Link a device → scan it.');
    }
    info('');
    info('  Your WhatsApp number — include country code, e.g. +94771234567.');
    info('  Only this number will be allowed to talk to the bot.');
    while (true) {
      const raw = await ask('  Your number', currentPhone || undefined);
      ownerPhone = normalizePhone(raw);
      if (!ownerPhone) {
        if (await yesNo('  No number given — accept messages from ANY sender?', false)) break;
        continue;
      }
      if (ownerPhone.length < 7 || ownerPhone.length > 15) {
        warn('  That doesn\'t look like a full international number (7–15 digits). Try again.');
        continue;
      }
      break;
    }
  }

  info('');
  info('Voice transcription (local Whisper, ~600MB one-time install).');
  if (currentVoice) info('  Currently enabled in config.');
  const voiceDefault = currentVoice || whatsappEnabled;
  let voiceEnabled = await yesNo('  Enable voice?', voiceDefault);

  if (voiceEnabled) {
    if (existsSync('tools/voice-env')) {
      ok('  Voice venv already present at tools/voice-env — skipping install.');
    } else {
      // setup-voice.sh self-installs a supported Python (3.11/3.12) + ffmpeg
      // for the OS if missing, then builds the venv and caches models.
      info('  Running tools/setup-voice.sh (installs Python/ffmpeg if needed + models)…');
      const r = spawnSync('bash', ['tools/setup-voice.sh'], { stdio: 'inherit' });
      if (r.status !== 0) {
        warn('  Voice install failed. Retry later with `bun run voice install`.');
        voiceEnabled = false;
      } else {
        ok('  Voice installed.');
        const s = spawnSync('bun', ['run', 'src/cli/index.ts', 'voice', 'start'], { stdio: 'inherit' });
        if (s.status !== 0) warn('  Could not start sidecar automatically; run `bun run voice start` later.');
      }
    }
  }

  return { whatsappEnabled, ownerPhone, voiceEnabled };
}

// Seed MEMORY.md with an owner block so BOTH providers (gemini reads MEMORY.md,
// claude gets it via persona too) know who they're talking to from turn one.
// Idempotent: only writes if the file lacks an "## Owner" section.
function seedMemory(ownerName: string, ownerPhone: string): void {
  if (!ownerName && !ownerPhone) return;
  if (!existsSync('MEMORY.md')) return;
  const body = readFileSync('MEMORY.md', 'utf-8');
  if (/^##\s+Owner\b/m.test(body)) return;
  const lines = ['', '## Owner', ''];
  if (ownerName) lines.push(`- Name: ${ownerName}`);
  if (ownerPhone) lines.push(`- WhatsApp: +${ownerPhone}`);
  lines.push('');
  writeAtomic('MEMORY.md', body.replace(/\n+$/, '') + '\n' + lines.join('\n'));
}

// .env holds secrets + channel-enable flags. Non-secret runtime config
// (bot_name, allowed_jids, timezone, etc.) lives in data/config.json.
//
// We manage exactly: AGENT_PROVIDER, NOTHINGCLAW_WHATSAPP.
// Telegram/Slack tokens hand-added by power users are left untouched.
function writeEnv(provider: ProviderName, whatsappEnabled: boolean): void {
  const managed = new Set(['AGENT_PROVIDER', 'NOTHINGCLAW_WHATSAPP']);
  const existing = existsSync('.env') ? readFileSync('.env', 'utf-8') : '';
  const lines = existing.split('\n').filter((l) => {
    if (!l.trim() || l.trim().startsWith('#')) return true;
    const key = l.split('=')[0].trim();
    return !managed.has(key);
  });
  lines.push(`AGENT_PROVIDER=${provider}`);
  if (whatsappEnabled) lines.push('NOTHINGCLAW_WHATSAPP=1');
  const out = lines.join('\n').replace(/\n+$/, '') + '\n';
  writeAtomic('.env', out);
}

function summarize(botName: string, ownerName: string, provider: ProviderName, ch: ChannelChoices): void {
  ok(`bot name:  ${botName}`);
  if (ownerName) ok(`your name: ${ownerName}`);
  ok(`provider:  ${provider}`);
  ok(`whatsapp:  ${ch.whatsappEnabled ? 'on' : 'off'}`);
  if (ch.whatsappEnabled) {
    ok(`allowed:   ${ch.ownerPhone ? `+${ch.ownerPhone} (+ chat captured at pairing)` : 'any sender'}`);
  }
  ok(`voice:     ${ch.voiceEnabled ? 'on' : 'off'}`);
  if (!ch.whatsappEnabled) {
    warn('No channels enabled. The bot will refuse to start until you wire one up.');
  }
}

async function main(): Promise<void> {
  printBanner('interactive setup');

  if (!which('npm')) {
    throw new Error('npm not found on PATH. Install Node.js (https://nodejs.org) and re-run setup.');
  }

  const current = loadConfig();

  const botName = await askBotName(current.bot_name);
  const ownerName = await askOwnerName(current.owner_name);
  const provider = await pickProviderInteractive(current.agent_provider);
  await ensureProviderInstalled(provider);
  await triggerLogin(provider);
  const channels = await askChannels(current.voice_enabled, current.owner_phone);

  // Allow-list + pairing. A fresh number arms code-based pairing: the owner
  // sends a one-time code as a WhatsApp message and the bot captures that
  // sender's real JID (possibly an @lid). Re-running with the SAME number
  // preserves an already-paired JID and its pairing state/code.
  let allowedJids: string[] = [];
  let pairOwner = false;
  let pairCode = '';
  if (channels.whatsappEnabled && channels.ownerPhone) {
    const phoneJid = `${channels.ownerPhone}@s.whatsapp.net`;
    if (channels.ownerPhone !== current.owner_phone) {
      allowedJids = [phoneJid];
      pairOwner = true;
      pairCode = genPairCode();
    } else {
      allowedJids = current.allowed_jids.includes(phoneJid)
        ? [...current.allowed_jids]
        : [phoneJid, ...current.allowed_jids];
      pairOwner = current.whatsapp_pair_owner;
      pairCode = current.whatsapp_pair_code;
      if (pairOwner && !pairCode) pairCode = genPairCode(); // arm if missing
    }
  } else if (channels.ownerPhone) {
    allowedJids = [`${channels.ownerPhone}@s.whatsapp.net`];
  }

  bold('7. Writing config');
  try {
    writeEnv(provider.name, channels.whatsappEnabled);
    writeConfig({
      bot_name: botName,
      owner_name: ownerName,
      owner_phone: channels.ownerPhone,
      agent_provider: provider.name,
      voice_enabled: channels.voiceEnabled,
      allowed_jids: allowedJids,
      whatsapp_pair_owner: pairOwner,
      whatsapp_pair_code: pairCode,
    });
    seedMemory(ownerName, channels.ownerPhone);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist config: ${msg}`);
  }
  ok('.env (secrets) and data/config.json (runtime config) written.');
  summarize(botName, ownerName, provider.name, channels);

  if (pairOwner && pairCode) {
    bold('Pair your WhatsApp');
    info('1. Start the bot:  bun run start');
    info('2. Scan the QR shown in the terminal to link WhatsApp.');
    info('3. From your phone, send this exact message to the bot:');
    console.log(`\n      \x1b[1m${pairCode}\x1b[0m\n`);
    info('   The bot stays silent until it sees that code, then locks to your chat.');
  }

  bold('Done.');
  info('Start the bot:  bun run start');
  rl.close();
}

main().catch((e) => {
  console.error('\n\x1b[31m✗\x1b[0m', e instanceof Error ? e.message : e);
  rl.close();
  process.exit(1);
});
