export interface SendOpts {
  /** Absolute path to an audio file (e.g. ogg/opus). When set, the channel
   *  sends a voice/audio message; the text is the spoken transcript (kept for
   *  history and used as a fallback on channels without audio support). */
  audioPath?: string;
}

export interface Channel {
  send(threadId: string, text: string, opts?: SendOpts): Promise<void>;
}

export interface ChannelInit {
  onMessage(threadId: string, text: string): Promise<void> | void;
}
