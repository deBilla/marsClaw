// marsClaw CLI — `container` subcommand. Manages the container runtime's
// credential + lifecycle helpers.
//
//   login   — mint a Claude OAuth token (interactive browser; log in as the
//             account you want the agent to use) and write it to .env as
//             CLAUDE_CODE_OAUTH_TOKEN, then restart the host llm-proxy if it's
//             running. The container holds only the rotatable session token;
//             the real account credential lives in the proxy, so switching
//             accounts is just this one value.
//   status  — show which credential/session token is configured and whether the
//             proxy + container are up.
//
// Usage: bun run container <login|status>

export {};

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from '../lib/atomic.ts';

const ENV_PATH = process.env.MARSCLAW_ENV_FILE ?? '.env';
const PROXY_PORT = Number(process.env.LLM_PROXY_PORT ?? 8765);

const sub = process.argv[3] ?? 'help';

switch (sub) {
  case 'login':
    await login();
    break;
  case 'status':
    await status();
    break;
  case 'enable':
    await setRuntime('container');
    break;
  case 'disable':
    await setRuntime('in-process');
    break;
  default:
    console.log(`marsclaw container — agent container runtime helpers

Usage:
  bun run container enable    Switch to container runtime (writes runtime=container to config.json).
  bun run container disable   Switch back to in-process runtime.
  bun run container login     Mint a Claude OAuth token (browser) and wire it into the proxy.
                              Log in as the account you want the agent to use.
  bun run container status    Show runtime mode, credential, daemon, and sidecar state.
`);
    if (sub !== 'help') process.exit(1);
}

// --- enable / disable ------------------------------------------------------
async function setRuntime(mode: 'container' | 'in-process'): Promise<void> {
  const { writeConfig } = await import('../lib/config.ts');
  writeConfig({ runtime: mode });
  console.log(`✓ runtime set to "${mode}" in data/config.json.`);
  if (mode === 'container') {
    // Mint the MCP shared-secret if absent — the host MCP server requires it
    // (it binds beyond loopback for the container to reach it). Both the
    // sidecar and the container read it from here.
    if (!readEnv('MARSCLAW_MCP_TOKEN')) {
      upsertEnv('MARSCLAW_MCP_TOKEN', `mcp-${cryptoRandomHex(24)}`);
      console.log('✓ Minted MARSCLAW_MCP_TOKEN (host MCP auth).');
    }
    const { dockerDaemonError } = await import('../providers/container-runtime.ts');
    const err = await dockerDaemonError();
    if (err) console.log(`⚠ ${err}`);
    console.log('Next: ensure Colima starts at login (`brew services start colima`), then restart the bot/service.');
    console.log('Make sure you have run `bun run container login` and built the image (container/agent-service/Dockerfile).');
  } else {
    console.log('Next: restart the bot/service to run the agent in-process again.');
  }
}

