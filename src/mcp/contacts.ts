// MCP tool: search the user's Google contacts (and the "Other Contacts"
// auto-complete pool) by name or email fragment.

import { searchContacts, type Contact } from '../google/contacts.ts';

function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/No stored credentials|No Google accounts/.test(msg)) return `Contacts not connected: ${msg}`;
  return `Contacts error: ${msg}`;
}

function line(c: Contact): string {
  const emails = c.emails.join(', ');
  const phones = c.phones.length ? `  ${c.phones.join(', ')}` : '';
  return `${c.name || '(no name)'} — ${emails || '(no email)'}${phones}`;
}

export const contactsSearchTool = {
  definition: {
    name: 'contacts_search',
    description:
      "Search the user's Google contacts by name or email fragment. Looks at both saved contacts and Gmail's auto-complete \"Other Contacts\" pool (people you've emailed). Use this before gmail_send when you only have a name.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Name or email substring (e.g. "John", "acme.com").' },
        account: {
          type: 'string',
          description: 'Google account alias (from google_accounts). Omit to use the default.',
        },
      },
      required: ['query'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const query = String(args.query ?? '').trim();
    const account = args.account ? String(args.account) : undefined;
    if (!query) {
      return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true };
    }
    try {
      const hits = await searchContacts(query, account);
      const body = hits.length === 0 ? '(no matches)' : hits.map(line).join('\n');
      return { content: [{ type: 'text', text: body }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};
