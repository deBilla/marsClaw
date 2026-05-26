// Claude Agent SDK session-id mapping. One row per thread. Lets the SDK
// `resume` a transcript after a session is recycled (idle timeout, crash,
// process restart).

import type { Database } from 'bun:sqlite';

export function getThreadSession(db: Database, threadId: string, provider: string): string | null {
  const row = db
    .query('SELECT session_id FROM sessions WHERE thread_id = ? AND provider = ?')
    .get(threadId, provider) as { session_id: string } | null;
  return row?.session_id ?? null;
}

export function setThreadSession(
  db: Database,
  threadId: string,
  provider: string,
  sessionId: string,
): void {
  db.query(
    `INSERT INTO sessions (thread_id, provider, session_id, updated_at)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(thread_id) DO UPDATE SET
       provider = excluded.provider,
       session_id = excluded.session_id,
       updated_at = unixepoch()`,
  ).run(threadId, provider, sessionId);
}

export function clearThreadSession(db: Database, threadId: string): void {
  db.query('DELETE FROM sessions WHERE thread_id = ?').run(threadId);
}
