export interface Channel {
  send(threadId: string, text: string): Promise<void>;
}

export interface ChannelInit {
  onMessage(threadId: string, text: string): Promise<void> | void;
}