// --- login -----------------------------------------------------------------
async function login(): Promise<void> {
  const claude = resolveClaude();
  if (!claude) {
    console.error(
      'Could not find the `claude` CLI on PATH. Install Claude Code, or run `claude setup-token` ' +
        'yourself and paste the token into .env as CLAUDE_CODE_OAUTH_TOKEN.',
    );
    process.exit(1);
  }

  console.log('Opening Claude login… authenticate as the account you want the agent to use.\n');
  // `claude setup-token` is interactive (opens a browser) and prints the
  // sk-ant-oat… token to stdout on success. Inherit stdio so the user sees the
  // prompts, but capture stdout so we can extract the token.
  const r = spawnSync(claude, ['setup-token'], {
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    console.error('\n`claude setup-token` did not complete. Nothing changed.');
    process.exit(1);
  }
  const out = r.stdout ?? '';
  // Echo what the CLI printed (minus the bare token line we extract).
  const token = extractToken(out);
  if (!token) {
    console.error(
      '\nCould not find an sk-ant-oat… token in the command output. ' +
        'Copy it from above and paste it into .env as CLAUDE_CODE_OAUTH_TOKEN manually.',
    );
    process.exit(1);
  }

  upsertEnv('CLAUDE_CODE_OAUTH_TOKEN', token);
  console.log(`\n✓ Wrote CLAUDE_CODE_OAUTH_TOKEN to ${ENV_PATH} (${token.slice(0, 14)}…).`);

  // Ensure a session token exists for the container (mint one if absent).
  const sessionToken = readEnv('LLM_PROXY_SESSION_TOKEN');
  if (!sessionToken) {
    const minted = `mc-${cryptoRandomHex(24)}`;
    upsertEnv('LLM_PROXY_SESSION_TOKEN', minted);
    console.log(`✓ Minted LLM_PROXY_SESSION_TOKEN (container credential).`);
  }

  // Restart the proxy if it's currently running so the new account takes effect.
  await restartProxyIfRunning();
  console.log('\nDone. The container now authenticates as the new account (via the proxy).');
  console.log('If the bot is running, the next message uses the new credential.');
}

// --- status ----------------------------------------------------------------
async function status(): Promise<void> {
  const { loadConfig } = await import('../lib/config.ts');
  const { dockerDaemonError } = await import('../providers/container-runtime.ts');
  const cfg = loadConfig();
  const oauth = readEnv('CLAUDE_CODE_OAUTH_TOKEN');
  const apiKey = readEnv('ANTHROPIC_API_KEY');
  const session = readEnv('LLM_PROXY_SESSION_TOKEN');
  const mcpPort = Number(process.env.MARSCLAW_MCP_HTTP_PORT ?? 8766);
  const egressPort = Number(process.env.EGRESS_GATEWAY_PORT ?? 8775);
  const turnUrl = cfg.container_turn_url.replace(/\/+$/, '');

  console.log(`runtime mode:  ${cfg.runtime}${cfg.runtime === 'container' ? '' : '  (set with `bun run container enable`)'}`);
  const daemonErr = await dockerDaemonError();
  console.log(`container daemon: ${daemonErr ? 'DOWN — ' + daemonErr : 'up'}`);
  console.log('credentials:');
  console.log(`  CLAUDE_CODE_OAUTH_TOKEN  ${oauth ? oauth.slice(0, 14) + '… (subscription/OAuth)' : '(unset)'}`);
  console.log(`  ANTHROPIC_API_KEY        ${apiKey ? apiKey.slice(0, 10) + '… (metered)' : '(unset)'}`);
  console.log(`  LLM_PROXY_SESSION_TOKEN  ${session ? session.slice(0, 8) + '… (container holds this)' : '(unset)'}`);
  console.log('services:');
  console.log(`  llm-proxy   :${PROXY_PORT}   ${(await portUp(PROXY_PORT)) ? 'up' : 'down'}`);
  console.log(`  http-mcp    :${mcpPort}   ${(await portUp(mcpPort)) ? 'up' : 'down'}`);
  console.log(`  egress      :${egressPort}   ${(await portUp(egressPort)) ? 'up' : 'down'}`);
  console.log(`  agent /turn ${turnUrl}   ${(await healthUp(turnUrl)) ? 'up' : 'down'}`);
}

async function healthUp(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// --- helpers ---------------------------------------------------------------
function resolveClaude(): string | null {
  const which = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf-8' });
  const p = which.stdout?.trim();
  if (p && existsSync(p)) return p;
  // Common install location.
  const home = process.env.HOME ?? '';
  const fallback = `${home}/.local/bin/claude`;
  return existsSync(fallback) ? fallback : null;
}

function extractToken(text: string): string | null {
  const m = text.match(/sk-ant-oat[0-9A-Za-z._-]+/);
  return m ? m[0] : null;
}

function readEnvFile(): string {
  return existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
}

function readEnv(key: string): string | null {
  const m = readEnvFile().match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1]!.trim() : null;
}

// Insert or replace KEY=value in .env, preserving the rest. Writes atomically
// and keeps 0600 perms (the file holds secrets).
function upsertEnv(key: string, value: string): void {
  const raw = readEnvFile();
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  let next: string;
  if (re.test(raw)) {
    next = raw.replace(re, line);
  } else {
    next = raw.endsWith('\n') || raw === '' ? `${raw}${line}\n` : `${raw}\n${line}\n`;
  }
  writeAtomic(ENV_PATH, next);
  try {
    spawnSync('chmod', ['600', ENV_PATH]);
  } catch {
    /* best effort */
  }
}

function cryptoRandomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function portUp(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch (err) {
    return !/ECONNREFUSED|Unable to connect|fetch failed|refused/i.test(
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function restartProxyIfRunning(): Promise<void> {
  // The proxy caches the credential in-memory at startup, so the new token only
  // takes effect after a restart. The proxy is usually a child of the running
  // broker (startSidecars), so we DON'T kill it out from under the broker — that
  // would leave a half-dead state. We just tell the user what to do.
  if (await portUp(PROXY_PORT)) {
    console.log(
      `\nNOTE: llm-proxy is running on :${PROXY_PORT} with the OLD token. ` +
        `Restart the bot (Ctrl-C then \`MARSCLAW_RUNTIME=container bun run start\`) — or, if you ran ` +
        `the proxy standalone, restart \`bun run llm-proxy\` — to load the new account.`,
    );
  } else {
    console.log('llm-proxy is not running — it will pick up the new token whenever it next starts.');
  }
}
