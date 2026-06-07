// Non-interactive provider login for the macOS GUI. Spawns the provider CLI
// (which opens a browser for OAuth) and polls until the credential lands,
// emitting one-line progress the menubar app can surface. Idempotent.
//
//   marsclaw login            # uses agent_provider from config
//   marsclaw login claude     # explicit
//
// NOTE: in-process Claude/Gemini auth relies on the provider's own CLI
// (`claude` / `gemini`) being installed and its OAuth file present
// (~/.claude.json, ~/.gemini). The packaged app can't `npm i -g` these, so the
// button surfaces a clear "install the provider CLI" hint when the bin is
// missing. See docs/packaging-mac.md (open question: bundling provider login).

import { spawn } from 'node:child_process';
import { PROVIDERS } from '../providers/registry.ts';
import { loadConfig } from '../lib/config.ts';
import type { ProviderName } from '../providers/types.ts';

const name = (process.argv[3] as ProviderName | undefined) ?? loadConfig().agent_provider;
const provider = PROVIDERS[name];
if (!provider) {
  console.error(`unknown provider: ${name}`);
  process.exit(1);
}

if (provider.isAuthed()) {
  console.log(`already logged in to ${name}`);
  process.exit(0);
}

console.log(`opening ${provider.bin} for browser login…`);
const child = spawn(provider.bin, [], { stdio: 'inherit' });

child.on('error', (e) => {
  console.error(
    `could not launch ${provider.bin}: ${e.message}. Install the ${name} CLI (${provider.npmPackage}) and retry.`,
  );
  process.exit(1);
});

const TIMEOUT_MS = 5 * 60_000;
const start = Date.now();
const poll = setInterval(() => {
  if (provider.isAuthed()) {
    clearInterval(poll);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 2000);
    console.log(`logged in to ${name}`);
    process.exit(0);
  }
  if (Date.now() - start > TIMEOUT_MS) {
    clearInterval(poll);
    child.kill('SIGTERM');
    console.error('login timed out');
    process.exit(1);
  }
}, 500);
