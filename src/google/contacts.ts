// Contacts via Google People API. Searches both your own contacts and the
// "Other Contacts" pool — the auto-complete list Gmail builds from people
// you've emailed. That second source is the one that actually answers
// "what's John's email?" for most names.

import { peopleClient } from './clients.ts';

export interface Contact {
  name: string;
  emails: string[];
  phones: string[];
}

export async function searchContacts(query: string, account?: string): Promise<Contact[]> {
  const p = peopleClient(account);
  const readMask = 'names,emailAddresses,phoneNumbers';

  // Both endpoints need a warm-up call before they return results — the API
  // builds a search index on the first call. We do one paired call; if it's
  // cold the model will see "(no matches)" and can retry.
  const [own, other] = await Promise.all([
    p.people.searchContacts({ query, readMask, pageSize: 20 }).catch(() => null),
    p.otherContacts.search({ query, readMask, pageSize: 20 }).catch(() => null),
  ]);

  const out: Contact[] = [];
  const seen = new Set<string>();

  const push = (person: {
    names?: Array<{ displayName?: string | null }> | null;
    emailAddresses?: Array<{ value?: string | null }> | null;
    phoneNumbers?: Array<{ value?: string | null }> | null;
  }) => {
    const name = person.names?.[0]?.displayName ?? '';
    const emails = (person.emailAddresses ?? []).map((e) => e.value ?? '').filter(Boolean);
    const phones = (person.phoneNumbers ?? []).map((e) => e.value ?? '').filter(Boolean);
    const key = `${name}|${emails.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!name && emails.length === 0) return;
    out.push({ name, emails, phones });
  };

  for (const r of own?.data.results ?? []) if (r.person) push(r.person);
  for (const r of other?.data.results ?? []) if (r.person) push(r.person);
  return out;
}
