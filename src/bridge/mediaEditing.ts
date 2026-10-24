import type { Telegraf } from 'telegraf';
import type { MessageEntity } from 'telegraf/types';
import type { MaxClient } from '../max/client.js';
import type { BridgeDatabase } from '../store/bridgeDatabase.js';
import type { MessageLink } from './sync.js';
import { currentDelivery } from './deliveryQueue.js';
import { splitRichText, telegramToMax, shiftFormatting } from './formatting.js';
import { uploadTelegramAttachmentToMax, type UploadKind } from './upload.js';
import { editOutgoingText } from './messageEditing.js';
import { MAX_TEXT_LIMIT } from './text.js';
import { createHash } from 'node:crypto';
import { downloadMaxAttachment, telegramSendKind, type MaxAttachment } from './attachments.js';
import { withFloodRetry } from './transient.js';

interface MediaFile { file_id: string; file_unique_id?: string; file_name?: string; file_size?: number; duration?: number }
export interface EditedTelegramMedia {
  message_id: number; caption?: string; caption_entities?: MessageEntity[];
  photo?: MediaFile[]; video?: MediaFile; document?: MediaFile; animation?: MediaFile; audio?: MediaFile;
}

/** Replace only the edited album part, retaining every untouched attachment and caption. */
export async function editOutgoingMedia(bot: Telegraf, max: MaxClient, db: BridgeDatabase | undefined, link: MessageLink, message: EditedTelegramMedia, save: (link: MessageLink) => void): Promise<boolean> {
  const photo = message.photo?.at(-1);
  const file = photo ?? message.video ?? message.document ?? message.animation ?? message.audio;
  if (!file) return false;
  if ((file.file_size ?? 0) > 20 * 1024 * 1024) throw new Error('Замена вложения превышает лимит Telegram Bot API 20 МБ.');
  const parts = link.telegramMedia?.map(p => ({ ...p })) ?? [];
  let index = parts.findIndex(p => p.telegramId === message.message_id);
  if (index < 0 && parts.length) throw new Error('Не найдена точная часть альбома; замена наугад запрещена.');
  const old = parts[index];
  const unique = file.file_unique_id;
  const changed = !old || (old.fileId !== file.file_id && (!unique || old.fileUniqueId !== unique));
  let attach = old?.attach;
  if (changed) {
    const key = `${currentDelivery()?.id ?? 'manual'}:edit:${message.message_id}:${file.file_id}`;
    attach = db?.get<Record<string, unknown>>('preparedUploads', key);
    if (!attach) {
      const kind: UploadKind = photo ? 'photo' : message.video ? 'video' : 'document';
      attach = await uploadTelegramAttachmentToMax(bot, max, file.file_id, kind, file.file_name ?? (photo ? 'photo.jpg' : 'file'));
      db?.set('preparedUploads', key, attach);
    }
  }
  const item = { telegramId: message.message_id, fileId: file.file_id, fileUniqueId: unique, attach: attach!, caption: message.caption ?? '', captionEntities: message.caption_entities ?? [] };
  if (index < 0) { index = 0; parts.push(item); } else parts[index] = item;
  let text = ''; const entities: MessageEntity[] = [];
  for (const p of parts) if (p.caption) {
    entities.push(...shiftFormatting(p.captionEntities, text.length + (text ? 1 : 0)));
    text += (text ? '\n' : '') + p.caption;
  }
  const updated = { ...link, telegramMedia: parts };
  if (!changed) { await editOutgoingText(max, updated, { text, entities }, save); return true; }
  const [first = { text: '', entities: [] }, ...rest] = splitRichText(text, entities, MAX_TEXT_LIMIT);
  await max.editMessage(link.maxChatId, link.maxMessageId, first.text || null, telegramToMax(first.text, first.entities), parts.map(p => p.attach));
  // Existing additional caption parts are resized using the same durable MAX action journal.
  const oldIds = link.extraMaxMessageIds ?? [];
  const newIds: unknown[] = [];
  for (let i = 0; i < rest.length; i++) {
    const piece = rest[i]!;
    if (oldIds[i] != null) { await max.editMessage(link.maxChatId, oldIds[i], piece.text, telegramToMax(piece.text, piece.entities)); newIds.push(oldIds[i]); }
    else newIds.push((await max.sendMessage(link.maxChatId, piece.text, [], undefined, { elements: telegramToMax(piece.text, piece.entities) })).messageId);
  }
  if (oldIds.length > newIds.length) await max.deleteMessages(link.maxChatId, oldIds.slice(newIds.length), false);
  save({ ...updated, extraMaxMessageIds: newIds });
  return true;
}

