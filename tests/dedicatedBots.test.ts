import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Telegraf, Telegram } from 'telegraf';
import { DedicatedBots } from '../src/bridge/dedicatedBots.js';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { ChatMapStore } from '../src/store/chatMapStore.js';
import { MessageLinkStore, type BridgeOptions } from '../src/bridge/sync.js';
import type { MaxClient } from '../src/max/client.js';
import { standaloneUpdate } from '../src/bridge/standalone.js';
import { DedicatedPolling } from '../src/telegram/dedicatedPolling.js';
import { sealDedicatedToken, openDedicatedToken } from '../src/store/dedicatedToken.js';
import { removeReceiptCards } from '../src/bridge/receiptCleanup.js';
import { DIR, OPCODES } from '../src/max/opcodes.js';
import { SettingsStore } from '../src/store/settingsStore.js';
import { initializeStandaloneHistory } from '../src/bridge/standaloneHistory.js';
import { maxFetch } from '../src/max/ca.js';

vi.mock('../src/max/ca.js', async original => ({ ...await original<object>(), maxFetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) }));
let directory: string, db: BridgeDatabase, manager: DedicatedBots | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'telemax-dedicated-')); vi.spyOn(process, 'cwd').mockReturnValue(directory);
  vi.stubEnv('MAX_SESSION_KEY', '11'.repeat(32)); vi.stubEnv('FILES', 'off'); vi.stubEnv('TELEMETRY', 'off'); vi.stubEnv('LOG_LEVEL', 'error');
  vi.useFakeTimers(); db = new BridgeDatabase(path.join(directory, 'root.sqlite'));
});
afterEach(async () => {
  await manager?.stop(); manager?.closeDatabases(); manager = undefined; db.close();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
});
const token = '456:DEDICATED_FAKE_TOKEN';
const info = { id: 123, is_bot: true, first_name: 'Root', username: 'root_bot', can_manage_bots: true } as any;
const msg = (id: number, text: string, owner = 42, destination = -10055) => ({ update_id: id, message: { message_id: id, date: 1,
  from: { id: owner, is_bot: false, first_name: 'Owner' }, chat: { id: destination, type: destination > 0 ? 'private' : 'supergroup', title: 'Fixture' },
  message_thread_id: 7, text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}) } }) as any;

