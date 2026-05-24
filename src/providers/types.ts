export type ProviderName = 'gemini' | 'claude';

export interface Provider {
  name: ProviderName;
  /** Binary on PATH (overridable per-provider via env). */
  bin: string;
  /** npm package globally installed by setup. */
  npmPackage: string;
  /** Argv to spawn for a non-interactive one-shot prompt. */
  buildArgs(prompt: string): string[];
  /** Fast, side-effect-free check for whether the user has already logged in. */
  isAuthed(): boolean;
}
