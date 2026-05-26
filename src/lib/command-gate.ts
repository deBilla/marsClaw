// Filter slash-commands that are meant for interactive CLIs (Claude Code's
// TUI, Gemini's REPL) but make no sense in chat mode. Without this, the
// agent receives "/help" verbatim and either ignores it (silent confusion)
// or replies with a fabricated explanation.
//
// Filtered messages are dropped silently — the user almost certainly typed
// "/clear" out of muscle-memory from Claude Code, not expecting a reply.

const FILTERED_COMMANDS = new Set([
  '/help',
  '/login',
  '/logout',
  '/doctor',
  '/config',
  '/remote-control',
  '/clear',
  '/compact',
  '/context',
  '/cost',
  '/files',
]);

export type GateResult = 'pass' | 'filter';

export function gateCommand(text: string): GateResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return 'pass';
  const command = trimmed.split(/\s/)[0].toLowerCase();
  return FILTERED_COMMANDS.has(command) ? 'filter' : 'pass';
}
