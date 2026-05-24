// HTTP client for the local Whisper sidecar.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const WHISPER_URL = process.env.WHISPER_URL ?? 'http://127.0.0.1:9000';
const KOKORO_URL = process.env.KOKORO_URL ?? 'http://127.0.0.1:9001';
const KOKORO_VOICE = process.env.KOKORO_VOICE ?? 'af_heart';
const KOKORO_FORMAT = process.env.KOKORO_FORMAT ?? 'ogg';

export async function whisperHealthy(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

export async function kokoroHealthy(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${KOKORO_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

export async function synthesize(text: string, voice = KOKORO_VOICE): Promise<Buffer> {
  const res = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, voice, response_format: KOKORO_FORMAT }),
  });
  if (!res.ok) {
    throw new Error(`kokoro /v1/audio/speech ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export const KOKORO_OUTPUT_FORMAT = KOKORO_FORMAT;

export async function transcribe(audioPath: string): Promise<string> {
  const buffer = await readFile(audioPath);
  // Bun supports the standard Web FormData/Blob with bytes.
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)]), basename(audioPath));

  const res = await fetch(`${WHISPER_URL}/transcribe`, { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`whisper /transcribe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
