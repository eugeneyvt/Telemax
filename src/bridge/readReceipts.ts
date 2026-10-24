import type { Telegraf } from 'telegraf';
import type { BridgeDatabase } from '../store/bridgeDatabase.js';
import { isConnectFailure } from './transient.js';
const description = (error: unknown) => (error as { response?: { description?: string }; message?: string })?.response?.description ?? (error as Error)?.message ?? '';
const isMessageNotModified = (error: unknown) => /message is not modified/i.test(description(error));
const isTelegramMessageMissing = (error: unknown) => /message to edit not found/i.test(description(error));

export interface ReadMark { chatId: string; userId: string; mark: number; setAsUnread: boolean; updatedAt: number }
interface ReadCard { id: number; text: string }
interface ReadReceiptDeps {
  db: BridgeDatabase; bot: Pick<Telegraf, 'telegram'>; destination: string;
  ownId(): unknown;
  topic(chatId: string): Promise<{ telegramTopicId: number; banned?: boolean } | undefined>;
  name(userId: string): Promise<string>;
}

/** MAX read markers are facts from MAX, never inferred from a Telegram delivery or page view. */
export class ReadReceipts {
  private readonly pending = new Set<string>();
  private readonly versions = new Map<string, number>();
  private flushing: Promise<void> | undefined;
  constructor(private readonly deps: ReadReceiptDeps) {
    for (const mark of deps.db.values<ReadMark>('readMarks')) this.pending.add(mark.chatId);
  }
  accept(payload: unknown): boolean {
    const p = payload as { chatId?: unknown; userId?: unknown; mark?: unknown; setAsUnread?: unknown } | null;
    if (p?.chatId == null || p.userId == null || !/^\d+$/.test(String(p.userId)) || String(p.userId) === String(this.deps.ownId())) return false;
    const mark = Number(p.mark);
    if (!Number.isSafeInteger(mark) || mark <= 0 || typeof p.setAsUnread !== 'boolean') return false;
    const chatId = String(p.chatId), userId = String(p.userId), key = `${chatId}:${userId}`;
    const old = this.deps.db.get<ReadMark>('readMarks', key);
    // Late frames cannot roll back a newer read boundary; an explicit unread toggle is retained.
    if (old && !p.setAsUnread && !old.setAsUnread && mark <= old.mark) return false;
    this.deps.db.set('readMarks', key, { chatId, userId, mark, setAsUnread: p.setAsUnread, updatedAt: Date.now() } satisfies ReadMark);
    this.pending.add(chatId);
    this.versions.set(chatId, (this.versions.get(chatId) ?? 0) + 1);
    return true;
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.run().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private async run(): Promise<void> {
    const { db, bot, destination } = this.deps;
    for (const chatId of this.pending) {
      const version = this.versions.get(chatId) ?? 0;
      const topic = await this.deps.topic(chatId);
      if (!topic || topic.banned) continue;
      const marks = db.values<ReadMark>('readMarks').filter(m => m.chatId === chatId && m.userId !== String(this.deps.ownId())).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
      const lines = await Promise.all(marks.map(async m => {
        const name = await this.deps.name(m.userId);
        const time = new Date(m.mark).toLocaleString('ru-RU', { timeZone: process.env.TZ || 'Europe/Moscow' });
        return m.setAsUnread ? `${name}: отметил(а) чат непрочитанным` : `${name}: прочитано до ${time}`;
      }));
      const text = '👁 Прочтение в MAX\n' + lines.join('\n');
      const key = `${chatId}:${topic.telegramTopicId}`;
      const prior = db.get<ReadCard>('readCards', key);
      if (prior?.text === text) { this.pending.delete(chatId); continue; }
      if (prior) {
        try { await bot.telegram.editMessageText(destination, prior.id, undefined, text); }
        catch (error) {
          if (!isMessageNotModified(error)) {
            if (!isTelegramMessageMissing(error)) throw error;
            // A confirmed missing message can be replaced safely. An unknown response cannot.
            db.delete('readCards', key);
            continue;
          }
        }
        db.set('readCards', key, { id: prior.id, text });
      } else {
        const intent = db.get<boolean>('readCardPending', key);
        if (intent) continue; // Telegram may have accepted the previous create before a lost ACK.
        db.set('readCardPending', key, true);
        try {
          const sent = await bot.telegram.sendMessage(destination, text, { message_thread_id: topic.telegramTopicId, disable_notification: true });
          db.set('readCards', key, { id: sent.message_id, text });
          db.delete('readCardPending', key);
        } catch (error) {
          const code = (error as { response?: { error_code?: number } })?.response?.error_code;
          if ((code && code >= 400 && code < 500) || isConnectFailure(error)) db.delete('readCardPending', key);
          throw error;
        }
      }
      if ((this.versions.get(chatId) ?? 0) === version) this.pending.delete(chatId);
    }
  }
}
