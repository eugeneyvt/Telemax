import type { BridgeDatabase } from '../store/bridgeDatabase.js';
export interface RelayedReaction { chatId: unknown; messageId: unknown; emoji: string }

/** Removal polling must survive a process restart, as the Telegram reaction does. */
export class ReactionStore extends Map<string, RelayedReaction> {
  constructor(private readonly db?: BridgeDatabase) {
    super();
    for (const item of db?.values<RelayedReaction>('relayedReactions') ?? []) super.set(`${String(item.chatId)}:${String(item.messageId)}`, item);
  }
  override set(key: string, value: RelayedReaction): this {
    this.db?.set('relayedReactions', key, value);
    return super.set(key, value);
  }
  override delete(key: string): boolean {
    this.db?.delete('relayedReactions', key);
    return super.delete(key);
  }
  override clear(): void { this.db?.clearKind('relayedReactions'); super.clear(); }
}
