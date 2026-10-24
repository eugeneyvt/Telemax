import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Telegraf, Telegram } from 'telegraf';
import type { MaxClient } from '../src/max/client.js';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { ChatMapStore } from '../src/store/chatMapStore.js';
import { SeparateGroups } from '../src/bridge/separateGroups.js';
import { standaloneMax, standaloneUpdate, installStandaloneTelegram } from '../src/bridge/standalone.js';
import { DeliveryQueue, journalMaxActions } from '../src/bridge/deliveryQueue.js';
import type { BridgeOptions } from '../src/bridge/sync.js';
import { DIR, OPCODES } from '../src/max/opcodes.js';
import { probeTopic } from '../src/bridge/sync.js';

let db: BridgeDatabase, directory: string, manager: SeparateGroups | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'telemax-groups-'));
  vi.spyOn(process, 'cwd').mockReturnValue(directory);
  vi.stubEnv('FILES', 'off'); vi.stubEnv('TELEMETRY', 'off'); vi.stubEnv('LOG_LEVEL', 'error');
  db = new BridgeDatabase(':memory:'); vi.useFakeTimers();
});
afterEach(async () => {
  await manager?.stop(); manager?.closeDatabases(); manager = undefined;
  db.close(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const info = { id: 123, is_bot: true as const, first_name: 'Bridge', username: 'bridge_bot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
const message = (id: number, text: string, chatId = -200, actor = 42) => ({ update_id: id, message: { message_id: id + 100, date: 1, from: { id: actor, is_bot: false, first_name: 'Owner' }, chat: { id: chatId, type: 'group', title: 'Fixture' }, text,
  ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0]!.length }] } : {}) } }) as any;

async function setup(memberCount = 2) {
  const calls: Array<{ method: string; payload: any }> = [];
  let count = memberCount, id = 1000; let inbox: any[] = [];
  vi.spyOn(Telegram.prototype, 'callApi').mockImplementation((async (method: string, payload: any) => {
    calls.push({ method, payload });
    if (method === 'getMe') return info;
    if (method === 'getUpdates') return inbox;
    if (method === 'getChat') return { id: Number(payload.chat_id), type: 'group', title: 'Fixture' };
    if (method === 'getChatMemberCount' || method === 'getChatMembersCount') return count;
    if (method === 'getChatMember') return payload.user_id === 42 ? { status: 'creator' } : { status: 'administrator', can_change_info: true, can_delete_messages: true };
    if (method.startsWith('send')) return { message_id: ++id, date: 1, chat: { id: Number(payload.chat_id), type: 'group' }, text: payload.text };
    return true;
  }) as typeof Telegram.prototype.callApi);
  const max = Object.assign(new EventEmitter(), { isLoggedIn: false, sendMessage: vi.fn(async (_c, _t, _a, _r, o) => ({ cid: o?.cid ?? ++id, messageId: BigInt(++id), attaches: [], time: Date.now() })),
    chatsInfo: vi.fn(async () => [{ id: 55, type: 'DIALOG', participants: { 1: Date.now(), 2: Date.now() } }]),
    getContactInfo: vi.fn(async () => [{ id: 2, names: [{ type: 'CUSTOM', name: 'Contact label' }] }]),
    getChatHistory: vi.fn(async () => []), getMessages: vi.fn(async () => []), getReactions: vi.fn(async () => []),
  }) as unknown as MaxClient;
  const sent = max.sendMessage; journalMaxActions(max, db);
  const map = new ChatMapStore(path.join(directory, 'main-map.json'));
  await map.upsert({ maxChatId: '55', telegramTopicId: 7, title: 'Contact label', createdAt: 'fixture', historyBackfillCursor: '1700000000000' });
  const bot = new Telegraf('123:FAKE_TOKEN'); bot.botInfo = info;
  const unavailable = async (): Promise<never> => { throw new Error('Forbidden fixture operation'); };
  const options: BridgeOptions = { max, bot, database: db, ownerUserId: 42, targetGroupId: '-10055', chatMapStore: map,
    getChats: () => [{ id: 55, type: 'DIALOG', participants: { 1: 1, 2: 1 } }], getMyAccountId: () => 1, getContactProfiles: () => new Map(), getActivePhone: () => '', getMaxState: () => ({ connected: true, lastLoginAt: 1 }),
    triggerFullResync: unavailable, killEverything: unavailable, suspendChatSync: unavailable,
    auth: { getLastKnownPhone: () => '', requestSms: unavailable, verifyCode: unavailable, checkPassword: unavailable }, pause: { start: () => {}, stop: () => true, until: () => null } };
  const make = () => new SeparateGroups(options, () => { const child = new Telegraf('123:FAKE_TOKEN'); child.botInfo = info; return child; });
  manager = make();
  const code = 'a'.repeat(32); db.set('separateRequests', code, { code, maxChatId: '55', title: 'Contact label', topicId: 7, created: Date.now() });
  async function bind(actor = 42) { await bot.handleUpdate(message(1, `/start separate_${code}`, -200, actor)); }
  const runtime = () => (manager as any).runtimes.get('55') as { db: BridgeDatabase; bridge: any; available: boolean };
  return { bot, max, sent, map, calls, bind, make, runtime, count: (n: number) => { count = n; }, inbox: (items: any[]) => { inbox = items; } };
}

