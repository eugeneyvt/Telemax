import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import { BridgeDatabase } from '../store/bridgeDatabase.js';
import { ChatMapStore } from '../store/chatMapStore.js';
import { sealDedicatedToken, openDedicatedToken } from '../store/dedicatedToken.js';
import { DedicatedPolling } from '../telegram/dedicatedPolling.js';
import { installPollingInbox, currentDelivery } from './deliveryQueue.js';
import { standaloneMax, standaloneUpdate, standaloneTitle, installStandaloneTelegram } from './standalone.js';
import { wireBridge, type BridgeOptions, type WiredBridge } from './sync.js';
import { dialogParticipantIds, resolveChatName } from '../max/names.js';
import { maxFetch } from '../max/ca.js';
import { createLogger } from '../logger.js';

const logger = createLogger('dedicated-bots');
interface Request { code: string; maxChatId: string; title: string; topicId: number; created: number; username: string }
interface Candidate { botId: number; username: string; created: number }
export interface DedicatedBot { maxChatId: string; botId: number; username: string; title: string; created: number; state: 'waiting-start' | 'preparing' | 'active'; avatarKey?: string; error?: boolean }
interface Runtime { bot: Telegraf; db: BridgeDatabase; map: ChatMapStore; bridge: WiredBridge; poll: DedicatedPolling; available: boolean; detach(): void; identityAt: number }
interface Dependencies {
  createBot(token: string): Telegraf;
  previousChat(chatId: string): Promise<string | undefined>;
  groupChat(chatId: string): string | undefined;
  polling?: boolean;
}
const actor = (u: any) => u.message?.from?.id ?? u.edited_message?.from?.id ?? u.callback_query?.from?.id ?? u.message_reaction?.user?.id ?? u.poll_answer?.user?.id ?? u.managed_bot?.user?.id;
const api = (bot: Telegraf, method: string, payload: unknown = {}): Promise<any> => (bot.telegram.callApi as Function).call(bot.telegram, method, payload);
const expired = (r: Request) => Date.now() - r.created > 7 * 86_400_000;

