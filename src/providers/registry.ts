import { claude } from './claude.ts';
import { gemini } from './gemini.ts';
import type { Provider, ProviderName } from './types.ts';

export const PROVIDERS: Record<ProviderName, Provider> = { gemini, claude };

export function pickProvider(): Provider {
  const name = (process.env.AGENT_PROVIDER ?? 'gemini') as ProviderName;
  const p = PROVIDERS[name];
  if (!p) {
    const known = Object.keys(PROVIDERS).join(', ');
    throw new Error(`Unknown AGENT_PROVIDER='${name}'. Choose one of: ${known}`);
  }
  return p;
}
