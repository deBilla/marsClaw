// Shared Slack onboarding flow — used by interactive setup (step 7) and the
// standalone `marsclaw slack connect` command.
//
// Each person creates their OWN Slack app (Socket Mode delivers each event to
// only ONE connected client, so a shared app can't fan out to multiple
// laptops). The app name carries the owner so several marsClaw bots in one
// workspace are tellable apart.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from '../lib/atomic.ts';

// Prompt/output helpers injected by the caller so this module doesn't own a
// readline instance (setup.ts and slack.ts each have their own).
export interface SlackSetupIO {
  ask(prompt: string, def?: string): Promise<string>;
  yesNo(prompt: string, def: boolean): Promise<boolean>;
  info(s: string): void;
  warn(s: string): void;
}

export interface SlackChoices {
  slackEnabled: boolean;
  // Keep-when-disabled semantics: when disabled, existing tokens are carried
  // so the env writer comments them out instead of dropping them.
  slackBotToken: string;
  slackAppToken: string;
  slackAllowedUsers: string[];
}

// Scopes/events mirror what src/channels/slack.ts requires.
export function slackManifest(appName: string): object {
  return {
    display_information: {
      name: appName,
      description: 'Personal assistant — DM me anything.',
      background_color: '#1a1a2e',
    },
    features: {
      bot_user: { display_name: appName, always_online: true },
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          'chat:write',
          'files:read',
          'files:write',
          'im:history',
          'im:read',
          'im:write',
          'app_mentions:read',
          'users:read',
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      event_subscriptions: { bot_events: ['message.im', 'app_mention'] },
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

// Slack caps app names at 35 chars; truncate the "(owner)" suffix, never the
// bot name itself, so the result stays recognisable.
export function slackAppName(botName: string, ownerName: string): string {
  if (!ownerName) return botName.slice(0, 35);
  const full = `${botName} (${ownerName})`;
  if (full.length <= 35) return full;
  return botName.length <= 32
    ? `${botName} (${ownerName.slice(0, 35 - botName.length - 3)})`
    : botName.slice(0, 35);
}

export function openInBrowser(url: string): boolean {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  return spawnSync(opener, [url], { stdio: 'ignore' }).status === 0;
}

// Read the value of an uncommented `KEY=value` line from .env (commented lines
// are ignored so we never resurrect a token the owner deliberately disabled).
export function slackEnvValue(key: 'SLACK_BOT_TOKEN' | 'SLACK_APP_TOKEN'): string {
  if (!existsSync('.env')) return '';
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm');
  const m = re.exec(readFileSync('.env', 'utf-8'));
  return m ? m[1].trim() : '';
}

// Rewrite ONLY the SLACK_* lines in .env, leaving everything else (including
// comments for other keys) untouched. Previously-commented slack tokens are
// dropped so a disable→enable round-trip doesn't accumulate duplicates.
export function writeSlackEnv(slack: { enabled: boolean; botToken: string; appToken: string }): void {
  const managed = /^#?\s*(SLACK_BOT_TOKEN|SLACK_APP_TOKEN)\s*=/;
  const existing = existsSync('.env') ? readFileSync('.env', 'utf-8') : '';
  const lines = existing.split('\n').filter((l) => !managed.test(l.trim()));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); // no blank-line creep across cycles
  if (slack.enabled && slack.botToken && slack.appToken) {
    lines.push(`SLACK_BOT_TOKEN=${slack.botToken}`);
    lines.push(`SLACK_APP_TOKEN=${slack.appToken}`);
  } else {
    // Disabled but we still hold tokens — keep them commented so the runtime
    // (which keys off token presence) ignores them, but the owner can
    // re-enable without redoing the Slack app dance.
    if (slack.botToken) lines.push(`# SLACK_BOT_TOKEN=${slack.botToken}`);
    if (slack.appToken) lines.push(`# SLACK_APP_TOKEN=${slack.appToken}`);
  }
  writeAtomic('.env', lines.join('\n').replace(/\n+$/, '') + '\n');
}

export async function askSlack(
  io: SlackSetupIO,
  botName: string,
  ownerName: string,
  currentUsers: string[],
): Promise<SlackChoices> {
  const { ask, yesNo, info, warn } = io;
  const existingBot = slackEnvValue('SLACK_BOT_TOKEN');
  const existingApp = slackEnvValue('SLACK_APP_TOKEN');
  const hasExisting = Boolean(existingBot && existingApp);
  info('Slack — each person runs their own Slack app (free, ~2 min, pre-filled).');
  if (hasExisting) info('  Tokens are already set in .env.');
  const slackEnabled = await yesNo('  Enable Slack?', hasExisting);

  if (!slackEnabled) {
    return {
      slackEnabled: false,
      slackBotToken: existingBot,
      slackAppToken: existingApp,
      slackAllowedUsers: currentUsers,
    };
  }

  if (!hasExisting || (await yesNo('  Create a new Slack app now?', !hasExisting))) {
    // The app is named after the PERSON, not just the bot — several marsClaw
    // bots in one workspace are indistinguishable otherwise. Ask rather than
    // trust config: owner_name is often empty on older setups.
    let who = await ask('  Your name (labels the Slack app so people know whose bot it is)', ownerName || undefined);
    while (!who) {
      warn('  A name is required — the app is visible to your whole workspace.');
      who = await ask('  Your name');
    }
    const appName = slackAppName(botName, who);
    const url =
      'https://api.slack.com/apps?new_app=1&manifest_json=' +
      encodeURIComponent(JSON.stringify(slackManifest(appName)));
    info(`  Opening Slack's app-creation page pre-filled as "${appName}"…`);
    if (!openInBrowser(url)) {
      warn('  Could not open a browser. Visit https://api.slack.com/apps?new_app=1,');
      warn('  choose "From a manifest", and paste slack-manifest.yaml from this repo');
      warn(`  (set the name to "${appName}").`);
    }
    info('  In the browser:');
    info('    1. Pick your workspace → Create.');
    info('    2. Settings → Install App → "Install to Workspace" → copy the');
    info('       Bot User OAuth Token (xoxb-…).');
    info('    3. Settings → Basic Information → App-Level Tokens → Generate Token,');
    info('       scope `connections:write` → copy the token (xapp-…).');
  }

  let slackBotToken = '';
  while (true) {
    const raw = await ask(existingBot ? '  Bot token xoxb-… (enter to keep current)' : '  Bot token (xoxb-…)');
    if (!raw && existingBot) {
      slackBotToken = existingBot;
      break;
    }
    if (raw.startsWith('xoxb-')) {
      slackBotToken = raw;
      break;
    }
    if (raw && (await yesNo("  That doesn't look like a bot token (xoxb-…). Use it anyway?", false))) {
      slackBotToken = raw;
      break;
    }
    if (!raw) warn('  A bot token is required to enable Slack.');
  }

  let slackAppToken = '';
  while (true) {
    const raw = await ask(existingApp ? '  App token xapp-… (enter to keep current)' : '  App-level token (xapp-…)');
    if (!raw && existingApp) {
      slackAppToken = existingApp;
      break;
    }
    if (raw.startsWith('xapp-')) {
      slackAppToken = raw;
      break;
    }
    if (raw && (await yesNo("  That doesn't look like an app token (xapp-…). Use it anyway?", false))) {
      slackAppToken = raw;
      break;
    }
    if (!raw) warn('  An app-level token (Socket Mode) is required to enable Slack.');
  }

  // Slack bots are visible to the whole workspace, so locking to specific user
  // ids matters more than on Telegram. Empty still means accept-all — the bot
  // logs each new user id for a later lock-down, same as Telegram.
  info('  Restrict to specific Slack user ids (optional, e.g. U0123ABCDEF).');
  info('  Find yours: Slack profile → ⋮ → "Copy member ID". Leave empty to accept');
  info('  any sender for now — the bot logs new user ids so you can lock down later.');
  const rawUsers = await ask('  Allowed user ids (comma-separated)', currentUsers.join(',') || undefined);
  const slackAllowedUsers = rawUsers
    ? rawUsers
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return { slackEnabled, slackBotToken, slackAppToken, slackAllowedUsers };
}
