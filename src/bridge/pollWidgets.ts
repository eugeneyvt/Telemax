import { createHash } from 'node:crypto';
import type { Telegraf, Context } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import type { BridgeDatabase } from '../store/bridgeDatabase.js';
import type { MaxClient } from '../max/client.js';
import type { MaxAttachment } from './attachments.js';
import { truncateUtf16 } from './text.js';
import { currentDelivery } from './deliveryQueue.js';
import { withFloodRetry } from './transient.js';

export function pollVoteRestriction(poll: MaxAttachment): string | undefined {
  if ((poll.settings ?? 0) & 8) return 'Опрос закрыт в MAX.';
  if (!((poll.settings ?? 0) & 4) && poll.state?.result?.some(r => (r.options ?? 0) & 1)) return 'Голос уже принят. Автор опроса запретил изменение и снятие голоса.';
  return undefined;
}

export interface PollWidget { key: string; chatId: string; maxMessageId: unknown; topicId: number; poll: MaxAttachment; messageId?: number; draft: number[]; page: number; dirty?: boolean }
export const POLL_CALLBACK = /^tlmx_poll:([a-f0-9]{16}):(i\d+|p\d+|s|r|c)$/;
export function renderPollWidget(record: PollWidget): { text: string; reply_markup: InlineKeyboardMarkup } {
  const { poll } = record;
  const restriction = pollVoteRestriction(poll);
  const start = record.page * 8;
  const answers = (poll.answers ?? []).slice(start, start + 8);
  const rows = answers.map((a, index) => {
    const result = poll.state?.result?.find(r => String(r.answerId) === String(a.answerId));
    const selected = record.draft.includes(index + start);
    return [{ text: `${selected ? '☑️' : '▫️'} ${truncateUtf16(a.text ?? '—', 60)} · ${result?.voteCount ?? 0}`, callback_data: `tlmx_poll:${record.key}:i${start + index}` }];
  });
  if ((poll.answers?.length ?? 0) > 8) rows.push([
    ...(record.page > 0 ? [{ text: '←', callback_data: `tlmx_poll:${record.key}:p${record.page - 1}` }] : []),
    ...(start + 8 < (poll.answers?.length ?? 0) ? [{ text: '→', callback_data: `tlmx_poll:${record.key}:p${record.page + 1}` }] : []),
  ]);
  if (!restriction) rows.push([{ text: 'Отправить голос', callback_data: `tlmx_poll:${record.key}:s` }, { text: 'Очистить выбор', callback_data: `tlmx_poll:${record.key}:c` }]);
  rows.push([{ text: 'Обновить результаты MAX', callback_data: `tlmx_poll:${record.key}:r` }]);
  const chosen = record.draft.map(i => (poll.answers ?? [])[i]?.text).filter(Boolean).join(', ');
  return { text: `🗳 ${truncateUtf16(poll.title ?? 'Опрос MAX', 1200)}\n${(poll.settings ?? 0) & 1 ? 'Анонимный опрос MAX' : 'Опрос MAX'} · голосов: ${poll.state?.total ?? 0}\n\nВыбор здесь: ${truncateUtf16(chosen || 'ничего', 1000)}\n${restriction ?? 'Нажмите «Отправить голос»: действие выполняется от вашего MAX-аккаунта. Пустой выбор снимает голос, если автор разрешил переголосование.'}`, reply_markup: { inline_keyboard: rows } };
}

