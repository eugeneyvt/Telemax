import { createHash } from 'node:crypto';
import type { Telegraf } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { BridgeDatabase, encodePersistent, type DeliveryJob } from '../store/bridgeDatabase.js';
import type { MessageLink } from './sync.js';
import type { RichText } from './formatting.js';
import { currentDelivery, outsideDelivery } from './deliveryQueue.js';
import { editIncomingText } from './messageEditing.js';
import type { MaxAttachment } from './attachments.js';

export interface IncomingEdit {
  kind: 'incoming-edit';
  maxChatId: string;
  maxMessageId: unknown;
  topicId: number;
  rich: RichText;
  keyboard?: InlineKeyboardMarkup;
  original?: MessageLink;
  attaches?: MaxAttachment[];
}
export function isIncomingEdit(value: unknown): value is IncomingEdit {
  return (value as Partial<IncomingEdit> | null)?.kind === 'incoming-edit';
}
interface EditLinks {
  getByMax(chatId: unknown, messageId: unknown): MessageLink | undefined;
  add(link: MessageLink): void;
}

/** A received edit is durable even when Telegram is offline or the process stops mid-resize. */
export class IncomingEdits {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly bot: Telegraf,
    private readonly chatId: string,
    private readonly links: EditLinks,
    private readonly resolveTopic: (maxChatId: string) => Promise<{ telegramTopicId: number; banned?: boolean } | undefined>,
    private readonly applied: (edit: IncomingEdit) => void = () => {},
    private readonly replaceMedia?: (edit: IncomingEdit, link: MessageLink) => Promise<MessageLink>,
  ) {}
  enqueue(edit: Omit<IncomingEdit, 'kind' | 'original'>, source: unknown): DeliveryJob {
    const key = `${edit.maxChatId}:${String(edit.maxMessageId)}`;
    const signature = createHash('sha256').update(encodePersistent(source)).digest('hex');
    return this.db.transaction(() => {
      const last = this.db.get<{ signature: string; generation: number; jobId: number }>('incomingEditVersions', key);
      if (last?.signature === signature) {
        const prior = this.db.job(last.jobId);
        if (prior) return prior;
      }
      const generation = (last?.generation ?? 0) + 1;
      const job = this.db.enqueue(`incoming-edit:${key}:${generation}`, edit.maxChatId, { ...edit, kind: 'incoming-edit' } satisfies IncomingEdit);
      this.db.set('incomingEditVersions', key, { signature, generation, jobId: job.id });
      return job;
    });
  }
  async run(edit: IncomingEdit): Promise<void> {
    const job = currentDelivery();
    if (!job) throw new Error('Входящая правка должна выполняться в сохранённой очереди.');
    const mapping = await this.resolveTopic(edit.maxChatId);
    if (!mapping || mapping.banned) throw new Error('Тема чата удалена или отключена; правка сохранена.');
    let original = edit.original;
    if (!original) {
      original = this.links.getByMax(edit.maxChatId, edit.maxMessageId);
      if (!original || original.partial) throw new Error('Нет полной привязки исходного сообщения; правка сохранена.');
      edit = { ...edit, original: { ...original } };
      this.db.updateJobPayload(job.id, edit);
      job.payload = edit;
    }
    await editIncomingText(this.bot, this.chatId, mapping.telegramTopicId, original, edit.rich, link => this.links.add(link));
    let updated = this.links.getByMax(edit.maxChatId, edit.maxMessageId)!;
    if (edit.attaches && this.replaceMedia) {
      updated = await this.replaceMedia(edit, updated);
      this.links.add(updated);
    }
    const markupMessage = updated.textTelegramMessageIds?.at(-1) ?? updated.telegramMessageId;
    if (!updated.outgoing || updated.textTelegramMessageIds?.length) {
      await this.bot.telegram.editMessageReplyMarkup(this.chatId, markupMessage, undefined, edit.keyboard ?? { inline_keyboard: [] });
    }
    outsideDelivery(() => this.applied(edit));
  }
}