async function setup() {
  let inbox: any[] = [], counter = 1000, managerEnabled = true, childName = 'Root', nameBlocked = false;
  const calls: Array<{ id: number; method: string; payload: any }> = [];
  vi.spyOn(Telegram.prototype, 'callApi').mockImplementation((async function (this: any, method: string, payload: any) {
    const child = this.token === token, id = child ? 456 : 123; calls.push({ id, method, payload });
    if (method === 'getMe') return child ? { ...info, id: 456, username: 'contact_bot', first_name: childName } : { ...info, can_manage_bots: managerEnabled };
    if (method === 'setMyName') {
      if (nameBlocked) throw { response: { error_code: 429, parameters: { retry_after: 86400 } } };
      childName = payload.name; return true;
    }
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getManagedBotToken') return token;
    if (method === 'getUpdates') return inbox;
    if (method === 'getChat') return { id: payload.chat_id, type: Number(payload.chat_id) > 0 ? 'private' : 'supergroup' };
    if (method.startsWith('send')) return { message_id: ++counter, chat: { id: payload.chat_id, type: 'private' }, date: 1, text: payload.text };
    return true;
  }) as typeof Telegram.prototype.callApi);
  const max = Object.assign(new EventEmitter(), { isLoggedIn: false, getChatHistory: vi.fn(async () => []), getMessages: vi.fn(async () => []), getReactions: vi.fn(async () => []),
    chatsInfo: vi.fn(async () => [{ id: 55, type: 'DIALOG', participants: { 1: 1, 2: 1 } }]),
    getContactInfo: vi.fn(async () => [{ id: 2, names: [{ type: 'CUSTOM', name: 'Метка контакта' }], baseUrl: 'https://example.invalid/avatar.jpg' }]),
    sendMessage: vi.fn(async (_chat, _text, _att, _reply, options) => ({ cid: options?.cid ?? ++counter, messageId: BigInt(++counter), time: Date.now(), attaches: [] })), markRead: vi.fn(async () => {}),
  }) as unknown as MaxClient;
  const profiles = new Map();
  const settings = new SettingsStore(path.join(directory, 'settings.json')); await settings.set({ readOnReply: true });
  const map = new ChatMapStore(path.join(directory, 'map.json'));
  await map.upsert({ maxChatId: '55', telegramTopicId: 7, title: 'Метка контакта', createdAt: 'fixture', historyBackfillCursor: '1700000000000' });
  let bot = new Telegraf('123:ROOT_FAKE_TOKEN'); bot.botInfo = info;
  const forbidden = async (): Promise<never> => { throw new Error('Fixture operation forbidden'); };
  const options = (): BridgeOptions => ({ bot, max, database: db, ownerUserId: 42, targetGroupId: '-10055', chatMapStore: map, settings,
    getChats: () => [{ id: 55, type: 'DIALOG', participants: { 1: 1, 2: 1 } }], getMyAccountId: () => 1, getContactProfiles: () => profiles, getActivePhone: () => '',
    getMaxState: () => ({ connected: true, lastLoginAt: 1 }), triggerFullResync: forbidden, killEverything: forbidden, suspendChatSync: forbidden,
    auth: { getLastKnownPhone: () => '', requestSms: forbidden, verifyCode: forbidden, checkPassword: forbidden }, pause: { start: () => {}, stop: () => true, until: () => null } });
  const previousChat = vi.fn(async () => '1700000000000');
  const make = () => new DedicatedBots(options(), { createBot: t => new Telegraf(t), previousChat, groupChat: () => undefined, polling: false });
  manager = make();
  async function request() { await bot.handleUpdate(msg(1, '/bot')); return db.values<any>('dedicatedRequests')[0]; }
  async function candidate(name?: string) {
    const r = db.values<any>('dedicatedRequests')[0];
    manager!.acceptManagement({ update_id: 2, managed_bot: { user: { id: 42 }, bot: { id: 456, is_bot: true, username: name ?? r.username } } } as any); await manager!.tick();
  }
  async function bind() {
    const r = db.values<any>('dedicatedRequests')[0];
    manager!.acceptManagement({ update_id: 3, callback_query: { from: { id: 42 }, data: `tlmx_bot_bind:${r.code}:456` } } as any); await manager!.tick();
  }
  const runtime = () => (manager as any).runtimes.get('55') as any;
  return { get bot() { return bot; }, max, map, settings, calls, request, candidate, bind, runtime, previousChat,
    inbox: (u: any[]) => { inbox = u; }, enable: (v: boolean) => { managerEnabled = v; },
    blockName: () => { nameBlocked = true; },
    restart: async () => { await manager!.stop(); manager!.closeDatabases(); bot = new Telegraf('123:ROOT_FAKE_TOKEN'); bot.botInfo = info; manager = make(); await manager.start(); } };
}

