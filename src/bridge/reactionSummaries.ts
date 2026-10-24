import type { Telegraf } from 'telegraf';
import type { BridgeDatabase } from '../store/bridgeDatabase.js';

export interface ReactionSummary { key: string; chatId: string; maxMessageId: unknown; topicId: number; messageId?: number; text: string; active: boolean; dirty: boolean }
type Counter = { reaction: string; count: number };
export class ReactionSummaries {
  private readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly db: BridgeDatabase, private readonly bot: Telegraf, private readonly destination: string,
    private readonly create: (record: ReactionSummary) => Promise<number>) {}
  active(): ReactionSummary[] { return this.db.values<ReactionSummary>('reactionSummaries').filter(r => r.active); }
  watch(chatId: unknown, maxMessageId: unknown, topicId: number): void {
    const key = `${String(chatId)}:${String(maxMessageId)}`;
    if (!this.db.get('reactionSummaries', key)) this.db.set('reactionSummaries', key, { key, chatId: String(chatId), maxMessageId, topicId, text: '', active: true, dirty: false } satisfies ReactionSummary);
  }
  async update(chatId: unknown, maxMessageId: unknown, topicId: number, counters: Counter[]): Promise<void> {
    const key = `${String(chatId)}:${String(maxMessageId)}`;
    const existing = this.db.get<ReactionSummary>('reactionSummaries', key);
    const active = counters.some(c => c.count > 0);
    if (!existing && !active) return;
    const text = active ? 'Реакции MAX: ' + counters.filter(c => c.count > 0).map(c => `${c.reaction} × ${c.count}`).join(' · ') : 'Реакций MAX больше нет.';
    if (existing?.text === text && !existing.dirty) return;
    this.db.set('reactionSummaries', key, { ...existing, key, chatId: String(chatId), maxMessageId, topicId, text, active, dirty: true } satisfies ReactionSummary);
    await this.draw(key);
  }
  async flush(): Promise<void> { for (const record of this.db.values<ReactionSummary>('reactionSummaries')) if (record.dirty) await this.draw(record.key); }
  private draw(key: string): Promise<void> {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const record = this.db.get<ReactionSummary>('reactionSummaries', key);
      if (!record?.dirty) return;
      let id = record.messageId;
      if (id != null) {
        try { await this.bot.telegram.editMessageText(this.destination, id, undefined, record.text); }
        catch (error) {
          const message = (error as Error).message;
          if (/message to edit not found/i.test(message)) id = undefined;
          else if (!/message is not modified/i.test(message)) throw error;
        }
      }
      if (id == null) id = await this.create(record);
      const latest = this.db.get<ReactionSummary>('reactionSummaries', key)!;
      this.db.set('reactionSummaries', key, { ...latest, messageId: id, dirty: latest.text !== record.text });
    });
    this.writes.set(key, run);
    void run.finally(() => { if (this.writes.get(key) === run) this.writes.delete(key); }).catch(() => {});
    return run;
  }
}
