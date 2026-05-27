import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider } from './types.ts';

const HOME = process.env.HOME ?? '';

function geminiIsAuthed(): boolean {
  if (process.env.GEMINI_API_KEY) return true;
  const candidates = [
    join(HOME, '.gemini', 'oauth_creds.json'),
    join(HOME, '.config', 'gemini', 'oauth_creds.json'),
  ];
  return candidates.some((p) => existsSync(p) && statSync(p).size > 0);
}

export const gemini: Provider = {
  name: 'gemini',
  bin: process.env.GEMINI_BIN ?? 'gemini',
  npmPackage: '@google/gemini-cli',
  buildArgs(prompt) {
    // --skip-trust bypasses the trusted-folder gate (no human in this loop).
    return ['-p', prompt, '--skip-trust'];
  },
  isAuthed: geminiIsAuthed,
};