describe('dedicated MAX bot provisioning', () => {
  it('offers an owner-confirmed Telegram creation button with a unique username', async () => {
    const h = await setup(); const r = await h.request();
    const prompt = h.calls.find(c => c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.url?.includes('/newbot/'));
    expect(prompt?.payload.chat_id).toBe(42);
    const url = new URL(prompt!.payload.reply_markup.inline_keyboard[0][0].url);
    expect(url.pathname).toBe(`/newbot/root_bot/${r.username}`); expect(url.searchParams.get('name')).toBe('Метка контакта · MAX');
    expect(r.username).toMatch(/^mx_[a-f0-9]{20}_bot$/); expect(manager!.records()).toHaveLength(0);
  });
  it('rejects outsiders and handles a disabled management capability without pretending to create a bot', async () => {
    const h = await setup(); await h.bot.handleUpdate(msg(1, '/bot', 99)); expect(db.values('dedicatedRequests')).toHaveLength(0);
    h.enable(false); await h.request(); expect(h.calls.some(c => c.payload.text?.includes('@BotFather'))).toBe(true);
    expect(h.calls.some(c => c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.url?.includes('/newbot/'))).toBe(false);
  });
  it('saves managed events before returning the Telegram polling batch', async () => {
    const h = await setup(); await h.request(); manager!.installInbox();
    h.inbox([{ update_id: 10, managed_bot: { user: { id: 42 }, bot: { id: 456, is_bot: true, username: 'renamed_bot' } } }]);
    await h.bot.telegram.getUpdates(0, 100, 0, []);
    expect(db.values('dedicatedManagementInbox')).toHaveLength(1); expect(db.values('dedicatedCandidates')).toHaveLength(0);
  });
  it('requires explicit contact confirmation even if the user changes the suggested bot username', async () => {
    const h = await setup(); await h.request(); await h.candidate('renamed_bot');
    expect(manager!.records()).toHaveLength(0);
    expect(h.calls.some(c => c.payload.text?.includes('@renamed_bot') && c.payload.reply_markup?.inline_keyboard[0][0].callback_data.startsWith('tlmx_bot_bind:'))).toBe(true);
    await h.bind(); expect(manager!.records()[0]?.username).toBe('renamed_bot');
  });
  it('encrypts tokens, restricts access to the owner and leaves the source active until Start', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind();
    expect(JSON.stringify(db.values('dedicatedTokens'))).not.toContain(token);
    expect(h.calls.some(c => c.method === 'setManagedBotAccessSettings' && c.payload.is_access_restricted === true && c.payload.added_user_ids.length === 0)).toBe(true);
    expect(manager!.manages('55')).toBe(false); expect((await h.map.getByMaxChatId('55'))?.dedicatedBotId).toBeUndefined();
    expect(h.previousChat).not.toHaveBeenCalled();
  });
  it('rolls token and binding back together if committing the pairing fails', async () => {
    const h = await setup(); await h.request(); await h.candidate();
    const set = db.set.bind(db);
    const fault = vi.spyOn(db, 'set').mockImplementation((kind, key, value) => { if (kind === 'dedicatedBots') throw new Error('Disk full'); set(kind, key, value); });
    await h.bind(); expect(db.values('dedicatedTokens')).toHaveLength(0); expect(manager!.records()).toHaveLength(0);
    expect(db.values('dedicatedManagementInbox')).toHaveLength(1);
    fault.mockRestore(); await manager!.tick(); expect(manager!.records()).toHaveLength(1); expect(db.values('dedicatedTokens')).toHaveLength(1);
  });
  it('freezes the old destination after Start and gives the new bot its own history cursor', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind(); (h.max as any).isLoggedIn = true;
    await h.runtime().poll.batch([standaloneUpdate(msg(20, '/start bridge', 42, 42))]); await manager!.tick();
    expect(manager!.manages('55')).toBe(true); expect(h.previousChat).toHaveBeenCalledWith('55');
    expect((await h.map.getByMaxChatId('55'))?.dedicatedBotId).toBe(456);
    expect((await h.runtime().map.getByMaxChatId('55'))?.historyBackfillCursor).toBeUndefined();
    expect(h.calls.some(c => c.id === 456 && c.method === 'setMyName' && c.payload.name === 'Метка контакта · MAX')).toBe(true);
    const avatar = h.calls.find(c => c.id === 456 && c.method === 'setMyProfilePhoto');
    expect(JSON.parse(avatar!.payload.photo)).toEqual({ type: 'static', photo: 'attach://avatar' }); expect(Buffer.isBuffer(avatar!.payload.avatar.source)).toBe(true);
  });
  it('backfills older messages skipped by the source cursor, then resumes without duplicates', async () => {
    vi.useRealTimers();
    const h = await setup(); await h.request(); await h.candidate(); await h.bind();
    const now = Date.now(); await h.map.advanceHistoryCursor('55', now - 1000);
    vi.mocked(h.max.getChatHistory).mockResolvedValue([{ id: 90n, sender: 2, time: now - 60_000, text: 'older missing history' }]);
    (h.max as any).isLoggedIn = true;
    const started = h.runtime().poll.batch([standaloneUpdate(msg(50, '/start bridge', 42, 42))]);
    await started; await manager!.tick(); await manager!.sync();
    expect(h.calls.filter(c => c.id === 456 && c.method === 'sendMessage' && c.payload.text?.includes('older missing history'))).toHaveLength(1);
    expect(h.max.markRead).not.toHaveBeenCalled();
    await h.restart();
    expect(h.calls.filter(c => c.id === 456 && c.method === 'sendMessage' && c.payload.text?.includes('older missing history'))).toHaveLength(1);
  }, 15000);
  it('selects the MAX JPEG avatar instead of its original WebP image', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind();
    vi.mocked(h.max.getContactInfo).mockResolvedValue([{ id: 2, names: [{ type: 'CUSTOM', name: 'Метка контакта' }], baseUrl: 'https://example.invalid/square.jpg', baseRawUrl: 'https://example.invalid/original.webp', photoId: 33 }]);
    (h.max as any).isLoggedIn = true;
    await h.runtime().poll.batch([standaloneUpdate(msg(55, '/start bridge', 42, 42))]); await manager!.tick();
    expect(vi.mocked(maxFetch)).toHaveBeenCalledWith('https://example.invalid/square.jpg', expect.any(Object));
    expect(h.calls.some(c => c.method === 'setMyProfilePhoto')).toBe(true);
    const changes = h.calls.filter(c => c.method === 'setMyName').length;
    await h.restart(); expect(h.calls.filter(c => c.method === 'setMyName')).toHaveLength(changes);
  });
  it('updates the avatar even when Telegram rate-limits name changes and preserves its cooldown', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind(); h.blockName();
    (h.max as any).isLoggedIn = true;
    await h.runtime().poll.batch([standaloneUpdate(msg(56, '/start bridge', 42, 42))]); await manager!.tick();
    expect(h.calls.some(c => c.method === 'setMyProfilePhoto')).toBe(true);
    expect(db.get<number>('dedicatedIdentity', 'nameRetry:456')).toBeGreaterThan(Date.now());
    await h.restart(); expect(h.calls.filter(c => c.method === 'setMyName')).toHaveLength(1);
  });
  it('repairs a legacy destination once and preserves local aliases and later progress', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind();
    const r = h.runtime(); r.db.delete('standaloneHistory', 'destination-v1');
    await r.map.advanceHistoryCursor('55', 1700000000000);
    new MessageLinkStore(100, r.db).add({ maxChatId: '55', maxMessageId: 77n, telegramMessageId: 99 });
    await initializeStandaloneHistory(r.db, r.map, '55');
    expect((await r.map.getByMaxChatId('55')).historyBackfillCursor).toBeUndefined();
    expect(r.db.findLink('tg', '', 99)).toBeDefined();
    await r.map.advanceHistoryCursor('55', 1700000000001); await initializeStandaloneHistory(r.db, r.map, '55');
    expect((await r.map.getByMaxChatId('55')).historyBackfillCursor).toBe('1700000000001');
  });
  it('marks only the frozen delivered boundary after a confirmed reply and safely retries a failed read mark', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind(); (h.max as any).isLoggedIn = true;
    await h.runtime().poll.batch([standaloneUpdate(msg(60, '/start bridge', 42, 42))]); await manager!.tick();
    const r = h.runtime(); r.bridge.deliveryQueue.stop();
    new MessageLinkStore(100, r.db).add({ maxChatId: '55', maxMessageId: 80n, telegramMessageId: 800 });
    await r.poll.batch([standaloneUpdate(msg(61, 'my reply', 42, 42))]);
    new MessageLinkStore(100, r.db).add({ maxChatId: '55', maxMessageId: 81n, telegramMessageId: 801 });
    vi.mocked(h.max.markRead).mockRejectedValueOnce(new Error('Read mark refused'));
    r.bridge.deliveryQueue.start(); await r.bridge.deliveryQueue.drain(); r.bridge.deliveryQueue.stop();
    expect(h.max.sendMessage).toHaveBeenCalledTimes(1); expect(h.max.markRead).toHaveBeenCalledWith('55', 80n);
    const job = r.db.pending()[0]; expect(job.status).toBe('failed'); r.db.retryJob(job.id);
    r.bridge.deliveryQueue.start(); await r.bridge.deliveryQueue.drain(); r.bridge.deliveryQueue.stop();
    expect(h.max.sendMessage).toHaveBeenCalledTimes(1); expect(h.max.markRead).toHaveBeenLastCalledWith('55', 80n);
    expect(r.db.pending()).toHaveLength(0);
    const before = vi.mocked(h.max.markRead).mock.calls.length;
    const edit = standaloneUpdate(msg(62, 'edited reply', 42, 42)) as any; edit.edited_message = { ...edit.message, message_id: 61 }; delete edit.message;
    await r.poll.batch([edit]); r.bridge.deliveryQueue.start(); await r.bridge.deliveryQueue.drain(); r.bridge.deliveryQueue.stop();
    expect(h.max.markRead).toHaveBeenCalledTimes(before);
  });
  it('does not mark messages read when sending fails or the reply policy is disabled', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind(); (h.max as any).isLoggedIn = true;
    await h.runtime().poll.batch([standaloneUpdate(msg(70, '/start bridge', 42, 42))]); await manager!.tick();
    const r = h.runtime(); new MessageLinkStore(100, r.db).add({ maxChatId: '55', maxMessageId: 80n, telegramMessageId: 800 });
    vi.mocked(h.max.sendMessage).mockRejectedValueOnce(new Error('Send refused'));
    await r.poll.batch([standaloneUpdate(msg(71, 'failed reply', 42, 42))]); await r.bridge.deliveryQueue.drain();
    expect(h.max.markRead).not.toHaveBeenCalled();
    r.db.cancelPending(); await h.settings.set({ readOnReply: false });
    await r.poll.batch([standaloneUpdate(msg(72, 'reply with auto-read disabled', 42, 42))]); await r.bridge.deliveryQueue.drain();
    expect(h.max.sendMessage).toHaveBeenCalledTimes(2); expect(h.max.markRead).not.toHaveBeenCalled();
  });
  it('persists owner messages before offset advancement while source deliveries prevent migration', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind();
    h.previousChat.mockRejectedValue(new Error('Previous queue unresolved')); (h.max as any).isLoggedIn = true;
    await h.runtime().poll.batch([standaloneUpdate(msg(21, 'first owner message', 42, 42))]); await manager!.tick();
    expect(h.runtime().db.pending()).toHaveLength(1); expect(h.runtime().db.get('dedicatedPolling', 'offset')).toBe(22);
    expect(h.max.sendMessage).not.toHaveBeenCalled(); expect(manager!.byMax('55')?.state).toBe('preparing');
    h.previousChat.mockResolvedValue('1700000000000'); await manager!.tick(); await h.runtime().bridge.deliveryQueue.drain();
    expect(h.max.sendMessage).toHaveBeenCalledTimes(1); expect(h.runtime().db.pending()).toHaveLength(0);
  });
  it('isolates other accounts, destinations and MAX chats and does not emit automatic read cards', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind(); (h.max as any).isLoggedIn = true;
    await h.runtime().poll.batch([standaloneUpdate(msg(22, '/start bridge', 42, 42))]); await manager!.tick();
    const count = h.calls.length;
    await h.runtime().poll.batch([standaloneUpdate(msg(23, 'outsider', 99, 99))]); expect(h.runtime().db.pending()).toHaveLength(0);
    await expect(h.runtime().bot.telegram.sendMessage(99, 'wrong')).rejects.toThrow('mismatch');
    h.max.emit('message', { dir: DIR.TX, opcode: OPCODES.PUSH_MESSAGE, payload: { chatId: 66, message: { id: 1n, sender: 2, time: Date.now(), text: 'other chat' } } });
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.calls.slice(count).some(c => c.method === 'sendMessage' && /other chat|Прочтение в MAX/.test(c.payload.text))).toBe(false);
  });
  it('restores the same queue, aliases and poll offset after reconstructing all bot runtimes', async () => {
    const h = await setup(); await h.request(); await h.candidate(); await h.bind();
    await h.runtime().poll.batch([standaloneUpdate(msg(24, 'saved before MAX reconnect', 42, 42))]);
    const file = h.runtime().db.file; await h.restart();
    expect(h.runtime().db.file).toBe(file); expect(h.runtime().db.pending()).toHaveLength(1); expect(h.runtime().db.get('dedicatedPolling', 'offset')).toBe(25);
  });
});

