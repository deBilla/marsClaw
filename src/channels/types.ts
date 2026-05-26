export interface SendOpts {
  /** Absolute path to an audio file (e.g. ogg/opus). When set, the channel
   *  sends a voice/audio message; the text is the spoken transcript (kept for
   *  history and used as a fallback on channels without audio support). */
  audioPath?: string;
  /** Absolute path to a document/image/file to send alongside the text. The
   *  channel decides the appropriate attachment mode (image, document, etc.)
   *  based on the file's extension/mime. `text` becomes the caption. */
  filePath?: string;
  /** Optional display name override for the file (defaults to basename). */
  fileName?: string;
}

export interface Channel {
  send(threadId: string, text: string, opts?: SendOpts): Promise<void>;
  /** Best-effort "typing…" signal. Channels that don't support it can be a
   *  no-op; expirations vary (Telegram ~5s, WhatsApp ~10s) so callers
   *  generally re-fire on a short interval while work is in progress. */
  setTyping?(threadId: string): Promise<void>;
}

export interface ChannelInit {
  onMessage(threadId: string, text: string): Promise<void> | void;
}
