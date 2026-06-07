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
  flattenMemory,
  LlmRole,
  type ContentGenerator,
} from '@google/gemini-cli-core';
import type { Content } from '@google/genai';
import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { loadHistory, type HistoryRow } from '../db/messages.ts';
import { log } from '../lib/log.ts';

const MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const HISTORY_TURNS = 20;
const MEMORY_PATH = process.env.MARSCLAW_MEMORY ?? 'MEMORY.md';

let cgPromise: Promise<ContentGenerator> | null = null;

// The marsClaw persona, assembled by Config.initialize() from the GEMINI.md
// hierarchy (imports expanded). Captured at init so every turn can carry it as
// a systemInstruction — unlike the gemini CLI, calling generateContent directly
// does NOT inject GEMINI.md for us, so without this the model runs persona-less.
let personaMemory = '';

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
    // GEMINI.md (+ its @imports) loaded into hierarchical memory during
    // initialize(). Stash it so buildSystemInstruction() can prepend the persona.
    try {
      // getUserMemory() may return a structured HierarchicalMemory; flatten to
      // the same plain-text form the gemini CLI would feed the model.
      personaMemory = flattenMemory(config.getUserMemory?.());
    } catch (err) {
      log.warn('gemini: could not read user memory from config', { err });
      personaMemory = '';
    }
    const cgConfig = await createContentGeneratorConfig(config, AuthType.LOGIN_WITH_GOOGLE);
    const cg = await createContentGenerator(cgConfig, config, `marsclaw-${process.pid}`);
    log.info('gemini sdk ready', {
      elapsed_ms: Date.now() - t0,
      model: MODEL,
      persona_chars: personaMemory.length,
    });
    return cg;
  })().catch((err) => {
    // Don't cache a failed init — let the next turn retry.
    cgPromise = null;
    throw err;
  });
  return cgPromise;
}

// System instruction sent on EVERY turn: the marsClaw persona plus the user's
// durable profile (MEMORY.md). Read fresh each turn — the file is small and
// local, and re-reading means edits to MEMORY.md take effect without a restart.
// This is the only path by which MEMORY.md reaches the Gemini model: the
// in-process generateContent call has no file tools, so the model can't open
// the file itself the way GEMINI.md's instructions assume.
function buildSystemInstruction(): string | undefined {
  const sections: string[] = [];
  if (personaMemory.trim()) sections.push(personaMemory.trim());

  let profile = '';
  try {
    if (existsSync(MEMORY_PATH)) profile = readFileSync(MEMORY_PATH, 'utf-8').trim();
  } catch (err) {
    log.warn('gemini: could not read MEMORY.md', { err });
  }
  if (profile) {
    sections.push(
      `# Long-term memory about the user\n` +
        `The following is your durable record of who you are talking to (from MEMORY.md). ` +
        `Treat it as ground truth about the user and their context. Do NOT claim you have no ` +
        `memory or profile of them — you do, and it is below.\n\n${profile}`,
    );
  }

  if (sections.length === 0) return undefined;
  return sections.join('\n\n---\n\n');
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
  const systemInstruction = buildSystemInstruction();

  const t0 = Date.now();
  const reqPromise = cg.generateContent(
    {
      model: MODEL,
      contents,
      ...(systemInstruction ? { config: { systemInstruction } } : {}),
    },
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
