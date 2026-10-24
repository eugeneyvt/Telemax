import type { Telegraf } from 'telegraf';
import type { MaxClient } from '../max/client.js';
import type { MessageLink } from './sync.js';
import { splitRichText, telegramToMax, type RichText } from './formatting.js';
import { MAX_TEXT_LIMIT } from './text.js';
import { withFloodRetry } from './transient.js';

export async function editOutgoingText(max: MaxClient, original: MessageLink, rich: RichText, save: (l: MessageLink) => void): Promise<MessageLink> {
  const pieces = splitRichText(rich.text, rich.entities, MAX_TEXT_LIMIT);
  if (!pieces.length) pieces.push({ text: '', entities: [] }); // removing a media caption
  const old = [original.maxMessageId, ...(original.extraMaxMessageIds ?? [])];
  const ids = [...old.slice(0, pieces.length)];
  let link: MessageLink = { ...original, extraMaxMessageIds: [...(original.extraMaxMessageIds ?? [])] };
  for (let i = 0; i < pieces.length; i++) {
    const part = pieces[i]!;
    const elements = telegramToMax(part.text, part.entities);
    if (i < old.length) await max.editMessage(original.maxChatId, old[i], part.text, elements);
    else {
      const sent = await max.sendMessage(original.maxChatId, part.text, [], undefined, { elements });
      if (sent.messageId == null) throw new Error('MAX не вернул id дополнительной части правки.');
      ids.push(sent.messageId);
      link = { ...link, extraMaxMessageIds: ids.slice(1) };
      save(link); // every confirmed new part is durable before the next await
    }
  }
  if (old.length > pieces.length) await max.deleteMessages(original.maxChatId, old.slice(pieces.length), false);
  link = { ...link, extraMaxMessageIds: ids.slice(1) };
  save(link);
  return link;
}

export async function editIncomingText(
  bot: Pick<Telegraf, 'telegram'>, chatId: string, topicId: number, original: MessageLink,
  rich: RichText, save: (l: MessageLink) => void,
): Promise<void> {
  // Only known text parts may be edited as text; a photo/poll anchor is never overwritten.
  const old = original.textTelegramMessageIds ?? [];
  const pieces = splitRichText(rich.text, rich.entities);
  const ids = old.slice(0, pieces.length);
  const allOld = [original.telegramMessageId, ...(original.extraTelegramMessageIds ?? [])];
  const media = allOld.filter(id => !old.includes(id));
  const update = () => {
    const anchor = old.includes(original.telegramMessageId) ? ids[0] ?? media[0] : original.telegramMessageId;
    if (anchor == null) return;
    save({ ...original, telegramMessageId: anchor, textTelegramMessageIds: [...ids], extraTelegramMessageIds: [...new Set([...ids, ...media])].filter(id => id !== anchor) });
  };
  for (let i = 0; i < pieces.length; i++) {
    const part = pieces[i]!;
    if (i < old.length) {
      try { await withFloodRetry(() => bot.telegram.editMessageText(chatId, old[i]!, undefined, part.text, { entities: part.entities })); }
      catch (e) { if (!/message is not modified/i.test((e as Error).message)) throw e; }
    } else {
      const sent = await withFloodRetry(() => bot.telegram.sendMessage(chatId, part.text, { message_thread_id: topicId, entities: part.entities }));
      ids.push(sent.message_id);
      update();
    }
  }
  for (const id of old.slice(pieces.length)) await withFloodRetry(() => bot.telegram.deleteMessage(chatId, id));
  update();
}
