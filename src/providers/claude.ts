import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider } from './types.ts';

const HOME = process.env.HOME ?? '';

function claudeIsAuthed(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const cfg = join(HOME, '.claude.json');
  if (!existsSync(cfg)) return false;
  try {
    const text = readFileSync(cfg, 'utf-8');
    // Claude Code writes oauthAccount after login; presence is the cleanest signal.
    return text.includes('"oauthAccount"') || text.includes('"primaryApiKey"');
  } catch (err) {
    // File unreadable (permission, race) — treat as not-authed.
    void err;
    return false;
  }
}

/**
 * True when the bot is paying by the metered Anthropic API (per-token billing).
 * False when running under a Claude Pro/Max subscription via OAuth — in that
 * case `SDKResultSuccess.total_cost_usd` reports the API-equivalent value but
 * no money actually changes hands per turn, so the daily budget cap is
 * meaningless and should be skipped.
 */
export function isUsingMeteredApi(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export const claude: Provider = {
  name: 'claude',
  bin: process.env.CLAUDE_BIN ?? 'claude',
  npmPackage: '@anthropic-ai/claude-code',
  buildArgs(prompt) {
    // -p = print (non-interactive). --dangerously-skip-permissions = don't
    // prompt for tool approvals (no human in this loop).
    return ['-p', prompt, '--dangerously-skip-permissions'];
  },
  isAuthed: claudeIsAuthed,
};
