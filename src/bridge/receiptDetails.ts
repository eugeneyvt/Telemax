import type { MaxHistoryMessage } from '../max/client.js';

/** MAX web stores chat.participants[userId] as the read boundary in server milliseconds. */
export function participantReadMarks(chat: unknown, ownId: unknown): Array<{ userId: string; mark: number }> {
  const participants = (chat as { participants?: unknown } | null)?.participants;
  if (!participants || typeof participants !== 'object' || Array.isArray(participants)) return [];
  return Object.entries(participants).flatMap(([userId, value]) => {
    if (!/^\d+$/.test(userId) || userId === String(ownId) || !['number', 'bigint', 'string'].includes(typeof value)) return [];
    const mark = Number(value);
    return Number.isSafeInteger(mark) && mark > 0 ? [{ userId, mark }] : [];
  });
}

export async function messageReceiptText(message: MaxHistoryMessage, marks: Array<{ userId: string; mark: number }>, ownId: unknown, name: (id: string) => Promise<string>): Promise<string> {
  if (String(message.sender) !== String(ownId)) return 'Это входящее сообщение. /read отмечает его прочитанным вашим аккаунтом в MAX.';
  const time = Number(message.time);
  if (!Number.isSafeInteger(time) || time <= 0) return 'MAX не вернул достоверное время сообщения; статус прочтения неизвестен.';
  const rows = await Promise.all(marks.map(async p => `${p.mark >= time ? '✓' : '○'} ${await name(p.userId)}: ${p.mark >= time ? 'сообщение прочитано в MAX' : 'подтверждения прочтения этого сообщения нет'}`));
  const media = (message.attaches ?? []) as Array<{ _type?: string; videoType?: number }>;
  const playable = media.some(a => a._type === 'AUDIO' || a._type === 'VOICE' || (a._type === 'VIDEO' && a.videoType === 1));
  return '✓ Сообщение есть в MAX.\n' + (rows.join('\n') || 'MAX не вернул подтверждение прочтения другим участником.')
    + (playable ? '\n🎧 Отдельного подтверждения прослушивания/просмотра доступный протокол MAX не даёт. Прочтение не доказывает воспроизведение.' : '');
}
