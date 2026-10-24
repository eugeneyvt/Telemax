import type { Telegraf } from 'telegraf';
import type { BridgeDatabase } from '../store/bridgeDatabase.js';
import { isConnectFailure, withFloodRetry } from './transient.js';
import { participantReadMarks } from './receiptDetails.js';
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
  latestOutgoing?(chatId: string): Promise<{ time: number; telegramId: number } | undefined>;
}

/** MAX read markers are facts from MAX, never inferred from a Telegram delivery or page view. */
export class ReadReceipts {
  private readonly pending = new Set<string>();
  private readonly versions = new Map<string, number>();
  private flushing: Promise<void> | undefined;
  constructor(private readonly deps: ReadReceiptDeps) {
    for (const mark of deps.db.values<ReadMark>('readMarks')) this.pending.add(mark.chatId);
    for (const item of deps.db.values<{ chatId: string }>('receiptChats')) this.pending.add(item.chatId);
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
  seed(chat: unknown): void {
    const chatId = (chat as { id?: unknown } | null)?.id;
    if (chatId == null) return;
    for (const p of participantReadMarks(chat, this.deps.ownId())) {
      const old = this.deps.db.get<ReadMark>('readMarks', `${chatId}:${p.userId}`);
      if (!old || p.mark > old.mark) this.accept({ chatId, ...p, setAsUnread: false });
    }
  }
  touch(chatId: unknown): void {
    const key = String(chatId); this.deps.db.set('receiptChats', key, { chatId: key }); this.pending.add(key); this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.run().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private async run(): Promise<void> {
    const { db, bot, destination } = this.deps;
    let failure: unknown;
    for (const chatId of this.pending) {
      try {
      const version = this.versions.get(chatId) ?? 0;
      const topic = await this.deps.topic(chatId);
      if (!topic || topic.banned) continue;
      const marks = db.values<ReadMark>('readMarks').filter(m => m.chatId === chatId && m.userId !== String(this.deps.ownId())).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
      const lines = await Promise.all(marks.map(async m => {
        const name = await this.deps.name(m.userId);
        const time = new Date(m.mark).toLocaleString('ru-RU', { timeZone: process.env.TZ || 'Europe/Moscow' });
        return m.setAsUnread ? `${name}: отметил(а) чат непрочитанным` : `${name}: прочитано до ${time}`;
      }));
      const latest = await this.deps.latestOutgoing?.(chatId);
      let latestLine = '';
      if (latest) {
        const readers = await Promise.all(marks.filter(m => m.mark >= latest.time && !m.setAsUnread).map(m => this.deps.name(m.userId)));
        const url = destination.startsWith('-100') ? `https://t.me/c/${destination.slice(4)}/${latest.telegramId}` : '';
        latestLine = `\n\nПоследнее исходящее${url ? `: ${url}` : ''}\n${readers.length ? `✓ Прочитано в MAX: ${readers.join(', ')}` : '✓ Есть в MAX · подтверждения прочтения пока нет'}\nДля статуса конкретного сообщения — /receipt ответом на него. Прослушивание отдельно не подтверждается.`;
      }
      const text = '👁 Прочтение в MAX\n' + (lines.join('\n') || 'Подтверждённых отметок от других участников пока нет.') + latestLine;
      const key = `${chatId}:${topic.telegramTopicId}`;
      const prior = db.get<ReadCard>('readCards', key);
      if (prior?.text === text) { this.pending.delete(chatId); continue; }
      if (prior) {
        try { await withFloodRetry(() => bot.telegram.editMessageText(destination, prior.id, undefined, text)); }
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
          const sent = await withFloodRetry(() => bot.telegram.sendMessage(destination, text, { message_thread_id: topic.telegramTopicId, disable_notification: true }));
          db.set('readCards', key, { id: sent.message_id, text });
          db.delete('readCardPending', key);
        } catch (error) {
          const code = (error as { response?: { error_code?: number } })?.response?.error_code;
          if ((code && code >= 400 && code < 500) || isConnectFailure(error)) db.delete('readCardPending', key);
          throw error;
        }
      }
      if ((this.versions.get(chatId) ?? 0) === version) this.pending.delete(chatId);
      } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
