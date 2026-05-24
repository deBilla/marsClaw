// Interactive setup: pick provider, install CLI, trigger login, enable channels,
// write .env.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PROVIDERS } from '../providers/registry.ts';
import type { Provider, ProviderName } from '../providers/types.ts';
import { printBanner } from './branding.ts';

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

async function yesNo(prompt: string, def: 'y' | 'n' = 'n'): Promise<boolean> {
  while (true) {
    const a = (await ask(`${prompt} (y/n)`, def)).toLowerCase();
    if (a === 'y' || a === 'yes') return true;
    if (a === 'n' || a === 'no') return false;
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

interface ChannelChoices {
  telegramToken: string;
  slackBotToken: string;
  slackAppToken: string;
  whatsappEnabled: boolean;
}

async function pickProviderInteractive(): Promise<Provider> {
  bold('1. Pick an agent CLI');
  info('  [g] Gemini CLI  (Google,    npm @google/gemini-cli)');
  info('  [c] Claude Code (Anthropic, npm @anthropic-ai/claude-code)');
  while (true) {
    const c = (await ask('Choice (g/c)', 'g')).toLowerCase();
    if (c === 'g' || c === 'gemini') return PROVIDERS.gemini;
    if (c === 'c' || c === 'claude') return PROVIDERS.claude;
    warn('Please enter "g" or "c".');
  }
}

async function ensureProviderInstalled(p: Provider): Promise<void> {
  bold(`2. Ensure ${p.bin} is installed`);
  if (which(p.bin)) {
    ok(`Found: ${which(p.bin)}`);
    return;
  }
  info(`Installing ${p.npmPackage} via npm -g …`);
  if (run('npm', ['install', '-g', p.npmPackage]) !== 0) {
    throw new Error(`Failed to install ${p.npmPackage}. Re-run with sudo or fix npm prefix.`);
  }
  if (!which(p.bin)) {
    throw new Error(`${p.bin} installed but not on PATH. Open a new shell and re-run setup.`);
  }
  ok(`Installed ${p.bin}`);
}

function resetTerminal(): void {
  try {
    if (stdin.isTTY) stdin.setRawMode(false);
  } catch { /* ignore */ }
  // Restore sane terminal modes (echo on, canonical input, etc.) after the
  // child CLI's TUI exits — without this, the user's shell ends up garbled.
  spawnSync('stty', ['sane'], { stdio: 'ignore' });
  // Clear residue from the child's TUI and reset cursor.
  stdout.write('\x1b[2J\x1b[H');
}

async function triggerLogin(p: Provider): Promise<void> {
  bold(`3. Log in to ${p.name}`);

  if (p.isAuthed()) {
    ok(`Already logged in.`);
    return;
  }

  info(`Launching ${p.bin}. Your browser will open for OAuth — complete it there.`);
  info(`You don't need to do anything in this terminal. Setup resumes automatically when login completes.`);
  // Brief pause so the user reads the instructions before the TUI takes over.
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
    warn(`Login did not complete. You can re-run setup later (it's idempotent).`);
  }
}

async function askChannels(): Promise<ChannelChoices> {
  bold('4. Connect channels');
  info('You can enable any combination. Skip the ones you don\'t want now — add them later by editing .env.');

  // Telegram
  let telegramToken = '';
  info('\n  Telegram:');
  if (await yesNo('  Connect Telegram?', 'y')) {
    info('  Create a bot via @BotFather on Telegram, then paste the token below.');
    telegramToken = await ask('  Bot token');
  }

  // Slack
  let slackBotToken = '';
  let slackAppToken = '';
  info('\n  Slack:');
  if (await yesNo('  Connect Slack?', 'n')) {
    info('  Create a Slack app at https://api.slack.com/apps with:');
    info('    - Socket Mode enabled');
    info('    - App-level token (xapp-…) with scope: connections:write');
    info('    - Bot token scopes: chat:write, im:history, im:read, im:write, app_mentions:read');
    info('    - Event subscriptions: message.im, app_mention');
    slackBotToken = await ask('  Bot token (xoxb-…)');
    slackAppToken = await ask('  App-level token (xapp-…)');
  }

  // WhatsApp
  info('\n  WhatsApp:');
  info('  Uses Baileys (unofficial WhatsApp library) — connect via QR scan from your phone.');
  warn('  Unofficial: not endorsed by Meta. Use at your own risk.');
  const whatsappEnabled = await yesNo('  Connect WhatsApp?', 'n');
  if (whatsappEnabled) {
    info('  No token needed now. On first `bun run start`, you\'ll see a QR code in the terminal.');
    info('  In WhatsApp on your phone: Settings → Linked devices → Link a device → scan the QR.');
    info('  Auth state is saved to data/whatsapp-auth/ for subsequent runs.');
  }

  return { telegramToken, slackBotToken, slackAppToken, whatsappEnabled };
}

function writeEnv(provider: ProviderName, ch: ChannelChoices): void {
  const managed = new Set([
    'AGENT_PROVIDER',
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'NOTHINGCLAW_WHATSAPP',
  ]);
  const existing = existsSync('.env') ? readFileSync('.env', 'utf-8') : '';
  const lines = existing.split('\n').filter((l) => {
    if (!l.trim() || l.trim().startsWith('#')) return true;
    const key = l.split('=')[0].trim();
    return !managed.has(key);
  });
  lines.push(`AGENT_PROVIDER=${provider}`);
  if (ch.telegramToken) lines.push(`TELEGRAM_BOT_TOKEN=${ch.telegramToken}`);
  if (ch.slackBotToken) lines.push(`SLACK_BOT_TOKEN=${ch.slackBotToken}`);
  if (ch.slackAppToken) lines.push(`SLACK_APP_TOKEN=${ch.slackAppToken}`);
  if (ch.whatsappEnabled) lines.push('NOTHINGCLAW_WHATSAPP=1');
  const out = lines.join('\n').replace(/\n+$/, '') + '\n';
  writeFileSync('.env', out);
}

function summarize(provider: ProviderName, ch: ChannelChoices): void {
  const enabled: string[] = [];
  if (ch.telegramToken)  enabled.push('telegram');
  if (ch.slackBotToken && ch.slackAppToken) enabled.push('slack');
  if (ch.whatsappEnabled) enabled.push('whatsapp');
  ok(`provider:  ${provider}`);
  ok(`channels:  ${enabled.length ? enabled.join(', ') : 'none (will refuse to start until you add one)'}`);
  if (ch.slackBotToken && !ch.slackAppToken) warn('Slack bot token set but no app-level token — slack disabled until both are set.');
  if (ch.slackAppToken && !ch.slackBotToken) warn('Slack app-level token set but no bot token — slack disabled until both are set.');
}

async function main(): Promise<void> {
  printBanner('interactive setup');

  const provider = await pickProviderInteractive();
  await ensureProviderInstalled(provider);
  await triggerLogin(provider);
  const channels = await askChannels();

  bold('5. Writing .env');
  writeEnv(provider.name, channels);
  summarize(provider.name, channels);

  bold('Done.');
  info('Start the bot:  bun run start');
  rl.close();
}

main().catch((e) => {
  console.error('\n\x1b[31m✗\x1b[0m', e instanceof Error ? e.message : e);
  rl.close();
  process.exit(1);
});
