-- GitHub issues filed by the report_issue MCP tool (src/mcp/report_issue.ts).
-- Only what's needed for the per-day cap and an audit trail: no title, no body
-- (those live on GitHub, and the repo may be public).
CREATE TABLE IF NOT EXISTS issue_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS issue_reports_created_idx ON issue_reports(created_at);