/** One encrypted token, DM, durable queue and poll offset for each explicitly selected MAX chat. */
export class DedicatedBots {
  private readonly runtimes = new Map<string, Runtime>();
  private timer?: ReturnType<typeof setInterval>;
  private busy?: Promise<void>;
  private stopping = false;
  constructor(private readonly options: BridgeOptions, private readonly deps: Dependencies) {
    if (!options.database || !options.ownerUserId) throw new Error('Dedicated bots require persistence and an owner');
    options.bot.use(async (ctx, next) => {
      const u = ctx.update as any;
      const ownedEvent = u.managed_bot || u.message?.managed_bot_created || /^tlmx_bot_/.test(u.callback_query?.data ?? '');
      if (ownedEvent) {
        if (actor(u) === options.ownerUserId) { this.acceptManagement(ctx.update); await this.tick(); }
        if (u.callback_query && actor(u) === options.ownerUserId) await ctx.answerCbQuery().catch(() => {});
        return;
      }
      const code = /^\/start(?:@\w+)?\s+dedicate_([a-f0-9]{24})$/.exec(u.message?.text ?? '')?.[1];
      if (code && ctx.from?.id === options.ownerUserId && ctx.chat?.type === 'private') { await this.creationPrompt(code); return; }
      return next();
    });
    options.bot.command('bot', async ctx => {
      if (ctx.from?.id !== options.ownerUserId) return;
      const mapping = String(ctx.chat.id) === options.targetGroupId && ctx.message.message_thread_id
        ? await options.chatMapStore.getByTopicId(ctx.message.message_thread_id)
        : await options.chatMapStore.getByMaxChatId(deps.groupChat(String(ctx.chat.id)) ?? '');
      if (!mapping) { await ctx.reply('Выберите контакт через /bots или отправьте /bot в его теме.'); return; }
      await this.request(mapping.maxChatId);
      await ctx.reply('Откройте личку основного бота: там кнопка создания отдельного чата.', { reply_markup: { inline_keyboard: [[{ text: 'Создать отдельного бота', url: `https://t.me/${(options.bot.botInfo ?? await options.bot.telegram.getMe()).username}` }]] } });
    });
    options.bot.command('bots', async ctx => {
      if (ctx.from?.id !== options.ownerUserId || ![options.targetGroupId, String(options.ownerUserId)].includes(String(ctx.chat.id))) return;
      await ctx.reply('Отдельные чаты MAX:', { reply_markup: { inline_keyboard: [
        ...this.records().map(r => [{ text: `${standaloneTitle(r.title)}${r.state === 'active' ? '' : ' · нажмите Start'}`, url: `https://t.me/${r.username}` }]),
        [{ text: 'Выделить ещё один контакт', callback_data: 'tlmx_bot_pick:0' }],
      ] } });
    });
  }
  private get db(): BridgeDatabase { return this.options.database!; }
  records(): DedicatedBot[] { return this.db.values('dedicatedBots'); }
  byMax(chat: unknown): DedicatedBot | undefined { return this.db.get('dedicatedBots', String(chat)); }
  manages(chat: unknown): boolean { const r = this.byMax(chat); return !!r && r.state !== 'waiting-start'; }
  async request(chatId: string): Promise<void> {
    const mapping = await this.options.chatMapStore.getByMaxChatId(chatId);
    if (!mapping || mapping.banned || mapping.pendingUserId) return;
    const existing = this.byMax(chatId);
    if (existing) { await this.tell(`Чат уже выделен: https://t.me/${existing.username}`); return; }
    const pending = this.db.values<Request>('dedicatedRequests').find(r => r.maxChatId === chatId && !expired(r));
    const r = pending ?? { code: randomBytes(12).toString('hex'), maxChatId: chatId, title: mapping.title ?? 'Контакт', topicId: mapping.telegramTopicId,
      username: `mx_${randomBytes(10).toString('hex')}_bot`, created: Date.now() };
    this.db.set('dedicatedRequests', r.code, r);
    await this.creationPrompt(r.code);
  }
  private async creationPrompt(code: string): Promise<void> {
    const r = this.db.get<Request>('dedicatedRequests', code); if (!r || expired(r)) return;
    const me = await this.options.bot.telegram.getMe(); this.options.bot.botInfo = me;
    if (!(me as any).can_manage_bots) {
      await this.tell('Включите управление другими ботами у @BotFather для основного бота, затем повторите /bot в теме контакта.'); return;
    }
    await this.tell(`Создать отдельную личку «${standaloneTitle(r.title)}»? Telegram попросит подтвердить имя и username. После создания я предложу привязку к этому MAX-чату.`, {
      inline_keyboard: [[{ text: `Создать «${standaloneTitle(r.title).slice(0, 44)}»`, url: `https://t.me/newbot/${me.username}/${r.username}?name=${encodeURIComponent(standaloneTitle(r.title).slice(0, 64))}` }]],
    });
  }
  private tell(text: string, reply_markup?: unknown): Promise<any> {
    return api(this.options.bot, 'sendMessage', { chat_id: this.options.ownerUserId, text, ...(reply_markup ? { reply_markup } : {}) });
  }
  /** Persist the minimum management event before the main bot's polling offset can advance. */
  acceptManagement(update: Update): void {
    const u = update as any; if (actor(u) !== this.options.ownerUserId) return;
    const bot = u.managed_bot?.bot ?? u.message?.managed_bot_created?.bot;
    if (bot?.is_bot && Number.isSafeInteger(bot.id) && /^[a-z0-9_]{5,32}$/i.test(bot.username ?? '')) {
      this.db.set('dedicatedManagementInbox', String(u.update_id), { kind: 'candidate', botId: bot.id, username: bot.username, updateId: u.update_id });
    } else if (/^tlmx_bot_/.test(u.callback_query?.data ?? '')) {
      this.db.set('dedicatedManagementInbox', String(u.update_id), { kind: 'button', data: u.callback_query.data, updateId: u.update_id });
    }
  }
  installInbox(): void { installPollingInbox(this.options.bot, async u => this.acceptManagement(u)); }
  async start(): Promise<void> {
    for (const r of this.records()) await this.open(r).catch(() => logger.warn('Dedicated bot startup remains pending'));
    await this.tick(); this.timer = setInterval(() => void this.tick().catch(() => logger.warn('Dedicated bot maintenance remains pending')), 30_000); this.timer.unref();
  }
  tick(): Promise<void> { this.busy ??= this.maintain().finally(() => { this.busy = undefined; }); return this.busy; }
  private async maintain(): Promise<void> {
    if (this.stopping) return;
    for (const event of this.db.values<any>('dedicatedManagementInbox')) {
      try {
        if (event.kind === 'candidate') await this.candidate(event);
        else await this.button(event.data);
        this.db.delete('dedicatedManagementInbox', String(event.updateId));
      } catch { logger.warn('Dedicated bot management action remains saved'); }
    }
    for (const record of this.records()) {
      try {
        if (!this.runtimes.has(record.maxChatId)) await this.open(record);
        const runtime = this.runtimes.get(record.maxChatId)!;
        if (record.state === 'waiting-start') await this.boundNotice(record);
        if (runtime.db.get('dedicatedLifecycle', 'started') && record.state !== 'active') await this.activate(record);
        if (this.byMax(record.maxChatId)?.state === 'active' && this.options.max.isLoggedIn) await this.identity(this.byMax(record.maxChatId)!);
      } catch { logger.warn('Dedicated bot activation or identity remains pending'); }
    }
    await this.sync().catch(() => logger.warn('Dedicated bot history remains saved for catch-up'));
  }
  private async candidate(c: Candidate): Promise<void> {
    const record = this.records().find(r => r.botId === c.botId);
    if (record) {
      // A token rotation must not leave a second poller running with the previous token.
      const runtime = this.runtimes.get(record.maxChatId);
      if (runtime) { await runtime.poll.stop(); await runtime.bridge.stop(); runtime.detach(); runtime.db.close(); this.runtimes.delete(record.maxChatId); }
      await this.storeToken(record); await this.open(record); return;
    }
    this.db.set('dedicatedCandidates', String(c.botId), { ...c, created: Date.now() });
    const pending = this.db.values<Request>('dedicatedRequests').filter(r => !expired(r) && !this.byMax(r.maxChatId));
    const matched = pending.filter(r => r.username.toLowerCase() === c.username.toLowerCase());
    const choices = matched.length ? matched : pending;
    const key = `candidate:${c.botId}`;
    if (this.db.get('dedicatedNotices', key)) return;
    this.db.set('dedicatedNotices', key, true);
    await this.tell(`Бот @${c.username} создан. Подтвердите, какой MAX-чат к нему подключить. Новая переписка перенесётся после нажатия Start в его личке.`, {
      inline_keyboard: choices.slice(0, 20).map(r => [{ text: `Подключить «${r.title.slice(0, 40)}»`, callback_data: `tlmx_bot_bind:${r.code}:${c.botId}` }]),
    });
  }
  private async button(data: string): Promise<void> {
    const page = /^tlmx_bot_pick:(\d+)$/.exec(data);
    if (page) {
      const mappings = (await this.options.chatMapStore.list()).filter(m => !m.banned && !m.pendingUserId && !this.byMax(m.maxChatId));
      const n = Math.min(Number(page[1]), Math.max(0, mappings.length - 1));
      await this.tell('Выберите контакт или чат MAX:', { inline_keyboard: [
        ...mappings.slice(n, n + 8).map(m => [{ text: (m.title ?? m.maxChatId).slice(0, 50), callback_data: `tlmx_bot_select:${m.maxChatId}` }]),
        ...(n + 8 < mappings.length ? [[{ text: 'Дальше', callback_data: `tlmx_bot_pick:${n + 8}` }]] : []),
      ] }); return;
    }
    const selected = /^tlmx_bot_select:(-?\d+)$/.exec(data); if (selected) { await this.request(selected[1]!); return; }
    const bind = /^tlmx_bot_bind:([a-f0-9]{24}):(\d+)$/.exec(data); if (!bind) return;
    const request = this.db.get<Request>('dedicatedRequests', bind[1]!), candidate = this.db.get<Candidate>('dedicatedCandidates', bind[2]!);
    if (!request || expired(request) || !candidate) return;
    const existing = this.byMax(request.maxChatId);
    if (existing) {
      if (existing.botId === candidate.botId) {
        if (!this.runtimes.has(existing.maxChatId)) await this.open(existing);
        await this.boundNotice(existing);
      }
      return;
    }
    if (this.records().some(r => r.botId === candidate.botId)) throw new Error('Bot is already assigned to another MAX chat');
    const mapping = await this.options.chatMapStore.getByMaxChatId(request.maxChatId);
    if (!mapping || mapping.banned || mapping.pendingUserId) return;
    const record: DedicatedBot = { maxChatId: request.maxChatId, botId: candidate.botId, username: candidate.username, title: request.title, created: Date.now(), state: 'waiting-start' };
    await this.storeToken(record, true);
    await this.open(record);
    await this.boundNotice(record);
  }
  private async boundNotice(record: DedicatedBot): Promise<void> {
    if (this.db.get('dedicatedNotices', `bound:${record.botId}`)) return;
    this.db.set('dedicatedNotices', `bound:${record.botId}`, true);
    await this.tell(`«${record.title}» привязан к @${record.username}. Откройте его и нажмите Start.`, { inline_keyboard: [[{ text: 'Открыть отдельный чат', url: `https://t.me/${record.username}?start=bridge` }]] });
  }
  private async storeToken(record: DedicatedBot, newBinding = false): Promise<void> {
    const token = await api(this.options.bot, 'getManagedBotToken', { user_id: record.botId });
    const bot = this.deps.createBot(token), me = await bot.telegram.getMe();
    if (me.id !== record.botId || !me.is_bot || me.id === this.options.bot.botInfo?.id) throw new Error('Managed bot identity mismatch');
    await api(this.options.bot, 'setManagedBotAccessSettings', { user_id: record.botId, is_access_restricted: true, added_user_ids: [] });
    const sealed = sealDedicatedToken(token, record.botId, record.maxChatId);
    this.db.transaction(() => {
      this.db.set('dedicatedTokens', String(record.botId), sealed);
      if (newBinding) this.db.set('dedicatedBots', record.maxChatId, record);
    });
  }
  private async open(record: DedicatedBot): Promise<void> {
    const sealed = this.db.get<ReturnType<typeof sealDedicatedToken>>('dedicatedTokens', String(record.botId)); if (!sealed) throw new Error('Managed token missing');
    const bot = this.deps.createBot(openDedicatedToken(sealed, record.botId, record.maxChatId));
    bot.botInfo = await bot.telegram.getMe(); if (bot.botInfo.id !== record.botId) throw new Error('Managed identity mismatch');
    // Refuse to take over an existing webhook. Newly created bots have no webhook.
    const hook = await bot.telegram.getWebhookInfo(); if (hook.url) throw new Error('Managed bot has an existing webhook');
    const directory = path.join(process.cwd(), '.data', 'dedicated-bots', String(record.botId));
    const db = new BridgeDatabase(path.join(directory, 'bridge.sqlite'), () => this.db.nextCid());
    const map = new ChatMapStore(path.join(directory, 'chat-map.json'));
    if (!await map.getByMaxChatId(record.maxChatId)) await map.upsert({ maxChatId: record.maxChatId, telegramTopicId: 1, title: record.title, createdAt: new Date().toISOString() });
    const runtime = { available: record.state === 'active', identityAt: 0 } as Runtime;
    installStandaloneTelegram(bot, String(this.options.ownerUserId), () => runtime.available, 'bot');
    const call = bot.telegram.callApi.bind(bot.telegram);
    bot.telegram.callApi = (async (method: string, payload: any, extra: any) => {
      const result = await (call as Function)(method, payload, extra);
      return method === 'getUpdates' && Array.isArray(result) ? result.map(standaloneUpdate) : result;
    }) as typeof bot.telegram.callApi;
    bot.use(async (ctx, next) => {
      if (ctx.from?.id !== this.options.ownerUserId || (ctx.chat && (ctx.chat.type !== 'private' || ctx.chat.id !== this.options.ownerUserId))) return;
      const text = (ctx.message as { text?: string } | undefined)?.text ?? '';
      if (/^\/start(?:@\w+)?(?:\s|$)/.test(text)) {
        db.set('dedicatedLifecycle', 'started', true); void this.tick().catch(() => {});
        if (runtime.available && db.get('dedicatedLifecycle', 'welcomed')) await ctx.reply('Чат MAX подключён. Пишите сюда.'); return;
      }
      if (/^\/(kill|reboot|login|logout|saved|panel|newgroup|broadcast|bot|bots|devices)(?:@\w+)?(?:\s|$)/.test(text)
        || /^tlmx_(?:panel|sys|history):/.test((ctx.callbackQuery as any)?.data ?? '')) return;
      return next();
    });
    const scoped = standaloneMax(this.options.max, record.maxChatId, () => runtime.available);
    const forbidden = async (): Promise<never> => { throw new Error('Use the main bridge control bot'); };
    const bridge = wireBridge({ ...this.options, bot, max: scoped.client, database: db, chatMapStore: map, targetGroupId: String(this.options.ownerUserId),
      standalone: { maxChatId: record.maxChatId, stateDirectory: directory },
      getChats: () => this.options.getChats().filter((c: any) => String(c?.id) === record.maxChatId),
      killEverything: forbidden, logoutMax: forbidden, suspendChatSync: forbidden, closeOtherSessions: forbidden, restartBridge: undefined, triggerFullResync: () => this.sync(),
    });
    bot.catch(error => { if (currentDelivery()) throw error; logger.warn('Dedicated update handler remains pending'); });
    const commit = async (update: Update) => {
      if (actor(update) !== this.options.ownerUserId) return;
      const u = update as any, message = u.message ?? u.edited_message;
      if (message?.chat?.type === 'private' && String(message.chat.id) === String(this.options.ownerUserId)) db.set('dedicatedLifecycle', 'started', true);
      await bridge.acceptUpdate(update, true);
    };
    const poll = new DedicatedPolling(bot, db, commit, async update => {
      if (db.get('dedicatedLifecycle', 'started') && this.byMax(record.maxChatId)?.state !== 'active') void this.tick().catch(() => {});
      await bot.handleUpdate(update);
    });
    Object.assign(runtime, { bot, db, map, bridge, poll, detach: scoped.close }); this.runtimes.set(record.maxChatId, runtime);
    if (this.deps.polling !== false) poll.start();
  }
  private async activate(record: DedicatedBot): Promise<void> {
    if (!this.options.max.isLoggedIn) return;
    const runtime = this.runtimes.get(record.maxChatId)!;
    // Freeze both old routing and restart recovery before waiting out in-flight source deliveries.
    this.db.set('dedicatedBots', record.maxChatId, { ...record, state: 'preparing' });
    const original = await this.options.chatMapStore.getByMaxChatId(record.maxChatId); if (!original) throw new Error('Original chat mapping missing');
    await this.options.chatMapStore.upsert({ ...original, dedicatedBotId: record.botId });
    const cursor = await this.deps.previousChat(record.maxChatId);
    if (this.db.pending(1_000_000).some(job => job.chat === record.maxChatId)) throw new Error('Previous delivery queue must settle first');
    const source = await this.options.chatMapStore.getByMaxChatId(record.maxChatId);
    const current = (await runtime.map.getByMaxChatId(record.maxChatId))!;
    const best = Math.max(Number(current.historyBackfillCursor ?? 0), Number(cursor ?? source?.historyBackfillCursor ?? 0));
    await runtime.map.upsert({ ...current, ...(best > 0 ? { historyBackfillCursor: String(best) } : {}) });
    this.db.set('dedicatedBots', record.maxChatId, { ...record, state: 'active' }); runtime.available = true;
    runtime.bridge.deliveryQueue?.wake();
    await this.identity(this.byMax(record.maxChatId)!);
    if (!runtime.db.get('dedicatedLifecycle', 'welcomed')) {
      runtime.db.set('dedicatedLifecycle', 'welcomed', true);
      await runtime.bot.telegram.sendMessage(this.options.ownerUserId!, 'Чат MAX подключён. Пишите сюда.');
    }
  }
  private async identity(record: DedicatedBot): Promise<void> {
    const runtime = this.runtimes.get(record.maxChatId)!;
    if (Date.now() - runtime.identityAt < 15 * 60_000) return;
    const raw = this.options.getChats().find((c: any) => String(c?.id) === record.maxChatId) ?? (await this.options.max.chatsInfo([record.maxChatId]))[0]; if (!raw) return;
    const ids = dialogParticipantIds([raw], this.options.getMyAccountId());
    const profile = ids[0] != null ? (await this.options.max.getContactInfo([ids[0]]))[0] : undefined;
    if (profile && ids[0] != null) this.options.getContactProfiles().set(ids[0], profile);
    const title = resolveChatName(raw, this.options.getMyAccountId(), this.options.getContactProfiles());
    const name = standaloneTitle(title).slice(0, 64);
    await api(runtime.bot, 'setMyName', { name });
    const photo = (profile ?? raw) as { baseRawUrl?: string; baseUrl?: string; photoId?: unknown };
    const url = photo.baseRawUrl ?? photo.baseUrl, avatarKey = url ? createHash('sha256').update(String(photo.photoId ?? url)).digest('hex') : undefined;
    if (url && avatarKey !== record.avatarKey && new URL(url).protocol === 'https:') {
      const response = await maxFetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 10 * 1024 * 1024) throw new Error('Avatar unavailable');
      const data = Buffer.from(await response.arrayBuffer()); if (data.length > 10 * 1024 * 1024) throw new Error('Avatar too large');
      // Telegraf 4 predates InputProfilePhoto: encode the nested JSON and attach the binary explicitly.
      await api(runtime.bot, 'setMyProfilePhoto', { photo: JSON.stringify({ type: 'static', photo: 'attach://avatar' }), avatar: { source: data, filename: 'max-avatar.jpg' } });
    }
    this.db.set('dedicatedBots', record.maxChatId, { ...this.byMax(record.maxChatId)!, title, avatarKey }); runtime.identityAt = Date.now();
  }
  async sync(): Promise<void> {
    if (!this.options.max.isLoggedIn || this.stopping) return;
    for (const record of this.records()) {
      const r = this.runtimes.get(record.maxChatId); if (!r?.available) continue;
      await r.bridge.chatSync.runInChat(record.maxChatId, async () => { await r.bridge.chatSync.ensureCaughtUp(record.maxChatId); });
    }
  }
  health() {
    const states = [...this.runtimes.values()].map(r => r.db.health()); const oldest = states.flatMap(s => s.oldestAt == null ? [] : [s.oldestAt]);
    return { pending: states.reduce((n, s) => n + s.pending, 0), failed: states.reduce((n, s) => n + s.failed, 0) + this.records().filter(r => !this.runtimes.has(r.maxChatId)).length
      + [...this.runtimes.values()].filter(r => r.poll.failed || Date.now() - r.poll.lastPollAt > 180_000).length,
      uncertain: states.reduce((n, s) => n + s.uncertain, 0), oldestAt: oldest.length ? Math.min(...oldest) : null,
      incoming: [...this.runtimes.values()].reduce((n, r) => n + r.db.values('incomingPending').length, 0) };
  }
  async stop(): Promise<void> {
    this.stopping = true; if (this.timer) clearInterval(this.timer); await this.busy;
    for (const r of this.runtimes.values()) { await r.poll.stop(); await r.bridge.stop(); r.detach(); }
  }
  closeDatabases(): void { for (const r of this.runtimes.values()) r.db.close(); }
}
