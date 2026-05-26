// Launchd service installer for nothingclaw.
//
// Subcommands:
//   install    — render plist with resolved paths, copy to LaunchAgents, bootstrap
//   uninstall  — bootout + remove plist
//   status     — print loaded state + log paths + binary-exists check
//   logs       — tail logs/nothingclaw.log
//
// We use `launchctl bootstrap / bootout` (modern API) instead of the deprecated
// `launchctl load / unload`.

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeAtomic } from '../lib/atomic.ts';
import { log } from '../lib/log.ts';

const SERVICE_LABEL = 'com.nothingclaw';
const PLIST_TEMPLATE = 'launchd/com.nothingclaw.plist';
const PROJECT_ROOT = process.cwd();
const HOME = homedir();
const LAUNCHAGENTS_DIR = join(HOME, 'Library', 'LaunchAgents');
const INSTALLED_PLIST = join(LAUNCHAGENTS_DIR, `${SERVICE_LABEL}.plist`);

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf-8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function getUid(): string {
  const r = spawnSync('id', ['-u'], { encoding: 'utf-8' });
  return r.stdout.trim();
}

function renderPlist(): string {
  const bunPath = which('bun');
  if (!bunPath) {
    throw new Error('bun not found on PATH — install it first (curl -fsSL https://bun.sh/install | bash)');
  }
  const tpl = readFileSync(PLIST_TEMPLATE, 'utf-8');
  return tpl
    .replaceAll('{{BUN_PATH}}', bunPath)
    .replaceAll('{{PROJECT_ROOT}}', PROJECT_ROOT)
    .replaceAll('{{HOME}}', HOME);
}

function install(): void {
  mkdirSync(LAUNCHAGENTS_DIR, { recursive: true });
  mkdirSync(join(PROJECT_ROOT, 'logs'), { recursive: true });
  const plist = renderPlist();
  writeAtomic(INSTALLED_PLIST, plist);
  log.info('plist written', { path: INSTALLED_PLIST });

  // If a previous version is loaded, bootout first — bootstrap rejects duplicates.
  spawnSync('launchctl', ['bootout', `gui/${getUid()}/${SERVICE_LABEL}`], { stdio: 'ignore' });

  const r = spawnSync('launchctl', ['bootstrap', `gui/${getUid()}`, INSTALLED_PLIST], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    log.error('launchctl bootstrap failed', { stderr: r.stderr.trim() });
    process.exit(1);
  }
  log.info('service installed and running');
  log.info('logs:   tail -F logs/nothingclaw.log');
  log.info('errors: tail -F logs/nothingclaw.error.log');
}

function uninstall(): void {
  const uid = getUid();
  spawnSync('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`], { stdio: 'inherit' });
  if (existsSync(INSTALLED_PLIST)) {
    unlinkSync(INSTALLED_PLIST);
    log.info('plist removed', { path: INSTALLED_PLIST });
  }
  log.info('service uninstalled');
}

function status(): void {
  const uid = getUid();
  const r = spawnSync('launchctl', ['print', `gui/${uid}/${SERVICE_LABEL}`], { encoding: 'utf-8' });
  if (r.status !== 0) {
    log.warn('service not loaded', { hint: `run: bun run service install` });
    return;
  }
  // Extract a few interesting fields.
  const out = r.stdout;
  const pidMatch = out.match(/pid = (\d+)/);
  const stateMatch = out.match(/state = (\S+)/);
  const lastExitMatch = out.match(/last exit code = (\S+)/);
  log.info('service status', {
    label: SERVICE_LABEL,
    pid: pidMatch?.[1] ?? '-',
    state: stateMatch?.[1] ?? '-',
    last_exit: lastExitMatch?.[1] ?? '-',
  });

  // Sanity-check the Bun binary referenced in the plist still exists.
  const plistContent = existsSync(INSTALLED_PLIST) ? readFileSync(INSTALLED_PLIST, 'utf-8') : '';
  const bunMatch = plistContent.match(/<string>([^<]*\/bun)<\/string>/);
  if (bunMatch && !existsSync(bunMatch[1])) {
    log.warn('plist references a Bun binary that no longer exists', {
      path: bunMatch[1],
      fix: 'run: bun run service install',
    });
  }
}

function logs(): void {
  const logFile = join(PROJECT_ROOT, 'logs', 'nothingclaw.log');
  if (!existsSync(logFile)) {
    log.warn('no log file yet', { path: logFile });
    return;
  }
  // Inherit so Ctrl-C cleanly stops tail.
  spawnSync('tail', ['-F', resolve(logFile)], { stdio: 'inherit' });
}

const sub = process.argv[3] ?? 'status';

switch (sub) {
  case 'install':
    install();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'status':
    status();
    break;
  case 'logs':
    logs();
    break;
  default:
    log.fatal('unknown service subcommand', { sub, valid: ['install', 'uninstall', 'status', 'logs'] });
    process.exit(1);
}
