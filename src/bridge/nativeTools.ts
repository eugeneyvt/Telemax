import { randomUUID } from 'node:crypto';
import type { Context, Telegraf } from 'telegraf';
import type { MessageEntity } from 'telegraf/types';
import type { MaxClient, MaxFolder } from '../max/client.js';
import type { BridgeDatabase } from '../store/bridgeDatabase.js';
import type { ChatMapStore } from '../store/chatMapStore.js';
import type { MessageLink, MessageLinkStore } from './sync.js';
import { currentDelivery } from './deliveryQueue.js';
import { splitRichText, telegramToMax, type RichText } from './formatting.js';
import { MAX_TEXT_LIMIT } from './text.js';
import { fetchTelegramFile, uploadPhotoToMax } from './upload.js';
import { createLogger } from '../logger.js';
const logger = createLogger('native-tools');

export const DURABLE_COMMANDS = 'read|pin|unpin|delete|silent|schedule|unschedule|forward|folderadd|folderrename|folderinclude|folderexclude|folderdelete|profile|avatar';
export const isDurableCommand = (text: string): boolean => new RegExp(`^/(${DURABLE_COMMANDS})(?:@\\w+)?(?:\\s|$)`).test(text);
export class ScheduleInputError extends Error {}
export function commandRichText(message: { text?: string; entities?: MessageEntity[] }, skipArgument = false): RichText {
  const raw = message.text ?? '';
  const prefix = (skipArgument ? /^\/\S+\s+\S+\s+/ : /^\/\S+\s*/).exec(raw)?.[0].length ?? 0;
  const remainder = raw.slice(prefix);
  const start = prefix + remainder.length - remainder.trimStart().length;
  const text = remainder.trim();
  const entities = (message.entities ?? []).flatMap(entity => {
    const from = Math.max(entity.offset, start), end = Math.min(entity.offset + entity.length, start + text.length);
    return end > from ? [{ ...entity, offset: from - start, length: end - from } as MessageEntity] : [];
  });
  return { text, entities };
}

/** Explicit UTC offset avoids timezone/DST ambiguity; relative delays are frozen before sending. */
export function parseSchedule(input: string, now = Date.now()): { at: number; text: string } {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(input.trim());
  if (!match) throw new ScheduleInputError('Используйте /schedule +30m текст или /schedule 2026-10-25T18:00+03:00 текст.');
  const relative = /^\+(\d+)(m|h|d)$/.exec(match[1]!);
  const at = relative ? now + Number(relative[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]!]!)
    : /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(match[1]!) ? Date.parse(match[1]!) : NaN;
  if (!Number.isSafeInteger(at) || at <= now || at > now + 365 * 86_400_000) throw new ScheduleInputError('Укажите будущее время с часовым поясом, не дальше года. Например: +30m, +2h или 2026-10-25T18:00+03:00.');
  return { at, text: match[2]! };
}

interface ScheduleRecord { id: string; chatId: string; topicId: number; at: number; messageIds: string[]; preview: string; cancelled?: boolean }
interface Target { mapping: NonNullable<Awaited<ReturnType<ChatMapStore['getByTopicId']>>>; link?: MessageLink }
interface NativeToolsDeps {
  bot: Telegraf; max: MaxClient; db?: BridgeDatabase; links: MessageLinkStore; chats: ChatMapStore;
  target(ctx: Context): Promise<Target | null>;
  closeOtherSessions?: () => Promise<void>;
  ownProfile: () => Promise<unknown>;
  renderSent: (chatId: unknown, messageId: unknown) => Promise<void>;
}

