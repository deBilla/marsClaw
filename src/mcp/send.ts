import { Database } from 'bun:sqlite';
import { DB_PATH } from '../db/connection.ts';
import { currentThreadId } from './thread-context.ts';

let _db: Database | null = null;
function db(): Database {
  if (!_db) _db = new Database(DB_PATH);
  return _db;
}

export const sendTool = {
  definition: {
    name: 'send_message',
    description:
      'Send an ADDITIONAL message to the user out-of-band. Your stdout reply is already sent automatically — only use this tool when you genuinely need to send more than one message (e.g. a quick acknowledgement before a longer answer).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Message text to send' },
      },
      required: ['text'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const text = String(args.text ?? '').trim();
    if (!text) {
      return { content: [{ type: 'text', text: 'Error: text is required' }], isError: true };
    }
    const threadId = currentThreadId();
    if (!threadId) {
      return { content: [{ type: 'text', text: 'Error: MARSCLAW_THREAD_ID not set' }], isError: true };
    }
    db().query('INSERT INTO outbox (thread_id, text) VALUES (?, ?)').run(threadId, text);
    return { content: [{ type: 'text', text: 'Queued.' }] };
  },
};
