// Per-request thread identity for the MCP tools.
//
// In stdio mode (the in-process runtime) each MCP server child is spawned with
// MARSCLAW_THREAD_ID in its env — one child per thread — so a process-global
// was enough. The HTTP MCP server (runtime='container') serves ALL threads from
// ONE process, so identity must be resolved PER REQUEST instead. The HTTP
// server wraps each request in `runWithThreadId(threadId, …)`; the tools read
// `currentThreadId()`, which prefers the AsyncLocalStorage value and falls back
// to the env var so stdio mode keeps working unchanged.

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<string>();

/** Run `fn` with `threadId` bound as the current MCP thread (HTTP server use). */
export function runWithThreadId<T>(threadId: string, fn: () => T): T {
  return als.run(threadId, fn);
}

/** The thread id for the in-flight tool call: ALS first, then env fallback. */
export function currentThreadId(): string {
  return als.getStore() ?? process.env.MARSCLAW_THREAD_ID ?? '';
}
