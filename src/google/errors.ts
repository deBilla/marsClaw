// Shared error formatting for the Google MCP tools. Centralizes the two cases
// every tool needs: "not connected" (no stored token) and "needs reconnecting"
// (the refresh token is dead — invalid_grant — which can't auto-recover and
// requires interactive re-consent on the host). Everything else passes through
// with the service name prefixed.

export function googleErrorMessage(err: unknown, service: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/No stored credentials|No Google accounts/.test(msg)) {
    return `${service} not connected: ${msg}`;
  }
  // invalid_grant = the stored refresh token is expired/revoked. Auto-refresh
  // can't fix it; the operator must re-authorize. Common cause: the OAuth
  // consent screen is in "Testing" status (refresh tokens expire after 7 days).
  if (/invalid_grant|Token has been expired or revoked|unauthorized_client/i.test(msg)) {
    return (
      `${service} needs reconnecting — the Google authorization expired (invalid_grant). ` +
      `Tell the user to run \`bun run google login\` on the host to re-authorize; ` +
      `do not retry. (If it keeps expiring, publish the Google OAuth consent screen to "Production".)`
    );
  }
  return `${service} error: ${msg}`;
}
