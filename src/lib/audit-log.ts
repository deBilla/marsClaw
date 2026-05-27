// Security audit log — append-only JSON-lines record of every tool attempt
// the agent makes: built-in tools (via canUseTool) and MCP tools (when they
// refuse via the mutation gate). The point isn't observability for ops (the
// regular `pino` log handles that) — it's a forensic trail so that if an
// injection succeeds, you can answer "what did the agent try to do, and what
// did the gate block?" after the fact.
//
// Design choices:
//   • Separate file from app logs (logs/audit.log) so volume / retention can
//     be reasoned about independently.
//   • JSON Lines, append-only — every line is a self-contained record.
//   • Writes use O_APPEND so concurrent appends from the main process and the
//     MCP child don't tear small lines (POSIX guarantees atomicity below
//     PIPE_BUF, which JSON Lines easily fit under).
//   • No rotation in-process — operators can `logrotate` it externally; we
//     don't want to lose security history to a rotation race.
//
// What this does NOT give you: tamper-resistance against an attacker with
// host-level access. The file is on the same disk as everything else and the
// agent's host user can rewrite it. Real tamper-evidence needs an external
// log sink (syslog, a remote service) — which is a fair next step if you
// outgrow this. For a personal bot, an honest local trail is the right size.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type AuditDecision = 'allow' | 'deny' | 'blocked';

export interface AuditRecord {
  /** Tool name as the SDK sees it (e.g. "Bash", "WebFetch", "mcp__marsclaw__gmail_send"). */
  tool: string;
  decision: AuditDecision;
  /** Short reason for deny/blocked; omitted for allow. */
  reason?: string;
  /** Short, redacted hint at what the tool was asked to do (URL, command preview, file_path). */
  subject?: string;
  /** Layer that made the decision: built-in permission gate, mutation gate, etc. */
  layer?: 'canUseTool' | 'mutation-gate' | 'sensitive-paths' | 'url-allowlist' | 'shell-disabled' | 'web-disabled';
}

// Path is resolved lazily so the env var can be set before each call. Each
// distinct path we've ever written to is dir-ensured once and remembered.
const ensuredDirs = new Set<string>();

function currentPath(): string {
  return process.env.MARSCLAW_AUDIT_LOG ?? 'logs/audit.log';
}

function ensureDirFor(p: string): void {
  const d = dirname(p);
  if (!d || ensuredDirs.has(d)) return;
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  ensuredDirs.add(d);
}

export function audit(rec: AuditRecord): void {
  const p = currentPath();
  try {
    ensureDirFor(p);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        ...rec,
      }) + '\n';
    appendFileSync(p, line, { encoding: 'utf8' });
  } catch (err) {
    // Audit logging must never crash the bot — but a write failure is itself
    // a signal worth surfacing once via the regular logger. Use console to
    // avoid an import cycle with lib/log.ts (which is a heavier module).
    void err;
    process.stderr.write(`[audit] write failed: ${(err as Error)?.message ?? err}\n`);
  }
}

/** Read-side helper used by tests; trivial enough to inline. */
export function _auditPathForTests(): string {
  return currentPath();
}
