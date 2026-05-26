import { claude } from './claude.ts';
import { gemini } from './gemini.ts';
import { loadConfig } from '../lib/config.ts';
import type { Provider, ProviderName } from './types.ts';

export const PROVIDERS: Record<ProviderName, Provider> = { gemini, claude };

export function pickProvider(): Provider {
  const name = loadConfig().agent_provider;
  const p = PROVIDERS[name];
  if (!p) {
    const known = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown agent_provider='${name}'. Choose one of: ${known}`);
  }
  return p;
}