describe('dedicated polling and receipt retirement', () => {
  it('keeps earlier committed jobs without acknowledging a partially saved polling batch', async () => {
    const commit = vi.fn(async (u: any) => { if (u.update_id === 11) throw new Error('Disk full'); db.enqueue(`fixture:${u.update_id}`, '55', u); });
    const handle = vi.fn(), poll = new DedicatedPolling(new Telegraf('123:ROOT_FAKE_TOKEN'), db, commit, handle);
    await expect(poll.batch([msg(10, 'first'), msg(11, 'second')])).rejects.toThrow('Disk full');
    expect(db.pending()).toHaveLength(1); expect(db.get('dedicatedPolling', 'offset')).toBeUndefined(); expect(handle).not.toHaveBeenCalled();
    commit.mockImplementation(async (u: any) => { db.enqueue(`fixture:${u.update_id}`, '55', u); });
    await poll.batch([msg(10, 'first'), msg(11, 'second')]); expect(db.pending()).toHaveLength(2); expect(db.get('dedicatedPolling', 'offset')).toBe(12);
  });
  it('aborts a stalled request and stops its retry without losing the stored offset', async () => {
    const bot = new Telegraf('123:ROOT_FAKE_TOKEN');
    const call = vi.spyOn(bot.telegram, 'callApi').mockImplementation((async (_m: unknown, _p: unknown, extra: any) => new Promise((_resolve, reject) => {
      extra.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    })) as any);
    db.set('dedicatedPolling', 'offset', 123);
    const poll = new DedicatedPolling(bot, db, async () => {}, async () => {}); poll.start();
    await vi.advanceTimersByTimeAsync(90_100); expect(poll.failed).toBe(true); expect(call).toHaveBeenCalledTimes(1);
    await poll.stop(); expect(db.get('dedicatedPolling', 'offset')).toBe(123);
  });
  it('never advances the polling offset when a batch could not be committed', async () => {
    const bot = new Telegraf('123:ROOT_FAKE_TOKEN'), commit = vi.fn().mockRejectedValue(new Error('Disk full')), handle = vi.fn();
    const poll = new DedicatedPolling(bot, db, commit, handle);
    await expect(poll.batch([msg(10, 'hello')])).rejects.toThrow('Disk full');
    expect(db.get('dedicatedPolling', 'offset')).toBeUndefined(); expect(handle).not.toHaveBeenCalled();
  });
  it('rejects token ciphertext copied to a different bot or MAX chat', () => {
    const sealed = sealDedicatedToken(token, 456, '55'); expect(openDedicatedToken(sealed, 456, '55')).toBe(token);
    expect(() => openDedicatedToken(sealed, 456, '66')).toThrow(); expect(() => openDedicatedToken(sealed, 789, '55')).toThrow();
  });
  it('removes only recorded cards, tolerates already deleted messages and clears automatic rendering state', async () => {
    db.set('readCards', '55:7', { id: 100, text: 'old' }); db.set('readCards', '66:8', { id: 101, text: 'old' }); db.set('readCardPending', '55:7', true);
    db.set('meta', 'other', 'preserved');
    const deleteMessage = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce({ response: { error_code: 400, description: 'message to delete not found' } });
    await removeReceiptCards(db, { telegram: { deleteMessage } } as any, '-10055');
    expect(deleteMessage.mock.calls).toEqual([['-10055', 100], ['-10055', 101]]); expect(db.values('readCards')).toHaveLength(0); expect(db.get('meta', 'other')).toBe('preserved');
  });
  it('preserves card ids for safe cleanup retries after a definite Telegram failure', async () => {
    db.set('readCards', '55:7', { id: 100 }); const deleteMessage = vi.fn().mockRejectedValue({ response: { error_code: 403, description: 'forbidden' } });
    await expect(removeReceiptCards(db, { telegram: { deleteMessage } } as any, '-10055')).rejects.toBeDefined(); expect(db.values('readCards')).toHaveLength(1);
  });
});
