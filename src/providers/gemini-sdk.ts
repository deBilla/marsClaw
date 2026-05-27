// Gemini path via @google/gemini-cli-core — in-process inference reusing the
// same ~/.gemini/oauth_creds.json the gemini CLI writes. Replaces the legacy
// subprocess-per-turn spawn (which paid 5+s of CLI cold-start on every reply).
//
// Architecture (mirrors claude-sdk):
//   • Module-level lazy init: Config + ContentGenerator constructed once on
//     first use (~10–13s, mostly Config.initialize() walking memory + filesystem).
//   • Per-thread chat history kept in memory keyed by threadId; each turn sends
//     the recent transcript as `contents`, so we don't fight the SDK's chat
//     state model. The bot already passes a context-decorated prompt in.
//   • No tool calling — same scope as the legacy CLI path (`gemini -p ...`).
//
// The Config typing is intentionally loose (`as unknown as ...`): the core
// package exposes Config publicly but its constructor parameter shape is the
// CLI's internal contract and isn't worth retyping here. We pass the minimum
// fields the OAuth + Code Assist paths actually read.

import {
  AuthType,
  Config,
  createContentGenerator,
  createContentGeneratorConfig,
  LlmRole,
  type ContentGenerator,
} from '@google/gemini-cli-core';
import type { Content } from '@google/genai';
import type { Database } from 'bun:sqlite';
import { loadHistory, type HistoryRow } from '../db/messages.ts';
import { log } from '../lib/log.ts';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const HISTORY_TURNS = 20;

let cgPromise: Promise<ContentGenerator> | null = null;

function initContentGenerator(): Promise<ContentGenerator> {
  if (cgPromise) return cgPromise;
  cgPromise = (async () => {
    const t0 = Date.now();
    const config = new Config({
      sessionId: `marsclaw-${process.pid}`,
      targetDir: process.cwd(),
      debugMode: false,
      cwd: process.cwd(),
      model: MODEL,
    } as unknown as ConstructorParameters<typeof Config>[0]);
    await config.initialize();
    const cgConfig = await createContentGeneratorConfig(config, AuthType.LOGIN_WITH_GOOGLE);
    const cg = await createContentGenerator(cgConfig, config, `marsclaw-${process.pid}`);
    log.info('gemini sdk ready', { elapsed_ms: Date.now() - t0, model: MODEL });
    return cg;
  })().catch((err) => {
    // Don't cache a failed init — let the next turn retry.
    cgPromise = null;
    throw err;
  });
  return cgPromise;
}

function buildContents(history: HistoryRow[], userText: string, context: string): Content[] {
  const contents: Content[] = [];
  for (const m of history) {
    contents.push({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    });
  }
  // Decorate the live turn with ambient context (time, timezone, location).
  // Stored history stays raw — same convention as the claude path.
  contents.push({
    role: 'user',
    parts: [{ text: context ? `${context}\n\n${userText}` : userText }],
  });
  return contents;
}

export async function runGeminiSdk(
  db: Database,
  threadId: string,
  userText: string,
  context: string,
  timeoutMs: number,
): Promise<string> {
  const cg = await initContentGenerator();
  const history = loadHistory(db, threadId, HISTORY_TURNS);
  const contents = buildContents(history, userText, context);

  const t0 = Date.now();
  const reqPromise = cg.generateContent(
    { model: MODEL, contents },
    `${threadId}-${Date.now()}`,
    LlmRole.MAIN,
  );

  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`gemini sdk timeout after ${timeoutMs}ms`)), timeoutMs),
  );

  const resp = await Promise.race([reqPromise, timer]);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Concatenate text parts across the candidate's content. Gemini occasionally
  // returns multiple parts when grounding/citations are in play.
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('').trim();

  log.info('gemini turn end', { thread: threadId, elapsed, chars: text.length });
  return text;
}
