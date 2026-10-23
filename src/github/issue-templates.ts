// GitHub issue drafts that follow the repo's own issue templates. Pure apart
// from reading the template files once.
//
// The REST API can't submit an issue FORM, only title/body/labels. So the body
// is rendered here, field by field, in the same Markdown a submitted form
// produces ("### <label>\n\n<value>"), from .github/ISSUE_TEMPLATE/*.yml. The
// agent writes the free-text answers; code decides everything else: template
// order, required fields, valid dropdown values, labels, channel and provider.
//
// The repo is PUBLIC, so the template rule ("don't paste message contents,
// tokens, phone numbers or other people's data") is enforced deterministically:
// addresses, phone numbers, secret-shaped strings and Google file links are
// redacted, and injection-style text gets a security-triage label, because
// issues get handed to coding agents later.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { YAML } from 'bun';

export const TEMPLATE_DIR = join(import.meta.dir, '..', '..', '.github', 'ISSUE_TEMPLATE');

export const KIND_FILES = { bug: 'bug_report.yml', feature: 'feature_request.yml' } as const;
export type IssueKind = keyof typeof KIND_FILES;

/** Template field id → the report_issue argument that fills it. "@…" = filled by
 *  code, not the agent. tests/github-issue.test.ts fails when a template gains a
 *  field that isn't mapped here, so a template edit can't silently drop a field. */
export const FIELD_SOURCES: Record<IssueKind, Record<string, string>> = {
  bug: {
    channel: '@channel',
    provider: '@provider',
    what: 'details',
    repro: 'steps',
    contribute: '@unchecked',
  },
  feature: { problem: 'details', kind: 'change_type', data: 'systems', contribute: '@unchecked' },
};

/** Thread-id prefix → the bug template's "Where did it happen?" option. */
export const CHANNEL_OPTIONS: Record<string, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
};

export const PROVIDER_OPTIONS: Record<string, string> = { claude: 'Claude', gemini: 'Gemini' };

export const MARSCLAW_LABEL = 'from-marsclaw';
export const SECURITY_LABEL = 'needs-triage-security';
export const NO_RESPONSE = '_No response_'; // what GitHub renders for an empty optional field

const TITLE_MAX = 120;
const FIELD_MAX = 2000; // the whole body goes into the approval prompt, so keep it readable
const PASTED_QUOTE_CHARS = 400;
const PASTED_LINE_CHARS = 600;

export interface TemplateField {
  id: string;
  type: string;
  label: string;
  required: boolean;
  options: string[];
}

export interface Template {
  labels: string[];
  fields: TemplateField[];
}

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
  missing: string[]; // labels of empty required fields
  redactions: string[]; // what was removed
  warnings: string[]; // what the operator should check before approving
}

interface RawItem {
  type: string;
  id?: string;
  attributes?: { label?: string; options?: (string | { label: string })[] };
  validations?: { required?: boolean };
}

const cache = new Map<IssueKind, Template>();

export function loadTemplate(kind: IssueKind): Template {
  const hit = cache.get(kind);
  if (hit) return hit;
  const data = YAML.parse(readFileSync(join(TEMPLATE_DIR, KIND_FILES[kind]), 'utf8')) as {
    labels?: string[];
    body?: RawItem[];
  };
  const fields: TemplateField[] = [];
  for (const item of data.body ?? []) {
    if (item.type === 'markdown' || !item.id) continue;
    fields.push({
      id: item.id,
      type: item.type,
      label: item.attributes?.label ?? item.id,
      required: Boolean(item.validations?.required),
      options: (item.attributes?.options ?? []).map((o) => (typeof o === 'string' ? o : o.label)),
    });
  }
  const tpl = { labels: data.labels ?? [], fields };
  cache.set(kind, tpl);
  return tpl;
}

/** The dropdown option `value` names, else "Not sure": never a free-text value
 *  the form itself could not have produced. */
export function pickOption(value: string, options: string[]): string {
  const v = value.trim().toLowerCase();
  if (v) {
    const exact = options.find((o) => o.toLowerCase() === v);
    if (exact) return exact;
    const prefix = options.find(
      (o) => o.toLowerCase().startsWith(v) || v.startsWith(o.toLowerCase().split(' (')[0]!),
    );
    if (prefix) return prefix;
  }
  return options.find((o) => o.toLowerCase() === 'not sure') ?? NO_RESPONSE;
}

// ── template-rule enforcement ────────────────────────────────────────────────

const SECRET_RES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access tokens
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, // Anthropic / OpenAI keys
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g, // JWTs
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, // Telegram bot tokens
];
const GOOGLE_FILE_RE = /https?:\/\/(?:docs|drive|sheets|slides)\.google\.com\/\S+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g; // also catches WhatsApp JIDs
const PHONE_RE = /(?<![\w.])\+?\d[\d\s().-]{7,}\d(?![\w.])/g;

function isPhoneLike(m: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}/.test(m.trim())) return false;
  return (m.match(/\d/g) ?? []).length >= 9;
}

