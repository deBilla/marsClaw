#!/usr/bin/env bun
// marsClaw CLI — subcommand router.

import { bootstrapHome } from '../lib/bootstrap.ts';

// Compiled-in sidecars (runtime='container'). The packaged single binary can't
// `bun run tools/*.ts` — there's no bun and the scripts aren't on disk — so the
// host sidecars (LLM proxy, HTTP MCP, egress) run as `marsclaw _sidecar <name>`,
// spawned by container-runtime.ts. Handled FIRST and OUTSIDE bootstrapHome:
// sidecars are standalone servers that must not chdir/seed HOME. Literal import
// paths so `bun --compile` bundles each module; every one starts its own
// Bun.serve on import and keeps the process alive.
if (process.argv[2] === '_sidecar') {
  const name = process.argv[3];
  switch (name) {
    case 'llm-proxy-anthropic':
      await import('../../tools/llm-proxy/proxy.ts');
      break;
    case 'llm-proxy-gemini':
      await import('../../tools/llm-proxy/gemini.ts');
      break;
    case 'mcp-http':
      await import('../mcp/http-server.ts');
      break;
    case 'egress':
      await import('../../tools/egress-gateway/gateway.ts');
      break;
    default:
      console.error(`Unknown sidecar: ${name}`);
      process.exit(1);
  }
} else {
  await runCli();
}

async function runCli(): Promise<void> {
// Relocate into MARSCLAW_HOME (packaged app) and seed first-run files BEFORE any
// subcommand runs — every command below resolves `data/...` paths against cwd.
bootstrapHome();

const cmd = process.argv[2] ?? 'start';

switch (cmd) {
  case 'setup':
    await import('./setup.ts');
    break;
  case 'start':
    await import('../index.ts');
    break;
  case 'status':
    await import('./status.ts');
    break;
  case 'provider':
    await import('./provider.ts');
    break;
  case 'whatsapp':
    await import('./whatsapp.ts');
    break;
  case 'slack':
    await import('./slack.ts');
    break;
  case 'voice':
    await import('./voice.ts');
    break;
  case 'google':
    await import('./google.ts');
    break;
  case 'service':
    await import('./service.ts');
    break;
  case 'container':
    await import('./container.ts');
    break;
  case 'path':
    await import('./path.ts');
    break;
  case 'backup':
    await import('./backup.ts');
    break;
  case 'db':
    await import('./db.ts');
    break;
  case 'usage':
    await import('./usage.ts');
    break;
  case 'update':
    await import('./update.ts');
    break;
  case 'smoke':
    await import('./smoke.ts');
    break;
  case 'login':
    await import('./login.ts');
    break;
  case 'apply-setup':
    await import('./apply-setup.ts');
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
}
}

function printHelp(): void {
  console.log(`marsclaw — personal chat agent

Usage:
  marsclaw [command]

Commands:
  setup                       Interactive setup (provider, login, channels)
  start                       Start the bot (default)
  status                      Show provider, db stats, recent activity
  provider [gemini|claude]    Switch agent provider (interactive if no arg)
  whatsapp <sub>              WhatsApp ops (reset | status | clear-media)
  slack <sub>                 Slack channel (connect | status | disconnect)
  voice <sub>                 Voice (Whisper) ops (install | start | stop | status)
  google <sub>                Google OAuth (login | status | logout | test)
  service <sub>               Manage launchd service (install | uninstall | start | stop | restart | status | logs)
  container <sub>             Agent container runtime (enable | disable | login | status)
  path <sub>                  Manage agent allowed_paths (list | add <p> | remove <p> | reset)
  backup                      Run a one-shot backup (db + MEMORY.md + whatsapp-auth)
  db <sub>                    DB maintenance (stats | vacuum | integrity)
  usage <sub>                 Anthropic spend (today | week | by-thread)
  update [--force]            Pull latest, install deps, restart service
  smoke [prompt]              Fire a synthetic message through the agent end-to-end
  login [gemini|claude]       Browser login for the agent provider (used by the GUI)
  apply-setup '<json>'        Persist setup non-interactively from a JSON payload (GUI)
  help                        Print this message
`);
}
