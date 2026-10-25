import type { Telegraf } from 'telegraf';
import type { Update, MessageEntity } from 'telegraf/types';
import type { MaxClient } from '../max/client.js';
import type { BridgeDatabase, DeliveryJob } from '../store/bridgeDatabase.js';
import type { ChatMapStore } from '../store/chatMapStore.js';
import type { MessageLinkStore } from './sync.js';
import { uploadTelegramAttachmentToMax, type UploadKind } from './upload.js';
import { currentDelivery } from './deliveryQueue.js';
import { telegramToMax, shiftFormatting, splitRichText } from './formatting.js';
import { MAX_TEXT_LIMIT } from './text.js';

type Mapping = NonNullable<Awaited<ReturnType<ChatMapStore['getByTopicId']>>>;
export interface AlbumMessage {
  message_id: number; media_group_id: string; caption?: string; caption_entities?: MessageEntity[];
  photo?: Array<{ file_id: string; file_unique_id?: string; file_size?: number }>;
  video?: { file_id: string; file_unique_id?: string; file_size?: number; duration?: number; file_name?: string };
  document?: { file_id: string; file_unique_id?: string; file_size?: number; file_name?: string };
  audio?: { file_id: string; file_unique_id?: string; file_size?: number; file_name?: string };
  reply_to_message?: { message_id: number };
}
export interface ReadTarget { chatId: string; messageId: unknown }
export interface TelegramAlbum { kind: 'telegram-album'; mapping: Mapping; messages: AlbumMessage[]; started?: boolean; readTarget?: ReadTarget }
export const isTelegramAlbum = (value: unknown): value is TelegramAlbum => (value as TelegramAlbum | null)?.kind === 'telegram-album';

/** Telegram sends no end-of-album event: persist every part, then wait for a quiet interval. */
export class TelegramAlbums {
  constructor(private readonly db: BridgeDatabase, private readonly destination: string, private readonly quietMs = 2000) {}
  add(update: Update, mapping: Mapping, readTarget?: ReadTarget): DeliveryJob {
    const updateKey = String(update.update_id);
    const previous = this.db.get<number>('albumUpdates', updateKey);
    if (previous != null) return this.db.job(previous)!;
    const message = (update as { message: AlbumMessage }).message;
    const key = `${this.destination}:album:${mapping.maxChatId}:${mapping.telegramTopicId}:${message.media_group_id}`;
    return this.db.transaction(() => {
      let job = this.db.enqueue(key, String(mapping.maxChatId), { kind: 'telegram-album', mapping, messages: [], readTarget } satisfies TelegramAlbum);
      let payload = job.payload as TelegramAlbum;
      // A late part never mutates a started/retried operation and its frozen effect order.
      if (payload.started || job.status !== 'pending') {
        job = this.db.enqueue(`${key}:late:${update.update_id}`, String(mapping.maxChatId), { kind: 'telegram-album', mapping, messages: [], readTarget } satisfies TelegramAlbum);
        payload = job.payload as TelegramAlbum;
      }
      payload = { ...payload, messages: [...payload.messages, message].sort((a, b) => a.message_id - b.message_id) };
      this.db.updateJobPayload(job.id, payload);
      this.db.markJob(job.id, 'pending', undefined, Date.now() + this.quietMs);
      this.db.set('albumUpdates', updateKey, job.id);
      return this.db.job(job.id)!;
    });
  }
  async run(album: TelegramAlbum, bot: Telegraf, max: MaxClient, links: MessageLinkStore, resolve: (chatId: string) => Promise<Mapping | undefined>, sent: (chatId: unknown, cid: number, time: unknown) => void): Promise<void> {
    const job = currentDelivery(); if (!job) throw new Error('Альбом должен обрабатываться в постоянной очереди.');
    if (!album.started) { album = { ...album, started: true }; this.db.updateJobPayload(job.id, album); job.payload = album; }
    const mapping = await resolve(String(album.mapping.maxChatId));
    if (!mapping || mapping.banned || mapping.pendingUserId) throw new Error('Чат альбома недоступен; сначала откройте диалог текстом. Альбом сохранён.');
    const attaches: Record<string, unknown>[] = [];
    let text = ''; const entities: MessageEntity[] = [];
    for (const m of album.messages) {
      const photo = m.photo?.at(-1), file = photo ?? m.video ?? m.document ?? m.audio;
      if (!file) throw new Error('Неподдерживаемая часть альбома; задание сохранено.');
      if ((file.file_size ?? 0) > 20 * 1024 * 1024) throw new Error('Часть альбома превышает лимит скачивания Telegram Bot API 20 МБ.');
      const kind: UploadKind = photo ? 'photo' : m.video ? 'video' : 'document';
      const uploadKey = `${job.id}:${m.message_id}:${file.file_id}`;
      let attach = this.db.get<Record<string, unknown>>('preparedUploads', uploadKey);
      if (!attach) {
        attach = await uploadTelegramAttachmentToMax(bot, max, file.file_id, kind, (m.video ?? m.document ?? m.audio)?.file_name ?? (photo ? 'photo.jpg' : 'file'));
        this.db.set('preparedUploads', uploadKey, attach);
      }
      attaches.push(attach);
      if (m.caption) {
        const offset = text.length + (text ? 1 : 0);
        entities.push(...shiftFormatting(m.caption_entities, offset));
        text += (text ? '\n' : '') + m.caption;
      }
    }
    const replyId = album.messages[0]?.reply_to_message?.message_id;
    const reply = replyId == null ? undefined : links.getByTelegram(replyId);
    const [first = { text: '', entities: [] }, ...rest] = splitRichText(text, entities, MAX_TEXT_LIMIT);
    const result = await max.sendMessage(mapping.maxChatId, first.text || null, attaches, reply ? { chatId: reply.maxChatId, messageId: reply.maxMessageId } : undefined, { elements: telegramToMax(first.text, first.entities) });
    const extras: unknown[] = [];
    for (const piece of rest) {
      const extra = await max.sendMessage(mapping.maxChatId, piece.text, [], undefined, { elements: telegramToMax(piece.text, piece.entities) });
      extras.push(extra.messageId); sent(mapping.maxChatId, extra.cid, extra.time);
    }
    links.add({ maxChatId: mapping.maxChatId, maxMessageId: result.messageId, telegramMessageId: album.messages[0]!.message_id, extraTelegramMessageIds: album.messages.slice(1).map(m => m.message_id), telegramTopicId: mapping.telegramTopicId, outgoing: true,
      extraMaxMessageIds: extras,
      telegramMedia: album.messages.map((m, i) => ({ telegramId: m.message_id, fileId: (m.photo?.at(-1) ?? m.video ?? m.document ?? m.audio)!.file_id, fileUniqueId: (m.photo?.at(-1) ?? m.video ?? m.document ?? m.audio)!.file_unique_id, attach: attaches[i]!, caption: m.caption ?? '', captionEntities: m.caption_entities ?? [] })) });
    sent(mapping.maxChatId, result.cid, result.time);
  }
}
