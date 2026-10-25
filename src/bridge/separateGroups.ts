import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import { BridgeDatabase } from '../store/bridgeDatabase.js';
import { ChatMapStore } from '../store/chatMapStore.js';
import { wireBridge, type BridgeOptions, type WiredBridge } from './sync.js';
import { standaloneMax, standaloneUpdate, standaloneTitle, installStandaloneTelegram } from './standalone.js';
import { installPollingInbox, currentDelivery } from './deliveryQueue.js';
import { dialogParticipantIds, resolveChatName } from '../max/names.js';
import { maxFetch } from '../max/ca.js';
import { createLogger } from '../logger.js';

const logger = createLogger('separate-groups');
interface Request { code: string; maxChatId: string; title: string; topicId: number; created: number }
export interface SeparateGroup extends Request { telegramChatId: string; state: 'preparing' | 'active' | 'blocked' | 'dedicated'; reason?: string; avatarKey?: string; cursor?: string }
interface Runtime { bot: Telegraf; bridge: WiredBridge; db: BridgeDatabase; available: boolean; detach(): void }
const actor = (u: any): number | undefined => u.message?.from?.id ?? u.edited_message?.from?.id ?? u.callback_query?.from?.id ?? u.message_reaction?.user?.id ?? u.poll_answer?.user?.id ?? u.my_chat_member?.from?.id;
const chat = (u: any): string => String(u.message?.chat?.id ?? u.edited_message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? u.message_reaction?.chat?.id ?? u.my_chat_member?.chat?.id);
const text = (u: any): string => u.message?.text ?? '';
const tokenOf = (u: Update): string | undefined => /^\/start(?:@\w+)?\s+separate_([a-f0-9]{32})\s*$/.exec(text(u))?.[1];