describe('plain group isolation and delivery', () => {
  it('gives each destination an internal topic without changing the original Telegram update', () => {
    const original = message(1, 'hello'); const converted = standaloneUpdate(original) as any;
    expect(converted.message.message_thread_id).toBe(1); expect(original.message.message_thread_id).toBeUndefined();
  });
  it('strips internal topics from all Telegram calls and rejects a different destination or poller', async () => {
    const h = await setup(); const child = new Telegraf('123:FAKE_TOKEN');
    installStandaloneTelegram(child, '-200', () => true);
    await child.telegram.sendMessage('-200', 'hello', { message_thread_id: 1 });
    expect(h.calls.at(-1)).toMatchObject({ method: 'sendMessage', payload: { chat_id: '-200' } });
    expect(h.calls.at(-1)!.payload.message_thread_id).toBeUndefined();
    await expect(child.telegram.sendMessage('-201', 'wrong')).rejects.toThrow('mismatch');
    await expect(child.telegram.getUpdates(0, 100, 0, [])).rejects.toThrow('never poll');
  });
  it('never binds a third-party group, or a group with an extra participant', async () => {
    const h = await setup(3); await h.bind(99); expect(manager!.records()).toHaveLength(0);
    await h.bind(); expect(manager!.records()).toHaveLength(0); expect((await h.map.getByMaxChatId('55'))!.banned).not.toBe(true);
  });
  it('treats an unchanged plain-group name as alive for safe deletion probes', async () => {
    await setup();
    vi.mocked(Telegram.prototype.callApi).mockRejectedValueOnce({ response: { error_code: 400, description: 'Bad Request: chat title is not modified' } });
    const child = new Telegraf('123:FAKE_TOKEN'); installStandaloneTelegram(child, '-200', () => true);
    await expect(probeTopic(child, '-200', 1, 'Contact label')).resolves.toBe('alive');
  });
  it('keeps the old map/history and permanently associates one MAX chat with the new group', async () => {
    const h = await setup(); await h.bind();
    expect(manager!.records()).toMatchObject([{ maxChatId: '55', telegramChatId: '-200', state: 'active' }]);
    expect((await h.map.getByMaxChatId('55'))).toMatchObject({ separateTelegramChatId: '-200', telegramTopicId: 7, historyBackfillCursor: '1700000000000' });
    expect((await h.map.getByMaxChatId('55'))!.banned).not.toBe(true);
    expect(h.calls.some(c => c.method === 'setChatTitle' && c.payload.title === 'Contact label · MAX')).toBe(true);
    expect(h.calls.some(c => c.method === 'createForumTopic' || c.method === 'deleteForumTopic')).toBe(false);
  });
  it('commits a plain-group update before returning a polling batch, and sends it through only the child journal', async () => {
    const h = await setup(); await h.bind(); manager!.installInbox();
    const update = message(10, 'plain group text'); h.inbox([update]); await h.bot.telegram.getUpdates(0, 100, 0, []);
    const runtime = h.runtime(); expect(runtime.db.pending()).toHaveLength(1); expect(db.pending()).toHaveLength(0);
    (h.max as any).isLoggedIn = true;
    runtime.bridge.deliveryQueue.start(); await runtime.bridge.deliveryQueue.drain(); runtime.bridge.deliveryQueue.stop();
    expect(runtime.db.pending()).toHaveLength(0); expect(h.sent).toHaveBeenCalledTimes(1);
    expect(runtime.db.findLink('tg', '', 110)).toBeDefined();
    expect(db.effect('1:0')).toBeUndefined();
    expect(runtime.db.effect('1:0')?.status).toBe('done');
  });
  it('receives only the bound MAX chat and delivers it without a forum topic', async () => {
    const h = await setup(); await h.bind(); (h.max as any).isLoggedIn = true;
    h.runtime().bridge.chatSync.markCaughtUp('55');
    const before = h.calls.filter(c => c.method === 'sendMessage').length;
    h.max.emit('message', { dir: DIR.TX, opcode: OPCODES.PUSH_MESSAGE, payload: { chatId: 66, message: { id: 99n, sender: 2, time: Date.now(), text: 'other chat' } } });
    await Promise.resolve(); expect(h.calls.filter(c => c.method === 'sendMessage')).toHaveLength(before);
    h.max.emit('message', { dir: DIR.TX, opcode: OPCODES.PUSH_MESSAGE, payload: { chatId: 55, message: { id: 100n, sender: 2, time: Date.now(), text: 'bound chat' } } });
    await h.runtime().bridge.chatSync.runInChat('55', async () => {});
    const call = h.calls.find(c => c.method === 'sendMessage' && c.payload.text?.includes('bound chat'));
    expect(call?.payload.chat_id).toBe('-200'); expect(call?.payload.message_thread_id).toBeUndefined();
  });
  it('restores the same database and blocks delivery after the group gains another person', async () => {
    const h = await setup(); await h.bind(); const file = h.runtime().db.file;
    h.runtime().db.enqueue('saved-fixture', '55', { fixture: true });
    await manager!.stop(); manager!.closeDatabases(); h.count(3);
    manager = h.make(); await manager.start();
    expect(h.runtime().db.file).toBe(file); expect(h.runtime().db.pending()).toHaveLength(1);
    expect(h.runtime().available).toBe(false); expect(manager.health().failed).toBeGreaterThan(0);
  });
  it('shares a single cid allocator across databases even in the same millisecond', () => {
    vi.setSystemTime(1700000000000);
    const a = new BridgeDatabase(':memory:', () => db.nextCid()), b = new BridgeDatabase(':memory:', () => db.nextCid());
    expect(new Set([a.nextCid(), b.nextCid(), db.nextCid()]).size).toBe(3); a.close(); b.close();
  });
  it('routes poll answers without a chat id to the owning group inbox', async () => {
    const h = await setup(); await h.bind(); manager!.installInbox();
    h.runtime().db.set('poll', 'fixture-poll', { maxChatId: '55', maxMessageId: 99n, maxPollId: 9, answerIdByOptionIndex: [1] });
    h.inbox([{ update_id: 40, poll_answer: { poll_id: 'fixture-poll', user: { id: 42, is_bot: false, first_name: 'Owner' }, option_ids: [0] } }]);
    await h.bot.telegram.getUpdates(0, 100, 0, []);
    expect(h.runtime().db.pending()).toHaveLength(1); expect(db.pending()).toHaveLength(0);
  });
  it('persists the first message when it shares a polling batch with the binding command', async () => {
    const h = await setup(); manager!.installInbox();
    h.inbox([message(41, `/start separate_${'a'.repeat(32)}`), message(42, 'first accepted message')]);
    await h.bot.telegram.getUpdates(0, 100, 0, []);
    expect(manager!.records()).toHaveLength(1); expect(h.runtime().db.pending()).toHaveLength(1);
  });
  it('repairs an interrupted preparation before resuming old-topic traffic', async () => {
    const h = await setup(); await h.bind();
    const saved = await h.map.getByMaxChatId('55');
    await h.map.upsert({ ...saved!, separateTelegramChatId: undefined });
    await manager!.tick();
    expect((await h.map.getByMaxChatId('55'))!.separateTelegramChatId).toBe('-200');
  });
  it('keeps other MAX chats and other listeners outside a standalone facade', () => {
    const real = new EventEmitter() as MaxClient;
    const bound = standaloneMax(real, '55', () => true); const seen = vi.fn(); bound.client.on('message', seen);
    real.emit('message', { payload: { chatId: 66 } }); real.emit('message', { payload: { chatId: 55 } }); expect(seen).toHaveBeenCalledTimes(1);
    bound.close(); expect(real.listenerCount('message')).toBe(0);
  });
});
