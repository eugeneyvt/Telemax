import type { Telegraf } from 'telegraf';
import { downloadMaxAttachment, telegramSendKind, PHOTO_AS_FILE, imageSize, fitsTelegramPhoto, type MaxAttachment, type DownloadContext } from './attachments.js';
import { withFloodRetry } from './transient.js';

export function albumFamily(att: MaxAttachment): 'visual' | 'document' | undefined {
  if (att._type === 'PHOTO' || (att._type === 'VIDEO' && att.videoType !== 1)) return 'visual';
  if (att._type === 'FILE') return 'document';
  return undefined;
}

/** Return null before sending when grouping would change the attachment's meaning or format. */
export async function sendAttachmentAlbum(bot: Telegraf, group: string, topic: number, attaches: MaxAttachment[], ctx: DownloadContext, reply?: { message_id: number; allow_sending_without_reply: boolean }): Promise<number[] | null> {
  if (attaches.length < 2 || attaches.length > 10 || !albumFamily(attaches[0]!) || attaches.some(a => albumFamily(a) !== albumFamily(attaches[0]!))) return null;
  const media: Array<Record<string, unknown>> = [];
  for (const att of attaches) {
    const file = await downloadMaxAttachment(att, ctx);
    const kind = file ? telegramSendKind(file.kind, file.buffer.byteLength) : undefined;
    if (!file || !kind || !['photo', 'video', 'document'].includes(kind)) return null;
    if (kind === 'photo') {
      const ext = file.filename.split('.').at(-1)!;
      const size = imageSize(file.buffer);
      if (PHOTO_AS_FILE.has(ext) || (size && !fitsTelegramPhoto(size))) return null;
    }
    media.push({ type: kind, media: { source: file.buffer, filename: file.filename }, ...(kind === 'video' ? { supports_streaming: true, width: file.width, height: file.height } : {}) });
  }
  // Bot API permits mixing photos and videos, but documents only with documents.
  if (media.some(m => m.type === 'document') && media.some(m => m.type !== 'document')) return null;
  const sent = await withFloodRetry(() => bot.telegram.sendMediaGroup(group, media as unknown as Parameters<typeof bot.telegram.sendMediaGroup>[1], { message_thread_id: topic, ...(reply ? { reply_parameters: reply } : {}) }));
  if (!Array.isArray(sent) || sent.length !== attaches.length || sent.some(m => !Number.isSafeInteger(m.message_id))) throw new Error('Telegram не подтвердил все части альбома.');
  return sent.map(m => m.message_id);
}
