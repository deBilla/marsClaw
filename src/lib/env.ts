// Parse the .env file and return values for the requested keys.
// Does NOT load anything into process.env — callers decide what to do with
// the values. Keeps secrets out of the inherited environment so they don't
// leak to spawned children (MCP server, voice sidecars, agent CLI).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.ts';

export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = join(process.cwd(), '.env');
  let content: string;
  try {
    content = readFileSync(envFile, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
