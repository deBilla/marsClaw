// Interactive setup: pick provider, install CLI, trigger login, enable WhatsApp,
// write .env + data/config.json. Idempotent — re-running picks up current state
// as defaults.

import { existsSync, readFileSync } from 'node:fs';
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

async function askBotName(current: string): Promise<string> {
  bold('1. Bot name');
  info('The persona name your bot uses when chatting.');
  const name = await ask('  Bot name', current);
  return name || current;
}

async function pickProviderInteractive(current: ProviderName): Promise<Provider> {
  bold('2. Agent provider');
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
  bold(`3. Install ${p.bin}`);
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
  bold(`4. Log in to ${p.name}`);

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
  voiceEnabled: boolean;
}

async function askChannels(currentVoice: boolean): Promise<ChannelChoices> {
  bold('5. WhatsApp + voice');

  const whatsappAlready = envHas('NOTHINGCLAW_WHATSAPP');
  info('Connects via Baileys (unofficial WhatsApp library) — QR scan from your phone.');
  if (whatsappAlready) info('  Currently enabled in .env.');
  warn('Unofficial: not endorsed by Meta. Use at your own risk.');
  const whatsappEnabled = await yesNo('  Enable WhatsApp?', true);
  if (whatsappEnabled && !whatsappAlready) {
    info('  On first `bun run start`, a QR code prints in the terminal.');
    info('  WhatsApp → Settings → Linked devices → Link a device → scan it.');
  }

  info('');
  info('Voice transcription (local Whisper, ~600MB one-time install).');
  if (currentVoice) info('  Currently enabled in config.');
  const voiceDefault = currentVoice || whatsappEnabled;
  const voiceEnabled = await yesNo('  Enable voice?', voiceDefault);

  const venvExists = existsSync('tools/voice-env');
  if (voiceEnabled && !venvExists) {
    info('  Installing — running tools/setup-voice.sh (Python venv + model download).');
    const r = spawnSync('bash', ['tools/setup-voice.sh'], { stdio: 'inherit' });
    if (r.status !== 0) {
      warn('  Voice install failed. Retry later with `bun run voice install`.');
    } else {
      ok('  Voice installed.');
      const s = spawnSync('bun', ['run', 'src/cli/index.ts', 'voice', 'start'], { stdio: 'inherit' });
      if (s.status !== 0) warn('  Could not start sidecar automatically; run `bun run voice start` later.');
    }
  } else if (voiceEnabled && venvExists) {
    ok('  Voice venv already present at tools/voice-env — skipping install.');
  }

  return { whatsappEnabled, voiceEnabled };
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

function summarize(botName: string, provider: ProviderName, ch: ChannelChoices): void {
  ok(`name:      ${botName}`);
  ok(`provider:  ${provider}`);
  ok(`whatsapp:  ${ch.whatsappEnabled ? 'on' : 'off'}`);
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
  const provider = await pickProviderInteractive(current.agent_provider);
  await ensureProviderInstalled(provider);
  await triggerLogin(provider);
  const channels = await askChannels(current.voice_enabled);

  bold('6. Writing .env and data/config.json');
  try {
    writeEnv(provider.name, channels.whatsappEnabled);
    writeConfig({
      bot_name: botName,
      agent_provider: provider.name,
      voice_enabled: channels.voiceEnabled,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to persist config: ${msg}`);
  }
  ok('.env (secrets) and data/config.json (runtime config) written.');
  summarize(botName, provider.name, channels);

  bold('Done.');
  info('Start the bot:  bun run start');
  rl.close();
}

main().catch((e) => {
  console.error('\n\x1b[31m✗\x1b[0m', e instanceof Error ? e.message : e);
  rl.close();
  process.exit(1);
});
