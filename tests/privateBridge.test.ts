import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Telegraf, Telegram } from 'telegraf';
import type { MaxClient } from '../src/max/client.js';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { MessageLinkStore, wireBridge, type WiredBridge } from '../src/bridge/sync.js';
import { FileShare } from '../src/bridge/fileShare.js';
import { BroadcastStore } from '../src/store/broadcastStore.js';
import type { ChatMapStore } from '../src/store/chatMapStore.js';
import { telegramDestination } from '../src/telegram/destination.js';
import { OPCODES, DIR } from '../src/max/opcodes.js';

let db: BridgeDatabase;
let wired: WiredBridge;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubEnv('TELEMETRY', 'off'); vi.stubEnv('FILES', 'off'); vi.stubEnv('LOG_LEVEL', 'error');
  vi.spyOn(FileShare.prototype, 'init').mockResolvedValue(undefined);
  vi.spyOn(FileShare.prototype, 'startBackground').mockImplementation(() => {});
  vi.spyOn(BroadcastStore.prototype, 'forChat').mockResolvedValue([]);
});
afterEach(async () => { wired?.deliveryQueue?.stop(); await wired?.deliveryQueue?.drain(); db?.close(); vi.clearAllTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

async function harness(pending = false) {
  db = new BridgeDatabase(':memory:');
  let id = 100;
  const calls: Array<{ method: string; payload: any }> = [];
  const inbox: any[] = [];
  vi.spyOn(Telegram.prototype, 'callApi').mockImplementation((async (method: string, payload: any) => {
    calls.push({ method, payload });
    if (method === 'getUpdates') return inbox;
    if (method === 'getChatMember') throw new Error('getChatMember is not available in a private chat');
    if (method === 'createForumTopic') return { message_thread_id: ++id, name: payload.name };
    return { message_id: ++id, date: 1, chat: { id: 42, type: 'private' }, text: payload?.text };
  }) as typeof Telegram.prototype.callApi);
  const max = Object.assign(new EventEmitter(), {
    isLoggedIn: true,
    sendMessage: vi.fn(async (_chat: unknown, _text: unknown, _attaches?: unknown, _reply?: unknown, options?: { cid?: number }) => ({ cid: options?.cid ?? ++id, messageId: BigInt(++id), attaches: [], time: Date.now() })),
    sendToNewDialog: vi.fn(async (_user: unknown, _text: unknown, _attaches?: unknown, _reply?: unknown, options?: { cid?: number }) => ({ chatId: '55', cid: options?.cid ?? ++id, messageId: BigInt(++id), attaches: [], time: Date.now() })),
    editMessage: vi.fn(async () => {}), deleteMessages: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}), pinMessage: vi.fn(async () => {}),
    chatsInfo: vi.fn(async () => [] as unknown[]),
  });
  const spies = { sendMessage: max.sendMessage, sendToNewDialog: max.sendToNewDialog, editMessage: max.editMessage, markRead: max.markRead, pinMessage: max.pinMessage, chatsInfo: max.chatsInfo };
  let mapping = { maxChatId: pending ? 'pending:99' : '55', telegramTopicId: 7, createdAt: 'x', ...(pending ? { pendingUserId: '99' } : {}) };
  const store = {
    getByTopicId: vi.fn(async (topic: number) => topic === 7 ? mapping : undefined),
    getByMaxChatId: vi.fn(async (chat: unknown) => String(chat) === mapping.maxChatId ? mapping : undefined),
    remove: vi.fn(async () => {}), upsert: vi.fn(async (next: typeof mapping) => { mapping = next; return mapping; }),
    list: vi.fn(async () => [mapping]), advanceHistoryCursor: vi.fn(async () => {}),
  } as unknown as ChatMapStore;
  const bot = new Telegraf('123456:LOCAL_FAKE_TOKEN');
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Audit', username: 'audit_bot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
  bot.catch(e => { throw e; });
  const auth = { getLastKnownPhone: () => '', requestSms: vi.fn(async () => {}), verifyCode: vi.fn(async () => ({ ok: true as const })), checkPassword: vi.fn(async () => {}) };
  wired = wireBridge({ max: max as unknown as MaxClient, bot, database: db, ownerUserId: 42, targetGroupId: '42', chatMapStore: store,
    getChats: () => [{ id: 55, type: 'DIALOG' }], getMyAccountId: () => 1, getContactProfiles: () => new Map(), getActivePhone: () => '', getMaxState: () => ({ connected: true, lastLoginAt: 1 }),
    triggerFullResync: async () => {}, killEverything: async () => ({ endedOnMax: false }), suspendChatSync: async () => () => {}, auth,
    pause: { start: () => {}, stop: () => true, until: () => null },
  });
  wired.deliveryQueue!.stop(); await wired.deliveryQueue!.drain();
  let updateId = 1;
  function message(text: string, extras: Record<string, unknown> = {}, fromId = 42, topic: number | undefined = 7) {
    const command = /^\/\w+/.exec(text)?.[0];
    return { update_id: updateId++, message: { message_id: 20, date: 1, from: { id: fromId, is_bot: false, first_name: 'Owner' }, chat: { id: 42, type: 'private' as const }, message_thread_id: topic, text, ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command.length }] } : {}), ...extras } } as any;
  }
  async function processQueue() { wired.deliveryQueue!.start(); await wired.deliveryQueue!.drain(); wired.deliveryQueue!.stop(); }
  async function maxEdit(text: string) {
    wired.chatSync.markCaughtUp('55');
    max.emit('message', { dir: DIR.TX, opcode: OPCODES.PUSH_MESSAGE, payload: { chatId: '55', message: { id: 900n, time: Date.now(), sender: 2, status: 'EDITED', text } } });
    await wired.chatSync.runInChat('55', async () => {});
  }
  return { bot, max: spies, calls, auth, inbox, message, processQueue, maxEdit };
}
describe('private topics and real update routing', () => {
  it('opens only the explicitly verified Saved Messages chat without sending to MAX', async () => {
    const h = await harness(); h.max.chatsInfo.mockResolvedValue([{ id: 0, status: 'ACTIVE' }]);
    await h.bot.handleUpdate(h.message('/saved', {}, 42, undefined));
    expect(h.max.chatsInfo).toHaveBeenCalledWith([0]);
    expect(h.calls.some(c => c.method === 'createForumTopic' && c.payload.name === 'Избранное')).toBe(true);
    expect(h.max.sendMessage).not.toHaveBeenCalled(); expect(h.max.sendToNewDialog).not.toHaveBeenCalled();
  });
  it('does not open a substitute dialog when Saved Messages is unavailable', async () => {
    const h = await harness(); h.max.chatsInfo.mockResolvedValue([{ id: 55, status: 'ACTIVE' }]);
    await h.bot.handleUpdate(h.message('/saved', {}, 42, undefined));
    expect(h.calls.some(c => c.method === 'createForumTopic')).toBe(false);
    expect(h.max.sendMessage).not.toHaveBeenCalled(); expect(h.max.sendToNewDialog).not.toHaveBeenCalled();
  });
  it('defaults to private mode and refuses a missing/untrusted owner', () => {
    expect(telegramDestination({ TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_OWNER_ID: '42' })).toEqual({ chatId: '42', ownerUserId: 42, mode: 'private' });
    expect(() => telegramDestination({ TELEGRAM_BOT_TOKEN: 'fake' })).toThrow('TELEGRAM_OWNER_ID');
    expect(telegramDestination({ TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_OWNER_ID: '00042' }).chatId).toBe('42');
    expect(() => telegramDestination({ TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_OWNER_ID: '4.2e1' })).toThrow('TELEGRAM_OWNER_ID');
  });
  it('stores a private-topic message, deduplicates its update, sends it and preserves formatting', async () => {
    const h = await harness();
    const update = h.message('hello', { entities: [{ type: 'bold', offset: 0, length: 5 }] });
    await h.bot.handleUpdate(update); await h.bot.handleUpdate(update);
    expect(db.pending()).toHaveLength(1); expect(h.max.sendMessage).not.toHaveBeenCalled();
    await h.processQueue(); expect(db.pending()).toEqual([]); expect(h.max.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.max.sendMessage.mock.calls[0]?.[4]).toMatchObject({ elements: [{ type: 'STRONG', from: 0, length: 5 }] });
    expect(new MessageLinkStore(1, db).getByTelegram(20)?.outgoing).toBe(true);
    await h.bot.handleUpdate(update); await h.processQueue(); expect(h.max.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('does not authorize another person, even when an update names the configured private chat', async () => {
    const h = await harness(); await h.bot.handleUpdate(h.message('intruder', {}, 99)); await h.processQueue();
    expect(h.max.sendMessage).not.toHaveBeenCalled(); expect(db.pending()).toEqual([]);
  });
  it('freezes an edit target that was unresolved when the original and its edit arrived in one batch', async () => {
    const h = await harness(); const original = h.message('short');
    const edited = { update_id: 200, edited_message: { ...original.message, text: 'x'.repeat(4096) } };
    await h.bot.handleUpdate(original); await h.bot.handleUpdate(edited as any);
    expect(db.pending()).toHaveLength(2);
    await h.processQueue();
    const saved = db.job(2)!.payload as { link?: { maxMessageId: unknown; extraMaxMessageIds?: unknown[] } };
    const link = new MessageLinkStore(1, db).getByTelegram(20)!;
    expect(saved.link?.maxMessageId).toEqual(link.maxMessageId);
    expect(saved.link?.extraMaxMessageIds ?? []).toEqual([]);
    expect(link.extraMaxMessageIds).toHaveLength(1);
    expect(h.max.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.max.editMessage).toHaveBeenCalledTimes(1);
    expect(db.pending()).toEqual([]);
  });
  it('opens a pending dialog once and sends its next already-queued message to the real chat', async () => {
    const h = await harness(true);
    await h.bot.handleUpdate(h.message('first', { message_id: 20 }));
    await h.bot.handleUpdate(h.message('second', { message_id: 21 }));
    await h.processQueue();
    expect(h.max.sendToNewDialog).toHaveBeenCalledTimes(1);
    expect(h.max.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.max.sendMessage.mock.calls[0]?.slice(0, 2)).toEqual(['55', 'second']);
    expect(db.job(1)?.chat).toBe('55'); expect(db.job(2)?.chat).toBe('55');
    expect(db.pending()).toEqual([]);
  });
  it('keeps SMS authorization outside the queue and does not query group membership', async () => {
    const h = await harness(); await h.bot.handleUpdate(h.message('/login', {}, 42, undefined));
    await h.bot.handleUpdate(h.message('+79999999999', {}, 42, undefined));
    expect(h.auth.requestSms).toHaveBeenCalledWith('+79999999999');
    expect(db.pending()).toEqual([]); expect(h.calls.some(c => c.method === 'getChatMember')).toBe(false);
  });
  it('never journals authorization secrets arriving in a topic in the same polling batch as /login', async () => {
    const h = await harness();
    h.inbox.push(h.message('/login'), h.message('+79999999999'), h.message('123456'));
    await h.bot.telegram.callApi('getUpdates', {});
    expect(db.pending()).toEqual([]);
  });
  it('does not reinterpret an older queued text as an SMS code or phone during a newer login flow', async () => {
    const h = await harness(); await h.bot.handleUpdate(h.message('+79999999999'));
    await h.bot.handleUpdate(h.message('/login'));
    await h.processQueue();
    expect(h.auth.requestSms).not.toHaveBeenCalled();
    expect(h.max.sendMessage.mock.calls[0]?.[1]).toBe('+79999999999');
    expect(db.pending()).toEqual([]);
  });
  it('read, pin and unpin address the linked MAX message and run through the queue', async () => {
    const h = await harness();
    new MessageLinkStore(1, db).add({ maxChatId: '55', maxMessageId: 900n, telegramMessageId: 77, textTelegramMessageIds: [77] });
    const reply_to_message = { message_id: 77, text: 'message from MAX' };
    await h.bot.handleUpdate(h.message('/read', { reply_to_message }));
    await h.bot.handleUpdate(h.message('/pin', { reply_to_message }));
    await h.bot.handleUpdate(h.message('/unpin'));
    await h.processQueue();
    expect(h.max.markRead).toHaveBeenCalledWith('55', 900n);
    expect(h.max.pinMessage).toHaveBeenCalledWith('55', 900n, false);
    expect(h.max.pinMessage).toHaveBeenCalledWith('55', null, false);
    expect(db.pending()).toEqual([]);
    expect(h.max.sendMessage).not.toHaveBeenCalled();
  });
  it('persists a real MAX edit push before applying it to the linked private-topic message', async () => {
    const h = await harness();
    new MessageLinkStore(1, db).add({ maxChatId: '55', maxMessageId: 900n, telegramMessageId: 77, textTelegramMessageIds: [77] });
    await h.maxEdit('x'.repeat(5000));
    expect(db.pending()).toHaveLength(1);
    expect(h.calls.some(c => c.method === 'editMessageText')).toBe(false);
    await h.processQueue();
    expect(db.pending()).toEqual([]);
    expect(h.calls.filter(c => c.method === 'editMessageText')).toHaveLength(1);
    const link = new MessageLinkStore(1, db).getByMax('55', 900n)!;
    expect(link.textTelegramMessageIds).toHaveLength(2);
    const sends = h.calls.filter(c => c.method === 'sendMessage').length;
    await h.maxEdit('x'.repeat(5000)); await h.processQueue();
    expect(h.calls.filter(c => c.method === 'sendMessage')).toHaveLength(sends);
  });
});
