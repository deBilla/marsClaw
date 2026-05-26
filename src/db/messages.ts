import type { Database } from 'bun:sqlite';

export interface HistoryRow {
  role: 'user' | 'assistant';
  text: string;
}

export function loadHistory(db: Database, threadId: string, limit = 20): HistoryRow[] {
  const rows = db
    .query('SELECT role, text FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
    .all(threadId, limit) as HistoryRow[];
  return rows.reverse();
}

export function appendMessage(
  db: Database,
  threadId: string,
  role: 'user' | 'assistant',
  text: string,
): void {
  db.query('INSERT INTO messages (thread_id, role, text) VALUES (?, ?, ?)').run(threadId, role, text);
}
