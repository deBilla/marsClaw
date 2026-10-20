# Google integration

A small suite of MCP tools lets the agent talk to your Google account: Gmail, Calendar, Contacts, Drive, Sheets, Docs, Slides. Refresh tokens live in the macOS Keychain (or 0600 files under `data/secrets/` on other platforms), never in `.env` or the database.

## One-time setup

1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials).
2. **Create credentials → OAuth client ID → Desktop app.**
3. Copy the client ID + secret into `.env`:
   ```env
   GOOGLE_OAUTH_CLIENT_ID=…
   GOOGLE_OAUTH_CLIENT_SECRET=…
   ```
4. Enable the APIs you'll use (Gmail, Calendar, Drive, Sheets, Docs, Slides, People).
5. Add yourself as a test user under the OAuth consent screen (or publish the app).
6. Log in:
   ```bash
   bun run google login            # alias "default"
   bun run google login work       # named alias
   bun run google login work --scope https://www.googleapis.com/auth/gmail.modify   # custom scopes (repeatable)
   ```

The browser will pop up; finish the consent flow. A refresh token is stored in Keychain (service `marsclaw`) under `google-refresh-token:<alias>`, its scopes under `google-scopes:<alias>`, and the account index under `google-accounts`.

Default scopes requested: `gmail.readonly`, `gmail.send`, `calendar`, `drive`, `spreadsheets`, `presentations`, `documents`, `contacts.readonly`, `contacts.other.readonly`.

## Multiple accounts

```bash
bun run google login personal
bun run google login work
bun run google list          # linked aliases; * marks the default
bun run google use work      # change the default
bun run google status [alias]   # granted scopes for an account
bun run google logout work   # forget one
bun run google test [alias]  # list 5 recent Gmail messages
```

`bun run google` with no subcommand runs `list`. All MCP tools accept an optional `account` argument; if omitted the default alias is used (or the only account, if there's just one).

## Available tools

Defined in [src/mcp/](https://github.com/deBilla/marsclaw/blob/main/src/mcp/) and registered in [build-server.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/build-server.ts). The bot wires the MCP server into every Claude session itself (stdio in-process, HTTP in container mode); [.mcp.json](https://github.com/deBilla/marsclaw/blob/main/.mcp.json) only exposes it to the `claude` CLI when you work in this repo. The Gemini provider has no tool access.

| Tool | Source | What it does |
|---|---|---|
| `gmail_recent`     | [gmail.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/gmail.ts)    | List recent inbox messages |
| `gmail_search`     | [gmail.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/gmail.ts)    | Search Gmail with the standard query language |
| `gmail_get`        | [gmail.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/gmail.ts)    | Fetch a specific message (headers + body) |
| `gmail_send`       | [gmail.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/gmail.ts)    | Compose and send — **mutation-gated** |
| `contacts_search`  | [contacts.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/contacts.ts) | Resolve a name to email/phone |
| `calendar_list_events` | [calendar.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/calendar.ts) | List events in a time range |
| `calendar_create_event` | [calendar.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/calendar.ts) | Create an event — **mutation-gated** |
| `calendar_raw`     | [calendar.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/calendar.ts) | Raw HTTP escape hatch to the Calendar API |
| `drive_search`     | [drive.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/drive.ts)    | Search Drive by name/mime/owner |
| `drive_read`       | [drive.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/drive.ts)    | Read a file's content (export as text if it's a Google doc) |
| `drive_raw`        | [drive.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/drive.ts)    | Raw HTTP escape hatch |
| `sheets_read`      | [sheets.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/sheets.ts)  | Read a range of cells |
| `sheets_write`     | [sheets.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/sheets.ts)  | Write a range of cells — **mutation-gated** |
| `sheets_raw`       | [sheets.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/sheets.ts)  | Raw HTTP escape hatch |
| `docs_read`        | [docs.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/docs.ts)      | Read a Google Doc as text |
| `docs_raw`         | [docs.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/docs.ts)      | Raw HTTP escape hatch |
| `slides_read`      | [slides.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/slides.ts)  | Read a Google Slides deck |
| `slides_raw`       | [slides.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/slides.ts)  | Raw HTTP escape hatch |
| `google_accounts`  | [google_accounts.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/google_accounts.ts) | List linked aliases + default |

Each "raw" tool is a thin pass-through to a googleapis method (e.g. `events.patch`) with auth bolted on. They exist so the agent can do things we haven't wrapped without you having to add a new TypeScript tool. Raw calls whose method leaf is a write verb (`create`, `insert`, `update`, `patch`, `delete`, `batchUpdate`, `append`, `copy`, `trash`, `move`, `clear`, …) go through the mutation gate; reads (`list`, `get`, `export`, …) always pass.

### Mutation gate

By default (`allow_mutating_tools: false`) every mutating call refuses with a message telling the user how to enable it. Set `allow_mutating_tools: true` to allow them all, or `mutation_approval: "all"` to require a per-call approval: the bot sends you a structured summary plus a one-time code (`ok-XXXXXX`) and the call proceeds only if you reply with that code within 2 minutes. The container runtime forces per-call approval. Details in [security.md](security.md).

## Scopes

Scopes granted per account are stored alongside the refresh token (`google-scopes:<alias>`). Adding a new tool may require re-logging in to grant new scopes:

```bash
bun run google logout personal
bun run google login personal
```

## Security model

- Refresh tokens never enter `.env` or the SQLite DB.
- The MCP server receives only the OAuth **client** ID/secret via env passthrough — the refresh token is read from Keychain on demand inside the tool handler. The agent's file tools can't read `data/secrets/` (sensitive-path guard).
- Access tokens are fetched from Google at call time, used once, discarded.
- The token storage layer ([src/google/keychain.ts](https://github.com/deBilla/marsclaw/blob/main/src/google/keychain.ts)) uses the macOS `security` CLI; on other platforms it falls back to `data/secrets/<key>.txt` with mode 0600.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_grant` | Refresh token revoked (you removed access from [myaccount.google.com/permissions](https://myaccount.google.com/permissions)) | `bun run google login <alias>` |
| `insufficient_scope` | Tool needs a scope you didn't grant | logout + login again |
| `Quota exceeded` | Daily project-level quota in Google Cloud | Bump quota in console, or wait |
| `No Google accounts connected` | Never logged in | `bun run google login` |
| `Unknown Google account "<alias>"` | Typo / not logged in | `bun run google list` |
| `Refused: "gmail_send" … disabled by default` | Mutation gate | See *Mutation gate* above |
