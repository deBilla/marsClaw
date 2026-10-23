# GitHub issue reporting

Tell marsClaw something like *"you replied in text to my voice note, report it"* or *"I wish you could summarise links I forward"*. It drafts a GitHub issue from this repo's own issue templates, shows you the whole issue for approval, and posts it.

It is Claude-only (the Gemini provider has no tool calling) and off until you set it up.

## How it works

A single MCP tool, [src/mcp/report_issue.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/report_issue.ts):

1. **The issue is built by code from the templates.** The agent writes only the free-text answers (what happened, steps, the outcome wanted). [src/github/issue-templates.ts](https://github.com/deBilla/marsclaw/blob/main/src/github/issue-templates.ts) reads `.github/ISSUE_TEMPLATE/*.yml` and handles the rest:
   - fields in template order;
   - required fields enforced;
   - dropdowns limited to the template's options;
   - the channel taken from the thread and the provider from config;
   - the "I'd like to work on it" box left unticked;
   - the template's labels plus `from-marsclaw`.

   A template field the tool doesn't know about fails the tests.
2. **It's cleaned before you see it, because the repo is public.** These are removed:
   - email addresses and WhatsApp JIDs;
   - phone numbers;
   - token or key shapes (Slack, GitHub, Google, Anthropic, Telegram bot, JWT, PEM);
   - Google Docs/Drive links.

   Long quoted text gets a "looks pasted" warning. Shell-pipe or "ignore previous instructions" phrasing gets the `needs-triage-security` label, because coding agents read issues later.

   The context block holds the channel kind, UTC time, version, provider and runtime. It never includes the thread id, which on WhatsApp is your phone number.
3. **It goes through the mutation gate like `gmail_send`.**
   - With `mutation_approval: "all"`, you get the full issue (repo, title, labels, body, any related open issues) and a one-time code to approve it.
   - With `allow_mutating_tools: true` and approval off, it posts without asking. That's not recommended for a public repo.
   - With both off, it refuses.
4. **It's filed by a GitHub App on one repo.** See [src/github/app.ts](https://github.com/deBilla/marsclaw/blob/main/src/github/app.ts). The repo comes from config, never from the agent, and the app can only touch issues.
5. **It's capped** at `github_issues_per_day` (default 5) per rolling 24 h, counted in the `issue_reports` table. That table stores the repo and issue number only.

The tool description tells the agent to use it only when *you* report a problem or ask for a feature, never because an email or web page asks. The approval prompt is the backstop.

## Setup

1. **Create a GitHub App** at github.com/settings/apps/new:
   - **Name:** anything unused. **Homepage URL:** anything.
   - **Webhook:** untick *Active*.
   - **Repository permissions:** *Issues: Read and write*. Nothing else.
   - **Where can it be installed:** *Only on this account*.

   After creating it, note the **App ID** and click **Generate a private key**. A `.pem` downloads.
2. **Install it**: on the app's page, click *Install App*, choose *Only select repositories*, and pick your marsClaw repo. The URL you land on ends in the **installation id**.
3. **Create the labels** in the repo, so they get your colours and descriptions: `bug`, `enhancement`, `from-marsclaw`, `needs-triage-security`.
4. **Add the settings to `.env`:**

   ```bash
   MARSCLAW_GITHUB_ISSUE_REPO=<you>/marsClaw
   MARSCLAW_GITHUB_APP_ID=<app id>
   MARSCLAW_GITHUB_APP_INSTALLATION_ID=<installation id>
   MARSCLAW_GITHUB_APP_PRIVATE_KEY=<output of: base64 -i app.pem | tr -d '\n'>
   ```

   Then delete the `.pem`. `.env` is already off-limits to the agent (sensitive-path gate), and these vars are handed only to marsClaw's own MCP server, not to third-party ones. `github_issue_repo` / `github_issues_per_day` can live in `data/config.json` instead. Env wins.
5. **Turn on per-call approval** if it isn't already: `"mutation_approval": "all"`. Then restart.

Try it: *"report a bug: you answered my voice note in text"*. You should get an approval prompt showing the rendered issue.