/** Custom controls work for anonymous MAX polls too; counts always come from MAX, not Telegram. */
export class PollWidgets {
  private readonly drawing = new Map<string, Promise<void>>();
  private flushing?: Promise<void>;
  constructor(private readonly db: BridgeDatabase, private readonly bot: Telegraf, private readonly max: MaxClient, private readonly destination: string) {}
  async create(chatId: unknown, messageId: unknown, topicId: number, poll: MaxAttachment): Promise<number> {
    if (poll.pollId == null) throw new Error('MAX не вернул id опроса; голосование наугад запрещено.');
    const key = createHash('sha256').update(`${String(chatId)}:${String(messageId)}`).digest('hex').slice(0, 16);
    const previous = this.db.get<PollWidget>('pollWidgets', key);
    const record: PollWidget = { key, chatId: String(chatId), maxMessageId: messageId, topicId, poll, draft: previous?.draft ?? [], page: 0 };
    const view = renderPollWidget(record);
    const sent = await withFloodRetry(() => this.bot.telegram.sendMessage(this.destination, view.text, { message_thread_id: topicId, reply_markup: view.reply_markup }));
    if (!Number.isSafeInteger(sent.message_id)) throw new Error('Telegram не подтвердил карточку опроса.');
    this.db.set('pollWidgets', key, { ...record, messageId: sent.message_id });
    return sent.message_id;
  }
  async update(chatId: unknown, messageId: unknown, poll: MaxAttachment): Promise<boolean> {
    const key = createHash('sha256').update(`${String(chatId)}:${String(messageId)}`).digest('hex').slice(0, 16);
    const record = this.db.get<PollWidget>('pollWidgets', key);
    if (!record) return false;
    if (poll.version != null && record.poll.version != null && poll.version < record.poll.version) return true;
    const next = { ...record, poll, dirty: true };
    this.db.set('pollWidgets', key, next);
    await this.draw(next);
    return true;
  }
  flush(): Promise<void> {
    this.flushing ??= (async () => { for (const record of this.db.values<PollWidget>('pollWidgets')) if (record.dirty) await this.draw(record); })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private draw(record: PollWidget): Promise<void> {
    const prior = this.drawing.get(record.key) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.drawCurrent(record.key));
    this.drawing.set(record.key, run);
    void run.finally(() => { if (this.drawing.get(record.key) === run) this.drawing.delete(record.key); }).catch(() => {});
    return run;
  }
  private async drawCurrent(key: string): Promise<void> {
    const record = this.db.get<PollWidget>('pollWidgets', key);
    if (!record) return;
    if (!record.messageId) throw new Error('Не найдена карточка опроса.');
    const view = renderPollWidget(record);
    try { await withFloodRetry(() => this.bot.telegram.editMessageText(this.destination, record.messageId!, undefined, view.text, { reply_markup: view.reply_markup })); }
    catch (error) { if (!/message is not modified/i.test((error as Error).message)) throw error; }
    const current = this.db.get<PollWidget>('pollWidgets', key);
    if (current && JSON.stringify(renderPollWidget(current)) === JSON.stringify(view)) this.db.set('pollWidgets', key, { ...current, dirty: false });
  }
  private async refresh(record: PollWidget): Promise<void> {
    const msg = (await this.max.getMessages(record.chatId, [record.maxMessageId]))[0];
    const poll = (msg?.attaches as MaxAttachment[] | undefined)?.find(a => a._type === 'POLL');
    if (!poll) throw new Error('MAX не вернул исходный опрос.');
    await this.update(record.chatId, record.maxMessageId, poll);
  }
  async click(ctx: Context, key: string, action: string): Promise<void> {
    if (!currentDelivery()) throw new Error('Голосование должно выполняться через постоянную очередь.');
    let record = this.db.get<PollWidget>('pollWidgets', key);
    const message = (ctx.callbackQuery as { message?: { message_id?: number; chat?: { id: unknown } } })?.message;
    if (!record || record.messageId !== message?.message_id || String(message?.chat?.id) !== this.destination) throw new Error('Карточка опроса устарела либо принадлежит другому чату.');
    await ctx.answerCbQuery().catch(() => {});
    if (action === 'r') { await this.refresh(record); return; }
    if (action === 's') {
      const planKey = String(ctx.update.update_id);
      let answers = this.db.get<number[]>('pollVotePlans', planKey);
      if (!answers) {
        await this.refresh(record);
        record = this.db.get<PollWidget>('pollWidgets', key)!;
        if (pollVoteRestriction(record.poll)) return;
        answers = record.draft.map(i => Number(record!.poll.answers?.[i]?.answerId));
        if (answers.some(id => !Number.isSafeInteger(id))) throw new Error('MAX не вернул точные id вариантов ответа.');
        this.db.set('pollVotePlans', planKey, answers);
      }
      await this.max.sendVote(record.chatId, record.maxMessageId, record.poll.pollId, answers);
      await this.refresh(record);
      return;
    }
    // Freeze the resulting draft rather than replaying a toggle twice after a crash.
    const planKey = `${ctx.update.update_id}:${key}`;
    let draft = this.db.get<{ draft: number[]; page: number }>('pollDraftPlans', planKey);
    if (!draft) {
      const index = Number(action.slice(1));
      if (action.startsWith('i')) {
        if (!record.poll.answers?.[index]) throw new Error('Вариант ответа отсутствует.');
        const next = record.draft.includes(index) ? record.draft.filter(i => i !== index) : (record.poll.settings ?? 0) & 2 ? [...record.draft, index] : [index];
        draft = { draft: next, page: record.page };
      } else if (action.startsWith('p')) {
        if (!Number.isSafeInteger(index) || index < 0 || index * 8 >= (record.poll.answers?.length ?? 0)) throw new Error('Страница опроса отсутствует.');
        draft = { draft: record.draft, page: index };
      } else draft = { draft: [], page: record.page };
      this.db.set('pollDraftPlans', planKey, draft);
    }
    record = { ...record, ...draft, dirty: true };
    this.db.set('pollWidgets', key, record);
    await this.draw(record);
  }
}
