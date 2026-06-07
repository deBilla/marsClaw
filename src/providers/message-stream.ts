// Push-based async iterable of SDK user messages, shared by both Claude
// runtimes: the in-process session (claude-sdk.ts) and the container
// agent-service. Each warm session owns one. push() queues a turn; the SDK
// consumes them in order; end() closes the iterator.
//
// The session classes themselves stay separate (they differ in MCP wiring,
// capability gating, and DB access), but this queueing primitive was byte-for-
// byte identical in both, so it lives here.

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export class MessageStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}
