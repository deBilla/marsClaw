// Files/dirs that hold secrets or marsClaw's own permission config. These are
// off-limits to the agent's filesystem-touching tools (Read/Write/Edit/Glob/
// Grep) and to send_file — even when they fall inside an `allowed_paths` root,
// which `.env` and `data/` do by default.
//
// Why: the agent ingests untrusted content (email bodies via gmail_get, web
// pages via WebFetch). A prompt-injected turn must not be able to (a) read its
// own credentials or (b) widen its own sandbox by rewriting config.
//
// LIMITATION: this guards the structured file tools and send_file only. Bash
// is NOT path-checked (it can `cd`/redirect anywhere), so a determined
// `cat .env` still works. Closing that hole needs a credential broker / real
// sandbox — see docs/vs-nanoclaw.md. This raises the bar; it is not airtight.

import path from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();

// Resolved once at load against the process cwd (the project root).
export const SENSITIVE_PATHS: string[] = [
  path.resolve('.env'), // channel tokens, Google OAuth client id/secret
  path.resolve('data/config.json'), // allowed_paths, denylist, budget — self-escalation surface
  path.resolve('data/secrets'), // Linux refresh-token fallback files
  path.join(HOME, '.claude.json'), // Claude Code OAuth / API key
  path.join(HOME, '.claude'), // Claude Code session transcripts
  path.join(HOME, '.gemini'), // Gemini CLI credentials
].map((p) => path.resolve(p));

function isUnder(target: string, root: string): boolean {
  const rel = path.relative(root, path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True when `target` is one of, or inside, a sensitive path. */
export function isSensitivePath(target: string): boolean {
  return SENSITIVE_PATHS.some((s) => isUnder(target, s));
}
