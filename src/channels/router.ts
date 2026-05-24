// Multi-channel router. Each channel adapter writes thread IDs prefixed with
// its name (e.g. `telegram:123`, `slack:C123`, `whatsapp:1234@s.whatsapp.net`)
// — the router uses that prefix to dispatch outbound sends to the right adapter.

import type { Channel, SendOpts } from './types.ts';

export class ChannelRouter implements Channel {
  private channels = new Map<string, Channel>();

  register(prefix: string, channel: Channel): void {
    this.channels.set(prefix, channel);
  }

  has(prefix: string): boolean {
    return this.channels.has(prefix);
  }

  list(): string[] {
    return [...this.channels.keys()];
  }

  async send(threadId: string, text: string, opts?: SendOpts): Promise<void> {
    const prefix = threadId.split(':', 1)[0];
    const channel = this.channels.get(prefix);
    if (!channel) {
      throw new Error(`No channel registered for prefix "${prefix}" (threadId=${threadId})`);
    }
    await channel.send(threadId, text, opts);
  }
}