export function maxMediaSignature(attaches: MaxAttachment[]): string {
  const fields = ['_type', 'photoId', 'photoToken', 'videoId', 'videoType', 'fileId', 'audioId', 'stickerId', 'token', 'latitude', 'longitude', 'contactId', 'phone'];
  return createHash('sha256').update(JSON.stringify(attaches.filter(a => ['PHOTO', 'VIDEO', 'FILE', 'AUDIO', 'STICKER', 'LOCATION', 'CONTACT'].includes(a._type ?? '')).map(a => {
    const raw = a as unknown as Record<string, unknown>;
    const identity = Object.fromEntries(fields.filter(k => raw[k] != null).map(k => [k, typeof raw[k] === 'bigint' ? String(raw[k]) : raw[k]]));
    if (Object.keys(identity).length < 2) identity.url = String(raw.baseUrl ?? raw.url ?? '').split('?')[0];
    return identity;
  }))).digest('hex');
}

/** Existing bot-owned media are edited in place; uneditable types are replaced using journalled sends. */
export async function replaceIncomingMedia(bot: Telegraf, max: MaxClient, destination: string, topic: number, link: MessageLink, attaches: MaxAttachment[], send: (att: MaxAttachment) => Promise<number[]>): Promise<MessageLink> {
  const allOld = [link.telegramMessageId, ...(link.extraTelegramMessageIds ?? [])];
  const old = link.mediaTelegramMessageIds ?? (link.outgoing ? [] : allOld.filter(id => !(link.textTelegramMessageIds ?? []).includes(id)));
  const ids: number[] = [];
  for (let index = 0; index < attaches.length; index++) {
    const att = attaches[index]!;
    const oldId = old[index];
    let edited = false;
    if (oldId != null && ['PHOTO', 'VIDEO', 'FILE'].includes(att._type ?? '') && att.videoType !== 1) {
      const file = await downloadMaxAttachment(att, { max, chatId: link.maxChatId, messageId: link.maxMessageId, throwOnTransient: true });
      const kind = file && telegramSendKind(file.kind, file.buffer.byteLength);
      if (file && kind && ['photo', 'video', 'document', 'audio'].includes(kind)) {
        try {
          await withFloodRetry(() => bot.telegram.editMessageMedia(destination, oldId, undefined, { type: kind, media: { source: file.buffer, filename: file.filename } } as Parameters<typeof bot.telegram.editMessageMedia>[3]));
          ids.push(oldId); edited = true;
        } catch (error) {
          const response = (error as { response?: { error_code?: number; description?: string } })?.response;
          if (/message is not modified/i.test(response?.description ?? (error as Error).message)) { ids.push(oldId); edited = true; }
          else if (response?.error_code !== 400) throw error;
        }
      }
    }
    if (!edited) {
      ids.push(...await send(att));
      if (oldId != null) await bot.telegram.deleteMessage(destination, oldId);
    }
  }
  for (const id of old.slice(attaches.length)) await bot.telegram.deleteMessage(destination, id);
  const all = [...new Set([...allOld.filter(id => !old.includes(id)), ...ids])];
  const anchor = all.includes(link.telegramMessageId) ? link.telegramMessageId : all[0];
  if (anchor == null) throw new Error('После правки не осталось ни текста, ни вложений; требуется сверка сообщения.');
  return { ...link, telegramMessageId: anchor, telegramTopicId: topic, extraTelegramMessageIds: all.filter(id => id !== anchor), mediaTelegramMessageIds: ids, maxMediaSignature: maxMediaSignature(attaches) };
}