/** One MAX connection and one Telegram poller; each bound group has its own durable delivery DB. */
export class SeparateGroups {
  private readonly runtimes = new Map<string, Runtime>();
  private timer?: ReturnType<typeof setInterval>;
  private busy?: Promise<void>;
  private stopping = false;
  private readonly identityAt = new Map<string, number>();
  constructor(private readonly options: BridgeOptions, private readonly createBot: () => Telegraf) {
    if (!options.database || options.ownerUserId == null) throw new Error('Separate groups require persistence and an explicit owner.');
    const bot = options.bot;
    bot.use(async (ctx, next) => {
      const group = this.forUpdate(ctx.update);
      if (group) {
        if (actor(ctx.update) !== options.ownerUserId) return;
        if (group.state === 'dedicated') { await ctx.reply('Новая переписка перенесена в отдельного бота. Список: /bots в основной группе. Здесь сохранена прежняя история.'); return; }
        const runtime = this.runtimes.get(group.maxChatId);
        if (!runtime || !runtime.available) { await ctx.reply('Пересылка остановлена. В группе должны быть только владелец и бот с правами администратора.'); return; }
        await runtime.bot.handleUpdate(standaloneUpdate(ctx.update)); return;
      }
      if (tokenOf(ctx.update) && actor(ctx.update) === options.ownerUserId) {
        this.saveBindingIntent(ctx.update); await this.tick(); return;
      }
      return next();
    });
    bot.command('separate', async ctx => {
      if (ctx.from?.id !== options.ownerUserId || String(ctx.chat.id) !== options.targetGroupId) return;
      const topicId = ctx.message.message_thread_id;
      const mapping = topicId ? await options.chatMapStore.getByTopicId(topicId) : undefined;
      if (!mapping || mapping.pendingUserId) { await ctx.reply('Отправьте /separate внутри темы нужного MAX-чата.'); return; }
      if (mapping.dedicatedBotId) { await ctx.reply('Чат уже выделен в отдельного бота. Список: /bots'); return; }
      const bound = this.byMax(mapping.maxChatId);
      if (bound) { await ctx.reply('Этот чат уже привязан к отдельной группе. Список: /groups'); return; }
      const request: Request = { code: randomBytes(16).toString('hex'), maxChatId: mapping.maxChatId, title: mapping.title ?? 'Чат MAX', topicId: topicId!, created: Date.now() };
      this.db.set('separateRequests', request.code, request);
      const username = bot.botInfo?.username ?? (await bot.telegram.getMe()).username;
      const url = `https://t.me/${username}?startgroup=separate_${request.code}&admin=change_info+delete_messages+pin_messages`;
      await ctx.reply(`Создайте новую закрытую группу только с собой и ботом. После добавления дайте боту права администратора и отправьте в новой группе:\n/start separate_${request.code}\n\nМост установит имя «${standaloneTitle(request.title)}» и доступную аватарку MAX. Новая переписка пойдёт туда; прежняя история и связи останутся в этой теме.`, {
        message_thread_id: topicId, reply_markup: { inline_keyboard: [[{ text: 'Создать отдельную группу', url }]] },
      });
    });
    bot.command('groups', async ctx => {
      if (ctx.from?.id !== options.ownerUserId || String(ctx.chat.id) !== options.targetGroupId) return;
      const records = this.records();
      await ctx.reply(records.length ? records.map(r => `${standaloneTitle(r.title)} — ${r.state === 'active' ? 'подключена' : 'остановлена: проверьте состав и права бота'}`).join('\n') : 'Отдельных групп пока нет. /separate в теме MAX-чата — создать привязку.');
    });
  }
  private get db(): BridgeDatabase { return this.options.database!; }
  records(): SeparateGroup[] { return this.db.values<SeparateGroup>('separateGroups'); }
  byMax(id: unknown): SeparateGroup | undefined { return this.db.get('separateGroups', String(id)); }
  byTelegram(id: string): SeparateGroup | undefined { return this.forTelegram(id); }
  async retireForBot(chatId: string): Promise<string | undefined> {
    const record = this.byMax(chatId); if (!record) return undefined;
    if (record.state === 'dedicated') return record.cursor;
    const runtime = this.runtimes.get(chatId);
    if (!runtime) throw new Error('Previous group is unavailable; binding remains pending');
    await runtime.bridge.deliveryQueue?.drain();
    if (runtime.db.pending(1).length || runtime.db.values('incomingPending').length) throw new Error('Previous group has unresolved deliveries');
    runtime.available = false;
    await runtime.bridge.stop(); runtime.detach();
    const stateDirectory = path.dirname(runtime.db.file);
    const map = new ChatMapStore(path.join(stateDirectory, 'chat-map.json'));
    const cursor = (await map.getByMaxChatId(chatId))?.historyBackfillCursor;
    this.db.set('separateGroups', chatId, { ...record, state: 'dedicated', cursor });
    return cursor;
  }
  private forTelegram(id: string): SeparateGroup | undefined { return this.records().find(r => r.telegramChatId === id); }
  private forUpdate(update: Update): SeparateGroup | undefined {
    const pollId = (update as any).poll_answer?.poll_id;
    return pollId ? this.records().find(r => this.runtimes.get(r.maxChatId)?.db.get('poll', pollId)) : this.forTelegram(chat(update));
  }
  private saveBindingIntent(update: Update): void {
    if (tokenOf(update) && actor(update) === this.options.ownerUserId) this.db.set('separateBindInbox', String(update.update_id), update);
  }
  installInbox(): void {
    installPollingInbox(this.options.bot, async update => {
      this.saveBindingIntent(update);
      // A binding command and its first message can share the same polling batch. Open the
      // durable destination before the next update is acknowledged, not in later middleware.
      if (tokenOf(update) && actor(update) === this.options.ownerUserId) await this.tick();
      const record = this.forUpdate(update);
      if (!record) return;
      const runtime = this.runtimes.get(record.maxChatId);
      if ((update as any).message?.new_chat_members || (update as any).message?.left_chat_member || (update as any).my_chat_member || (update as any).message?.migrate_to_chat_id) {
        if (runtime) runtime.available = false; // Stop relaying before acknowledging a membership change.
      }
      if (actor(update) === this.options.ownerUserId && runtime) await runtime.bridge.acceptUpdate(standaloneUpdate(update), true);
    });
  }
  async start(): Promise<void> {
    for (const record of this.records()) if (record.state !== 'dedicated') await this.open(record);
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch(() => logger.warn('Separate-group maintenance remains pending')), 30_000); this.timer.unref();
  }
  async sync(): Promise<void> {
    if (!this.options.max.isLoggedIn || this.stopping) return;
    for (const record of this.records()) {
      const runtime = this.runtimes.get(record.maxChatId);
      if (runtime?.available) await runtime.bridge.chatSync.runInChat(record.maxChatId, async () => { await runtime.bridge.chatSync.ensureCaughtUp(record.maxChatId); });
    }
  }
  tick(): Promise<void> {
    this.busy ??= this.maintain().finally(() => { this.busy = undefined; });
    return this.busy;
  }
  private async maintain(): Promise<void> {
    if (this.stopping) return;
    for (const update of this.db.values<Update>('separateBindInbox')) {
      try { await this.bind(update); this.db.delete('separateBindInbox', String(update.update_id)); }
      catch (error) {
        // No raw update/token/content in operational logs.
        logger.warn('Group binding remains saved', { errorName: (error as Error).name });
      }
    }
    for (const record of this.records()) {
      if (record.state === 'dedicated') continue;
      const original = await this.options.chatMapStore.getByMaxChatId(record.maxChatId);
      if (original && original.separateTelegramChatId !== record.telegramChatId) {
        await this.options.chatMapStore.upsert({ ...original, separateTelegramChatId: record.telegramChatId });
      }
      const valid = await this.verify(record.telegramChatId).catch(() => false);
      const runtime = this.runtimes.get(record.maxChatId);
      if (runtime) runtime.available = valid;
      if (!valid) { this.db.set('separateGroups', record.maxChatId, { ...record, state: 'blocked', reason: 'membership-or-permissions' }); continue; }
      if (record.state !== 'active') this.db.set('separateGroups', record.maxChatId, { ...record, state: 'active', reason: undefined });
      if (!runtime) await this.open({ ...record, state: 'active' });
      if (this.options.max.isLoggedIn) await this.refreshIdentity(record).catch(() => logger.warn('Separate-group identity refresh remains pending'));
    }
    await this.sync().catch(() => logger.warn('Separate-group history remains saved for catch-up'));
  }
  private async verify(id: string): Promise<boolean> {
    const api = this.options.bot.telegram;
    const me = this.options.bot.botInfo ?? await api.getMe();
    const [info, count, owner, bot] = await Promise.all([api.getChat(id), api.getChatMembersCount(id), api.getChatMember(id, this.options.ownerUserId!), api.getChatMember(id, me.id)]);
    return ['group', 'supergroup'].includes(info.type) && !('is_forum' in info && info.is_forum)
      && count === 2 && ['creator', 'administrator'].includes(owner.status) && bot.status === 'administrator'
      && bot.can_change_info === true && bot.can_delete_messages === true;
  }
  private async bind(update: Update): Promise<void> {
    const code = tokenOf(update); if (!code || actor(update) !== this.options.ownerUserId) return;
    const request = this.db.get<Request>('separateRequests', code);
    const destination = chat(update);
    if (!request || Date.now() - request.created > 7 * 86_400_000 || destination === this.options.targetGroupId || !/^-\d+$/.test(destination)) return;
    const existing = this.byMax(request.maxChatId);
    if (existing && existing.telegramChatId !== destination) return; // Never steal an existing binding.
    if (this.forTelegram(destination)?.maxChatId && this.forTelegram(destination)!.maxChatId !== request.maxChatId) return;
    if (!await this.verify(destination)) {
      // Keep the invitation reusable after the owner grants the required rights.
      const key = `groupBindingNotice:${update.update_id}`;
      if (!this.db.get('separateNotices', key)) {
        this.db.set('separateNotices', key, true);
        await this.options.bot.telegram.sendMessage(destination, 'Для подключения нужны: новая группа без тем, только вы и бот; бот — администратор с правами менять информацию и удалять сообщения. После настройки повторите /start с тем же кодом.');
      }
      return;
    }
    const original = await this.options.chatMapStore.getByMaxChatId(request.maxChatId);
    if (!original || original.pendingUserId || (!existing && original.banned)) return;
    const record: SeparateGroup = existing ?? { ...request, telegramChatId: destination, state: 'preparing', cursor: original.historyBackfillCursor };
    this.db.set('separateGroups', record.maxChatId, record);
    // State and cursor are committed before the old destination is paused. Startup can complete
    // any interrupted preparation without forgetting accepted updates or message aliases.
    await this.options.chatMapStore.upsert({ ...original, separateTelegramChatId: destination });
    if (!this.runtimes.has(record.maxChatId)) await this.open(record);
    this.db.set('separateGroups', record.maxChatId, { ...record, state: 'active' });
    await this.refreshIdentity(record);
    const key = `${record.maxChatId}:intro`;
    if (!this.db.get('separateNotices', key)) {
      this.db.set('separateNotices', key, true); // An uncertain Telegram ACK must not duplicate setup cards.
      const old = this.options.targetGroupId.startsWith('-100') ? `https://t.me/c/${this.options.targetGroupId.slice(4)}/${record.topicId}` : '';
      await this.options.bot.telegram.sendMessage(destination, `Чат MAX подключён. Пишите прямо в эту группу.\n${old ? `Прежняя история: ${old}\n` : ''}`, { disable_notification: true });
    }
  }
  private async open(record: SeparateGroup): Promise<void> {
    const stateDirectory = path.join(process.cwd(), '.data', 'separate-groups', createHash('sha256').update(record.maxChatId).digest('hex').slice(0, 24));
    const map = new ChatMapStore(path.join(stateDirectory, 'chat-map.json'));
    if (!await map.getByMaxChatId(record.maxChatId)) await map.upsert({ maxChatId: record.maxChatId, telegramTopicId: 1, title: record.title, createdAt: new Date().toISOString(), historyBackfillCursor: record.cursor });
    const database = new BridgeDatabase(path.join(stateDirectory, 'bridge.sqlite'), () => this.db.nextCid());
    const bot = this.createBot(); bot.botInfo = this.options.bot.botInfo ?? await this.options.bot.telegram.getMe();
    const runtime = { available: await this.verify(record.telegramChatId).catch(() => false) } as Runtime;
    installStandaloneTelegram(bot, record.telegramChatId, () => runtime.available);
    bot.use(async (ctx, next) => {
      if (ctx.from?.id !== this.options.ownerUserId || !runtime.available) return;
      if (/^\/(kill|reboot|login|logout|saved|panel|newgroup|broadcast)(?:@\w+)?(?:\s|$)/.test(text(ctx.update)) || /^tlmx_(?:panel|sys|history):/.test((ctx.callbackQuery as any)?.data ?? '')) {
        await ctx.reply('Системное управление доступно в основной группе MAX. Здесь — переписка с одним чатом.'); return;
      }
      return next();
    });
    const scoped = standaloneMax(this.options.max, record.maxChatId, () => runtime.available);
    const forbidden = async (): Promise<never> => { throw new Error('Use the main bridge control group for this operation.'); };
    const bridge = wireBridge({ ...this.options, standalone: { maxChatId: record.maxChatId, stateDirectory }, bot, max: scoped.client, database, chatMapStore: map, targetGroupId: record.telegramChatId,
      getChats: () => this.options.getChats().filter((c: any) => String(c?.id) === record.maxChatId), triggerFullResync: () => this.sync(), killEverything: forbidden, logoutMax: forbidden, suspendChatSync: forbidden, restartBridge: undefined });
    bot.catch(error => { if (currentDelivery()) throw error; logger.warn('Separate-group update remains saved', { errorName: (error as Error).name }); });
    Object.assign(runtime, { bot, db: database, bridge, detach: scoped.close }); this.runtimes.set(record.maxChatId, runtime);
  }
  private async refreshIdentity(record: SeparateGroup): Promise<void> {
    if (Date.now() - (this.identityAt.get(record.maxChatId) ?? 0) < 15 * 60_000) return;
    const raw = this.options.getChats().find((c: any) => String(c?.id) === record.maxChatId) ?? (await this.options.max.chatsInfo([record.maxChatId]))[0];
    if (!raw) return;
    const ids = dialogParticipantIds([raw], this.options.getMyAccountId());
    const profile = ids[0] != null ? (await this.options.max.getContactInfo([ids[0]]))[0] : undefined;
    if (profile && ids[0] != null) this.options.getContactProfiles().set(ids[0], profile);
    const profiles = new Map(this.options.getContactProfiles()); if (profile && ids[0] != null) profiles.set(ids[0], profile);
    const title = resolveChatName(raw, this.options.getMyAccountId(), profiles);
    const current = this.byMax(record.maxChatId)!;
    if (current.state !== 'active') return;
    const nameKey = `name:${record.telegramChatId}`;
    if (this.db.get('separateIdentity', nameKey) !== title) {
      await this.options.bot.telegram.setChatTitle(record.telegramChatId, standaloneTitle(title)).catch(error => { if (!/not modified/i.test((error as Error).message)) throw error; });
      this.db.set('separateIdentity', nameKey, title); this.db.set('separateGroups', record.maxChatId, { ...current, title });
    }
    const photo = (profile ?? raw) as { baseRawUrl?: string; baseUrl?: string; photoId?: unknown };
    const url = photo.baseRawUrl ?? photo.baseUrl;
    const avatarKey = url && createHash('sha256').update(String(photo.photoId ?? url)).digest('hex');
    if (url && avatarKey !== this.byMax(record.maxChatId)?.avatarKey && new URL(url).protocol === 'https:') {
      const response = await maxFetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 10 * 1024 * 1024) throw new Error('Avatar download unavailable');
      const data = Buffer.from(await response.arrayBuffer()); if (data.length > 10 * 1024 * 1024) throw new Error('Avatar too large');
      await this.options.bot.telegram.setChatPhoto(record.telegramChatId, { source: data, filename: 'max-avatar.jpg' });
      this.db.set('separateGroups', record.maxChatId, { ...this.byMax(record.maxChatId)!, avatarKey });
    }
    this.identityAt.set(record.maxChatId, Date.now());
  }
  health(): { pending: number; failed: number; uncertain: number; oldestAt: number | null; incoming: number } {
    const all = [...this.runtimes.values()]; const states = all.map(r => r.db.health());
    const ages = states.flatMap(s => s.oldestAt == null ? [] : [s.oldestAt]);
    return { pending: states.reduce((n, s) => n + s.pending, 0), failed: states.reduce((n, s) => n + s.failed, 0) + this.records().filter(r => r.state !== 'active' && r.state !== 'dedicated').length,
      uncertain: states.reduce((n, s) => n + s.uncertain, 0), oldestAt: ages.length ? Math.min(...ages) : null, incoming: all.reduce((n, r) => n + r.db.values('incomingPending').length, 0) };
  }
  async stop(): Promise<void> {
    this.stopping = true; if (this.timer) clearInterval(this.timer); await this.busy;
    for (const runtime of this.runtimes.values()) { await runtime.bridge.stop(); runtime.detach(); }
  }
  closeDatabases(): void { for (const runtime of this.runtimes.values()) runtime.db.close(); }
}
