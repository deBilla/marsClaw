// `bun run restart` — restart the launchd-managed bot in place.
//
// Uses `launchctl kickstart -k gui/$UID/com.nothingclaw`: SIGTERM the current
// process, KeepAlive respawns it. Same primitive as `update` uses after a
// pull, exposed on its own so you can recycle without changing code.

import { spawnSync } from 'node:child_process';

function ok(s: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${s}`);
}
function info(s: string): void {
  console.log(`  ${s}`);
}
function fail(s: string): never {
  console.error(`\x1b[31m✗\x1b[0m ${s}`);
  process.exit(1);
}

const uid = spawnSync('id', ['-u'], { encoding: 'utf-8' }).stdout.trim();
const label = `gui/${uid}/com.nothingclaw`;

const printed = spawnSync('launchctl', ['print', label], { encoding: 'utf-8' });
if (printed.status !== 0) {
  fail('service not loaded via launchd — run `bun run service install` first, or restart the foreground process by hand.');
}

info(`launchctl kickstart -k ${label}…`);
const kick = spawnSync('launchctl', ['kickstart', '-k', label], { encoding: 'utf-8' });
if (kick.status !== 0) {
  fail(`launchctl kickstart failed:\n${kick.stderr}`);
}
ok('service restarted. Tail logs/nothingclaw.log to verify.');