export function wireNativeTools({ bot, max, db, links, chats, target, closeOtherSessions, ownProfile, renderSent }: NativeToolsDeps): void {
  const handlers = new Map<string, (ctx: Context) => Promise<void>>();
  const argument = (ctx: Context) => ((ctx.message as { text?: string })?.text ?? '').replace(/^\/\S+\s*/, '').trim();
  const say = (ctx: Context, text: string) => ctx.reply(text, { ...((ctx.message as { message_thread_id?: number })?.message_thread_id ? { message_thread_id: (ctx.message as { message_thread_id: number }).message_thread_id } : {}) });
  const command = (name: string, run: (ctx: Context) => Promise<void>) => { handlers.set(name, run); return bot.command(name, async ctx => {
    try { await run(ctx); }
    catch (error) {
      logger.error('Native command failed', { command: name, errorName: (error as Error).name, serverCode: (error as { serverCode?: string }).serverCode });
      if (currentDelivery()) throw error;
      await say(ctx, 'Не удалось выполнить действие. Проверьте подключение и /queue; подробности сохранены в журнале.');
    }
  }); };
  async function frozen<T>(ctx: Context, name: string, create: () => T | Promise<T>): Promise<T> {
    if (!db) throw new Error('Для этой операции нужна постоянная база.');
    const key = `${ctx.update.update_id}:${name}`;
    const prior = db.get<T>('nativePlans', key);
    if (prior !== undefined) return prior;
    const value = await create();
    db.set('nativePlans', key, value);
    return value;
  }
  command('tools', async ctx => {
    await ctx.reply('Дополнительные возможности MAX:\n\n/silent текст — отправить тихо\n/schedule +30m текст — отправить позже\n/scheduled — запланированные в этой теме\n/unschedule номер — отменить\n/forward номер_темы — переслать MAX-оригинал (ответом на сообщение)\n/reactions — реакции MAX (ответом на сообщение)\n/avatar — заменить фото профиля (ответом на фото)\n/folderadd название — папка с текущим чатом\n/folderinclude ID и /folderexclude ID — состав папки\n/folderrename ID название\n/folderdelete ID УДАЛИТЬ', { reply_markup: { inline_keyboard: [[{ text: 'Устройства MAX', callback_data: 'tlmx_tools:devices' }, { text: 'Папки', callback_data: 'tlmx_tools:folders' }], [{ text: 'Профиль MAX', callback_data: 'tlmx_tools:profile' }]] } });
  });
  bot.action(/^tlmx_tools:(devices|folders|profile)$/, async ctx => { await ctx.answerCbQuery(); const run = handlers.get(ctx.match[1]!); if (run) await run(ctx); });

  command('silent', async ctx => {
    const t = await target(ctx); if (!t) return;
    const rich = commandRichText(ctx.message as { text?: string; entities?: MessageEntity[] });
    if (!rich.text) { await say(ctx, '/silent текст — отправить без звукового уведомления в MAX.'); return; }
    let first = true;
    for (const piece of splitRichText(rich.text, rich.entities, MAX_TEXT_LIMIT)) {
      const reply = first && t.link ? { chatId: t.link.maxChatId, messageId: t.link.maxMessageId } : undefined;
      const result = await max.sendMessage(t.mapping.maxChatId, piece.text, [], reply, { notify: false, elements: telegramToMax(piece.text, piece.entities) });
      await renderSent(t.mapping.maxChatId, result.messageId);
      first = false;
    }
    await say(ctx, '🔕 Отправлено в MAX без звукового уведомления.');
  });

  command('schedule', async ctx => {
    const t = await target(ctx); if (!t) return;
    let plan: { at: number; text: string; entities: MessageEntity[] };
    try { plan = await frozen(ctx, 'schedule', () => ({ ...parseSchedule(argument(ctx)), entities: commandRichText(ctx.message as { text?: string; entities?: MessageEntity[] }, true).entities })); }
    catch (e) { if (!(e instanceof ScheduleInputError)) throw e; await say(ctx, e.message); return; }
    const ids: string[] = [];
    for (const piece of splitRichText(plan.text, plan.entities, MAX_TEXT_LIMIT)) {
      const reply = !ids.length && t.link ? { chatId: t.link.maxChatId, messageId: t.link.maxMessageId } : undefined;
      const sent = await max.sendMessage(t.mapping.maxChatId, piece.text, [], reply, { sendAt: plan.at, elements: telegramToMax(piece.text, piece.entities) });
      ids.push(String(sent.messageId));
    }
    const record: ScheduleRecord = { id: String(ctx.update.update_id), chatId: String(t.mapping.maxChatId), topicId: t.mapping.telegramTopicId, at: plan.at, messageIds: ids, preview: plan.text.slice(0, 80) };
    db!.set('scheduled', record.id, record);
    await say(ctx, `🕓 MAX принял отложенное сообщение ${record.id}: ${new Date(plan.at).toLocaleString('ru-RU', { timeZone: process.env.TZ || 'Europe/Moscow' })}. Отмена: /unschedule ${record.id}`);
  });

  command('scheduled', async ctx => {
    const t = await target(ctx); if (!t) return;
    const records = (db?.values<ScheduleRecord>('scheduled') ?? []).filter(x => x.chatId === String(t.mapping.maxChatId) && !x.cancelled && x.at > Date.now()).sort((a, b) => a.at - b.at);
    await say(ctx, records.length ? records.slice(0, 30).map(x => `${x.id} · ${new Date(x.at).toLocaleString('ru-RU', { timeZone: process.env.TZ || 'Europe/Moscow' })} · ${x.preview}`).join('\n') : 'Запланированных через мост сообщений в этой теме нет.');
  });

  command('unschedule', async ctx => {
    const t = await target(ctx); if (!t) return;
    const record = db?.get<ScheduleRecord>('scheduled', argument(ctx));
    if (!record || record.chatId !== String(t.mapping.maxChatId)) { await say(ctx, 'Сообщение не найдено в этой теме. Список: /scheduled'); return; }
    if (record.cancelled) { await say(ctx, 'Отложенное сообщение уже отменено.'); return; }
    if (record.at <= Date.now()) { await say(ctx, 'Срок отправки уже наступил: отмена отложенной отправки больше не применяется.'); return; }
    await max.deleteMessages(record.chatId, record.messageIds.map(BigInt), false, 'DELAYED');
    db!.set('scheduled', record.id, { ...record, cancelled: true });
    await say(ctx, `Отложенное сообщение ${record.id} отменено в MAX.`);
  });

  command('forward', async ctx => {
    const t = await target(ctx); if (!t) return;
    const topic = Number(argument(ctx));
    const dest = Number.isSafeInteger(topic) && topic > 0 ? await chats.getByTopicId(topic) : undefined;
    if (!t.link || !dest || dest.banned || String(dest.maxChatId).startsWith('pending:')) { await say(ctx, 'Ответьте /forward НОМЕР_ТЕМЫ на исходное сообщение. Номер есть в ссылке темы; назначение должно быть существующим чатом MAX.'); return; }
    const result = await max.forwardMessage(dest.maxChatId, t.link.maxChatId, t.link.maxMessageId);
    // A command is an acknowledgement, not a copy of the forwarded message: no fake TG alias.
    db?.set('nativeForwards', String(ctx.update.update_id), { chatId: String(dest.maxChatId), messageId: result.messageId, sourceChatId: String(t.link.maxChatId), sourceMessageId: t.link.maxMessageId });
    await renderSent(dest.maxChatId, result.messageId);
    await say(ctx, `↪️ MAX переслал оригинал в тему «${dest.title ?? topic}».`);
  });

  command('devices', async ctx => {
    if (argument(ctx) === 'close ПОДТВЕРЖДАЮ') {
      if (!closeOtherSessions) { await say(ctx, 'Завершение сессий недоступно в этом экземпляре.'); return; }
      await closeOtherSessions();
      await say(ctx, 'Остальные сессии MAX завершены; обновлённый токен моста сохранён.'); return;
    }
    const sessions = await max.getDeviceSessions();
    await say(ctx, 'Устройства MAX:\n' + sessions.map((s, i) => `${i + 1}. ${String(s.deviceName ?? s.deviceType ?? 'Устройство')} ${s.current ? '(текущее)' : ''}`).join('\n') + '\n\nЗавершить остальные входы: /devices close ПОДТВЕРЖДАЮ');
  });

  command('folders', async ctx => {
    const folders = await max.getFolders();
    await say(ctx, folders.length ? folders.map(f => `${f.title} · ${f.id} · чатов: ${f.include?.length ?? 0}`).join('\n') : 'Папок в MAX нет. Создать папку с текущим чатом: /folderadd Название');
  });
  command('folderadd', async ctx => {
    const t = await target(ctx); if (!t) return;
    const title = argument(ctx); if (!title || title.length > 100) { await say(ctx, '/folderadd Название — создать папку MAX с текущим чатом.'); return; }
    const folder = await frozen<MaxFolder>(ctx, 'folderadd', () => ({ id: randomUUID(), title, include: [String(t.mapping.maxChatId)], filters: [], options: [] }));
    await max.saveFolder(folder); await say(ctx, `Создана папка «${title}». Список: /folders`);
  });
  for (const name of ['folderrename', 'folderinclude', 'folderexclude', 'folderdelete']) command(name, async ctx => {
    const t = await target(ctx); if (!t) return;
    const [id, ...rest] = argument(ctx).split(/\s+/);
    const folders = await max.getFolders();
    const existing = folders.find(f => f.id === id);
    if (!existing) { await say(ctx, 'Папка не найдена. Её ID есть в /folders.'); return; }
    if (name === 'folderdelete') {
      if (rest.join(' ') !== 'УДАЛИТЬ') { await say(ctx, `Для удаления папки «${existing.title}»: /folderdelete ${id} УДАЛИТЬ. Переписки сохранятся.`); return; }
      await max.deleteFolder(id!); await say(ctx, 'Папка удалена; переписки сохранены.'); return;
    }
    const folder = await frozen<MaxFolder>(ctx, name, () => ({ ...existing, title: name === 'folderrename' ? rest.join(' ') : existing.title,
      include: name === 'folderinclude' ? [...new Set([...existing.include.map(String), String(t.mapping.maxChatId)])] : name === 'folderexclude' ? existing.include.filter(x => String(x) !== String(t.mapping.maxChatId)) : existing.include }));
    if (!folder.title.trim()) { await say(ctx, `/folderrename ${id} Новое название`); return; }
    await max.saveFolder(folder); await say(ctx, `Папка «${folder.title}» обновлена.`);
  });

  command('profile', async ctx => {
    const input = argument(ctx);
    if (!input) {
      const p = await ownProfile() as { names?: Array<{ firstName?: string; lastName?: string; name?: string }>; description?: string; about?: string } | undefined;
      const name = p?.names?.find(n => n.firstName || n.name);
      await say(ctx, `Профиль MAX: ${name?.name ?? [name?.firstName, name?.lastName].filter(Boolean).join(' ') ?? 'имя недоступно'}\n${p?.description ?? p?.about ?? ''}\n\nИзменить: /profile Имя | Фамилия | Описание`); return;
    }
    if (!await target(ctx)) return;
    const [firstName, lastName, description, ...extra] = input.split('|').map(x => x.trim());
    if (!firstName || lastName === undefined || description === undefined || extra.length) { await say(ctx, '/profile Имя | Фамилия | Описание — все три поля обязательны, фамилию и описание можно оставить пустыми.'); return; }
    await max.changeProfile({ firstName, lastName, description }); await say(ctx, 'Профиль MAX обновлён.');
  });

  command('avatar', async ctx => {
    if (!await target(ctx)) return;
    const photo = (ctx.message as { reply_to_message?: { photo?: Array<{ file_id: string; file_size?: number }> } }).reply_to_message?.photo?.at(-1);
    if (!photo) { await say(ctx, 'Ответьте /avatar на фотографию, которую нужно поставить в профиль MAX.'); return; }
    if ((photo.file_size ?? 0) > 20 * 1024 * 1024) { await say(ctx, 'Фотография превышает лимит Telegram Bot API 20 МБ.'); return; }
    const profile = await frozen(ctx, 'avatar-profile', async () => {
      const p = await ownProfile() as { names?: Array<{ firstName?: string; lastName?: string; type?: string }>; description?: string };
      const name = p.names?.find(n => n.type !== 'CUSTOM' && n.firstName);
      if (!name?.firstName) throw new Error('MAX не вернул раздельные поля имени профиля; фото не изменено, чтобы не повредить имя.');
      return { firstName: name.firstName, lastName: name.lastName ?? '', description: p.description ?? '' };
    });
    const uploaded = await frozen(ctx, 'avatar-upload', async () => uploadPhotoToMax(max, await fetchTelegramFile(bot, photo.file_id), true));
    await max.changeProfile({ ...profile, photoToken: uploaded.photoToken });
    await say(ctx, 'Фотография профиля MAX обновлена.');
  });

  command('reactions', async ctx => {
    const t = await target(ctx); if (!t?.link) { await say(ctx, 'Ответьте /reactions на сообщение, чтобы получить реакции MAX.'); return; }
    const counters = await max.getReactions(t.link.maxChatId, t.link.maxMessageId);
    await say(ctx, counters.length ? 'Реакции MAX: ' + counters.map(c => `${c.reaction} × ${c.count}`).join(' · ') : 'У сообщения нет реакций MAX.');
  });
}
