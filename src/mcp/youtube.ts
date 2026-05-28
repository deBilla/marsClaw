// MCP tool: extract a YouTube video transcript (+ basic metadata) so the agent
// can summarize it. Summarization happens agent-side — this tool only fetches.
//
// YouTube now gates its timedtext endpoint behind a proof-of-origin token, so a
// plain fetch of the caption URL returns an empty 200. We delegate to yt-dlp,
// which handles client rotation and returns captions as JSON3, then parse that.

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

// The MCP server runs as a spawned subprocess whose PATH is often minimal (no
// Homebrew / Python-framework bin dirs), so `yt-dlp` may not resolve by name
// even when installed. Resolve an absolute path: explicit override → common
// install locations → the user's login shell. Setup pins the result into
// MARSCLAW_YTDLP_PATH so the first leg almost always wins after onboarding.
//
// Exported as a stateless helper so the setup flow can reuse the same search.
export function findYtDlpPath(): string | null {
  const candidates = [
    process.env.MARSCLAW_YTDLP_PATH,
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    join(homedir(), '.local/bin/yt-dlp'),
    '/usr/bin/yt-dlp',
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const found = execFileSync(shell, ['-lc', 'command -v yt-dlp'], {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim();
    if (found && existsSync(found)) return found;
  } catch {
    // login-shell lookup failed; fall through to "not found".
  }
  return null;
}

let cachedYtDlp: string | null | undefined;
function resolveYtDlp(): string | null {
  if (cachedYtDlp !== undefined) return cachedYtDlp;
  return (cachedYtDlp = findYtDlpPath());
}

interface Json3Event {
  tStartMs?: number;
  segs?: { utf8?: string }[];
}

/** Extract the 11-char video id from a URL or bare id. Returns null if not found. */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const id = (v: string | null) => (v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null);

  if (host === 'youtu.be') {
    return id(u.pathname.split('/')[1] ?? '');
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = id(u.searchParams.get('v'));
    if (v) return v;
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return id(m[1]!);
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const out = `${mm}:${String(sec).padStart(2, '0')}`;
  return h > 0 ? `${h}:${out}` : out;
}

function parseJson3(raw: string, timestamps: boolean): string {
  const data = JSON.parse(raw) as { events?: Json3Event[] };
  const parts: string[] = [];
  for (const ev of data.events ?? []) {
    const text = (ev.segs ?? [])
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    parts.push(timestamps ? `[${fmtTime(ev.tStartMs ?? 0)}] ${text}` : text);
  }
  return timestamps ? parts.join('\n') : parts.join(' ');
}

// Pick the best transcript file: prefer the original-language track, then the
// exact lang, then any remaining json3. yt-dlp names them <id>.<lang>.json3.
function pickSubFile(files: string[], lang: string): string | null {
  const json3 = files.filter((f) => f.endsWith('.json3'));
  return (
    json3.find((f) => f.endsWith(`.${lang}-orig.json3`)) ??
    json3.find((f) => f.endsWith(`.${lang}.json3`)) ??
    json3[0] ??
    null
  );
}

interface VideoInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  language?: string;
  subtitles?: Record<string, unknown>;
  automatic_captions?: Record<string, unknown>;
}

function readInfo(dir: string): VideoInfo | null {
  const f = readdirSync(dir).find((x) => x.endsWith('.info.json'));
  if (!f) return null;
  try {
    return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as VideoInfo;
  } catch {
    return null;
  }
}

function hasAnyCaptions(info: VideoInfo): boolean {
  return (
    Object.keys(info.subtitles ?? {}).length > 0 || Object.keys(info.automatic_captions ?? {}).length > 0
  );
}

// Best caption language to request when the preferred one didn't come through.
// Prefer a manual track, then the preferred lang, then the video's original
// language, then anything available. Returns a yt-dlp --sub-langs value or null.
function chooseLang(info: VideoInfo, preferred: string): string | null {
  const manual = Object.keys(info.subtitles ?? {});
  const auto = Object.keys(info.automatic_captions ?? {});
  const orig = (info.language ?? '').toLowerCase();
  const matches = (k: string, base: string) =>
    k.toLowerCase() === base || k.toLowerCase().startsWith(`${base}-`);
  const candidates = [
    manual.find((k) => matches(k, preferred)),
    auto.includes(`${preferred}-orig`) ? `${preferred}-orig` : undefined,
    auto.includes(preferred) ? preferred : undefined,
    orig ? manual.find((k) => matches(k, orig)) : undefined,
    orig && auto.includes(`${orig}-orig`) ? `${orig}-orig` : undefined,
    orig && auto.includes(orig) ? orig : undefined,
    manual[0],
    auto[0],
  ];
  return candidates.find((c): c is string => !!c) ?? null;
}

// Run yt-dlp to write the requested caption languages (+ info.json) into `dir`.
// Returns null on success, 'enoent' if yt-dlp is missing, else a short reason.
async function downloadSubs(ytdlp: string, dir: string, url: string, langs: string): Promise<string | null> {
  try {
    await execFileP(
      ytdlp,
      [
        '--skip-download',
        '--ignore-no-formats-error',
        '--no-warnings',
        '--no-playlist',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        langs,
        '--sub-format',
        'json3',
        '--write-info-json',
        '--extractor-args',
        'youtube:player_client=ios,android,web',
        '-o',
        join(dir, '%(id)s.%(ext)s'),
        url,
      ],
      { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT/.test(msg)) return 'enoent';
    return msg.match(/ERROR:.*/)?.[0] ?? msg.slice(0, 200);
  }
}

export const youtubeTranscriptTool = {
  definition: {
    name: 'youtube_transcript',
    description:
      'Fetch the transcript and basic metadata (title, channel, duration) of a YouTube video from a URL or video id. Returns the raw transcript text — after calling this, SUMMARIZE it for the user (key points / takeaways); do not paste the full transcript back. Works for videos that have captions (manual or auto-generated). Returns a clear error if the video has no captions or is unavailable.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'YouTube URL (watch, youtu.be, shorts, embed, live) or a bare 11-char video id.',
        },
        lang: {
          type: 'string',
          description:
            'Preferred caption language code (default "en"). Falls back to whatever captions exist.',
        },
        timestamps: { type: 'boolean', description: 'Include [mm:ss] markers per segment (default false).' },
        max_chars: { type: 'number', description: 'Cap on returned transcript characters (default 100000).' },
      },
      required: ['url'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const raw = String(args.url ?? '').trim();
    const lang = (String(args.lang ?? 'en').trim() || 'en').toLowerCase();
    const timestamps = args.timestamps === true;
    const maxChars = clamp(Number(args.max_chars ?? 100000), 1000, 500000);

    const err = (text: string) => ({ content: [{ type: 'text', text }], isError: true });

    if (!raw) return err('Error: url is required');
    const videoId = parseVideoId(raw);
    if (!videoId) return err(`Error: could not find a YouTube video id in "${raw}"`);

    const ytdlp = resolveYtDlp();
    if (!ytdlp) {
      return err(
        'yt-dlp was not found. Install it (`brew install yt-dlp` or `pip install yt-dlp`), or set MARSCLAW_YTDLP_PATH to its full path.',
      );
    }

    const dir = mkdtempSync(join(tmpdir(), 'marsclaw-yt-'));
    try {
      // videoId is validated to [A-Za-z0-9_-]{11}, so the URL is safe to build.
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const preferred = `${lang}-orig,${lang}`;

      let runErr = await downloadSubs(ytdlp, dir, url, preferred);
      if (runErr === 'enoent') {
        return err(
          'yt-dlp was not found. Install it (`brew install yt-dlp` or `pip install yt-dlp`), or set MARSCLAW_YTDLP_PATH to its full path.',
        );
      }
      let subFile = pickSubFile(readdirSync(dir), lang);

      // Nothing came through. The ios/android caption API is intermittently
      // empty, and the video may only have non-English tracks. Retry once: with
      // a different language if the inventory names one, else the same request.
      if (!subFile) {
        const info = readInfo(dir);
        if (info) {
          const alt = hasAnyCaptions(info) ? chooseLang(info, lang) : null;
          runErr = await downloadSubs(ytdlp, dir, url, alt ?? preferred);
          subFile = pickSubFile(readdirSync(dir), lang);
        }
      }

      if (!subFile) {
        const info = readInfo(dir);
        if (!info) {
          const reason = runErr && runErr !== 'enoent' ? ` (${runErr})` : '';
          return err(
            `Couldn't access this video — it may be private, unavailable, or the URL is wrong.${reason}`,
          );
        }
        return err(
          hasAnyCaptions(info)
            ? 'This video has captions, but YouTube returned no transcript data (often a transient hiccup). Try again in a moment.'
            : 'No transcript available for this video (no captions, manual or auto-generated).',
        );
      }

      const transcript = parseJson3(readFileSync(join(dir, subFile), 'utf-8'), timestamps);
      if (!transcript.trim()) return err('The caption track was empty.');

      let title = videoId;
      let author = 'unknown';
      let dur = '?';
      const info = readInfo(dir);
      if (info) {
        title = info.title ?? title;
        author = info.uploader ?? info.channel ?? author;
        if (typeof info.duration === 'number') dur = fmtTime(info.duration * 1000);
      }

      const subLang =
        subFile
          .replace(/\.json3$/, '')
          .split('.')
          .pop() ?? lang;
      const header = `# ${title} — ${author} · ${dur} · lang=${subLang} · ${videoId}`;
      const body =
        transcript.length > maxChars
          ? `${transcript.slice(0, maxChars)}\n... (truncated, total ${transcript.length} chars)`
          : transcript;

      return { content: [{ type: 'text', text: `${header}\n\n${body}` }] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
