// Slack channel management for existing setups — connect without re-running
// the full interactive setup.
//
//   marsclaw slack connect      Create/link a Slack app, store tokens + allowlist
//   marsclaw slack status       Show whether Slack is wired up
//   marsclaw slack disconnect   Disable Slack (tokens kept commented in .env)

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, writeConfig } from '../lib/config.ts';
import { isServiceLoaded, restartService } from '../lib/launchd.ts';
import { askSlack, slackEnvValue, writeSlackEnv, type SlackSetupIO } from './slack-setup.ts';

const ok = (s: string): void => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const info = (s: string): void => console.log(`  ${s}`);
const warn = (s: string): void => console.log(`\x1b[33m!\x1b[0m ${s}`);

const mask = (t: string): string => (t.length > 12 ? `${t.slice(0, 9)}…${t.slice(-4)}` : '(set)');

// Restart the background service (if any) so the new channel state takes
// effect without the owner remembering the launchd incantation.
async function offerRestart(io: SlackSetupIO): Promise<void> {
  if (!isServiceLoaded()) {
    info('Restart the bot to apply: bun run start (or: bun run service restart)');
    return;
  }
  if (await io.yesNo('Restart the background service now to apply?', true)) {
    const r = restartService();
    if (r.ok) ok('Service restarted.');
    else warn(`Couldn't restart${r.reason ? ` (${r.reason})` : ''}. Run: bun run service restart`);
  } else {
    info('Apply later with: bun run service restart');
  }
}

async function connect(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const io: SlackSetupIO = {
    ask: async (prompt, def) => {
      const suffix = def !== undefined ? ` [${def}]` : '';
      const ans = (await rl.question(`${prompt}${suffix}: `)).trim();
      return ans || def || '';
    },
    yesNo: async (prompt, def) => {
      const dStr = def ? 'Y/n' : 'y/N';
      while (true) {
        const raw = (await rl.question(`${prompt} (${dStr}): `)).trim().toLowerCase();
        if (!raw) return def;
        if (raw === 'y' || raw === 'yes') return true;
        if (raw === 'n' || raw === 'no') return false;
        warn('Please answer y or n.');
      }
    },
    info,
    warn,
  };

  const cfg = loadConfig();
  const choices = await askSlack(io, cfg.bot_name, cfg.owner_name, cfg.allowed_slack_users);
  writeSlackEnv({
    enabled: choices.slackEnabled,
    botToken: choices.slackBotToken,
    appToken: choices.slackAppToken,
  });
  writeConfig({ allowed_slack_users: choices.slackAllowedUsers });

  if (choices.slackEnabled) {
    ok('Slack connected — tokens written to .env, allowlist to data/config.json.');
    ok(
      `allowed: ${choices.slackAllowedUsers.length ? choices.slackAllowedUsers.join(', ') : 'any sender (lock down later in data/config.json)'}`,
    );
    await offerRestart(io);
  } else {
    info('Slack left disabled.');
  }
  rl.close();
}

function status(): void {
  const bot = slackEnvValue('SLACK_BOT_TOKEN');
  const app = slackEnvValue('SLACK_APP_TOKEN');
  const cfg = loadConfig();
  if (bot && app) {
    ok('Slack is configured.');
    info(`bot token:  ${mask(bot)}`);
    info(`app token:  ${mask(app)}`);
    info(`allowed:    ${cfg.allowed_slack_users.length ? cfg.allowed_slack_users.join(', ') : 'any sender'}`);
  } else if (bot || app) {
    warn(`Partially configured — ${bot ? 'SLACK_APP_TOKEN' : 'SLACK_BOT_TOKEN'} is missing.`);
    info('Run: marsclaw slack connect');
  } else {
    info('Slack is not configured. Run: marsclaw slack connect');
  }
}

async function disconnect(): Promise<void> {
  const bot = slackEnvValue('SLACK_BOT_TOKEN');
  const app = slackEnvValue('SLACK_APP_TOKEN');
  if (!bot && !app) {
    info('Slack is not configured — nothing to disconnect.');
    return;
  }
  writeSlackEnv({ enabled: false, botToken: bot, appToken: app });
  ok('Slack disabled. Tokens kept commented in .env — re-enable with: marsclaw slack connect');
  const rl = createInterface({ input: stdin, output: stdout });
  const io: SlackSetupIO = {
    ask: async () => '',
    yesNo: async (prompt, def) => {
      const dStr = def ? 'Y/n' : 'y/N';
      const raw = (await rl.question(`${prompt} (${dStr}): `)).trim().toLowerCase();
      return raw ? raw === 'y' || raw === 'yes' : def;
    },
    info,
    warn,
  };
  await offerRestart(io);
  rl.close();
}

const sub = process.argv[3] ?? 'connect';
switch (sub) {
  case 'connect':
    await connect();
    break;
  case 'status':
    status();
    break;
  case 'disconnect':
    await disconnect();
    break;
  default:
    console.error(`Unknown subcommand: ${sub}\nUsage: marsclaw slack [connect|status|disconnect]`);
    process.exit(1);
}
process.exit(0);