/** Remove what the template forbids in a public issue. Returns the text and what was removed. */
export function redact(text: string): { text: string; found: string[] } {
  const found = new Set<string>();
  let out = text;
  const sub = (re: RegExp, repl: (m: string) => string, label: string) => {
    const next = out.replace(re, repl);
    if (next !== out) found.add(label);
    out = next;
  };
  for (const re of SECRET_RES) sub(re, () => '[secret redacted]', 'a token or key');
  sub(GOOGLE_FILE_RE, () => '[Google file link redacted]', 'Google file links');
  sub(EMAIL_RE, () => '[address redacted]', 'email addresses');
  // A phone number has 9+ digits; dates and times ("2026-10-23 10:30") are left alone.
  sub(PHONE_RE, (m) => (isPhoneLike(m) ? '[number redacted]' : m), 'phone numbers');
  return { text: out, found: [...found].sort() };
}

// Same shapes the Habibi coding-prompt guard flags: things a coding agent must not
// run because a public issue told it to.
const RISK_PATTERNS: [string, RegExp][] = [
  ['pipes a download into a shell', /\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i],
  ['downloads with curl/wget', /\b(?:curl|wget)\b[^\n]{0,200}?https?:\/\//i],
  ['runs an inline interpreter command', /\b(?:bash|sh|zsh|python3?|node|bun|perl)\s+-[ce]\b/i],
  ['recursive force delete', /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/i],
  ['touches SSH keys', /~\/\.ssh|\bauthorized_keys\b|\bid_(?:rsa|ed25519|ecdsa)\b/i],
  ['reads env secrets', /\bprintenv\b|\bcat\s+[^\n]{0,40}\.env\b|\benv\s*\|/i],
  ['decodes an encoded payload', /\bbase64\s+(?:-d|--decode)\b|\batob\(/i],
  ['contains a long encoded blob', /[A-Za-z0-9+/]{160,}={0,2}/],
  [
    'tries to override instructions',
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|messages?)/i,
  ],
];

export function scanRisks(text: string): string[] {
  return RISK_PATTERNS.filter(([, re]) => re.test(text)).map(([reason]) => reason);
}

function looksPasted(text: string): boolean {
  const lines = text.split('\n');
  const quoted = lines.filter((l) => l.trimStart().startsWith('>')).reduce((n, l) => n + l.length, 0);
  return quoted > PASTED_QUOTE_CHARS || lines.some((l) => l.length > PASTED_LINE_CHARS);
}

// ── render ───────────────────────────────────────────────────────────────────

export interface BuildArgs {
  kind: IssueKind;
  title: string;
  args: Record<string, string>; // tool argument name → the agent's text
  channel: string; // thread-id prefix: telegram | slack | whatsapp | ''
  provider: string; // claude | gemini
  context: string[]; // content-free lines added by code
}

/** Render a template-conformant issue from the tool's arguments. Everything the
 *  agent wrote is redacted and scanned; the context block is ours and isn't. */
export function buildIssue({ kind, title, args, channel, provider, context }: BuildArgs): IssueDraft {
  const tpl = loadTemplate(kind);
  const sources = FIELD_SOURCES[kind];
  const redactions = new Set<string>();
  const agentText: string[] = [];

  const t = redact(title.split(/\s+/).filter(Boolean).join(' ').slice(0, TITLE_MAX));
  t.found.forEach((f) => redactions.add(f));
  agentText.push(t.text);

  const sections: string[] = [];
  const missing: string[] = [];
  for (const f of tpl.fields) {
    const source = sources[f.id] ?? '';
    let value: string;
    if (f.type === 'checkboxes') {
      value = f.options.map((o) => `- [ ] ${o}`).join('\n');
    } else if (f.type === 'dropdown') {
      const wanted =
        source === '@channel'
          ? (CHANNEL_OPTIONS[channel] ?? '')
          : source === '@provider'
            ? (PROVIDER_OPTIONS[provider] ?? '')
            : (args[source] ?? '');
      value = pickOption(wanted, f.options);
    } else {
      const r = redact((args[source] ?? '').trim().slice(0, FIELD_MAX));
      r.found.forEach((x) => redactions.add(x));
      if (r.text) agentText.push(r.text);
      else if (f.required) missing.push(f.label);
      value = r.text || NO_RESPONSE;
    }
    sections.push(`### ${f.label}\n\n${value}`);
  }
  if (context.length) sections.push(`### marsClaw context\n\n${context.map((l) => `- ${l}`).join('\n')}`);

  const labels = [...tpl.labels, MARSCLAW_LABEL];
  const warnings: string[] = [];
  if (agentText.some(looksPasted)) {
    warnings.push('This looks like pasted content — check it describes the problem, not the data.');
  }
  const risks = scanRisks(agentText.join('\n'));
  if (risks.length) {
    warnings.push(`Flagged for security triage — it ${risks.slice(0, 3).join(', ')}.`);
    labels.push(SECURITY_LABEL);
  }

  return {
    title: t.text,
    body: sections.join('\n\n') + '\n',
    labels,
    missing,
    redactions: [...redactions].sort(),
    warnings,
  };
}
