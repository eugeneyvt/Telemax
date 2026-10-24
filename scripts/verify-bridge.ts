/** Owner-only API acceptance. Production must be stopped first. No getUpdates is called.
 * Genuine Telegram fixture files and genuine MAX readbacks traverse the real bridge through
 * synthetic owner updates / isolated MAX events. A separate DB and empty broadcast store keep
 * the probe out of production delivery state and unrelated destinations.
 */
import { once, EventEmitter } from 'node:events';
import { mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import { MaxClient } from '../src/max/client.js';
import { SessionStore } from '../src/store/sessionStore.js';
import { ChatMapStore } from '../src/store/chatMapStore.js';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { wireBridge, MessageLinkStore, type WiredBridge } from '../src/bridge/sync.js';
import { extractMyAccountId } from '../src/max/names.js';
import { OPCODES, DIR } from '../src/max/opcodes.js';
import type { PollWidget } from '../src/bridge/pollWidgets.js';

if (process.env.TELEMAX_ACCEPTANCE !== 'owner-test') throw new Error('Explicit owner-only acceptance required');
process.umask(0o077);
process.env.LOG_LEVEL = 'error'; process.env.TELEMETRY = 'off'; process.env.FILES = 'off';
const root = process.cwd();
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), syntheticUpdateLayer: true, checks: {} };
const checks = report.checks as Record<string, unknown>;
const output = path.join(root, '.data/acceptance-bridge.json');
const store = new SessionStore();
const session = await store.load();
if (!session) throw new Error('Existing encrypted session required');
const target = process.env.TARGET_TELEGRAM_GROUP!;
const owner = Number(process.env.TELEGRAM_OWNER_ID);
if (!target?.startsWith('-100') || !Number.isSafeInteger(owner)) throw new Error('Private owner group required');
const saved = await new ChatMapStore(path.join(root, `.data/telegram-${target}/chat-map.json`)).getByMaxChatId('0');
if (!saved || saved.banned) throw new Error('Existing Saved topic required');
const client = new MaxClient({ host: process.env.MAX_HOST || undefined, sni: process.env.MAX_SNI || undefined, reconnect: false });
client.on('error', () => {});
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
let wired: WiredBridge | undefined, db: BridgeDatabase | undefined;
let stage = 'connect';
const deadline = setTimeout(() => { client.disconnect(); process.exitCode = 1; }, 240_000);
const assert = (value: unknown, label: string): void => { if (!value) throw new Error(label); };
try {
  const ready = once(client, 'ready'); client.connect(); await ready;
  stage = 'resume';
  const login = await client.login(session.sessionToken);
  await store.save({ ...session, deviceId: client.deviceId, sessionToken: login.sessionToken, savedAt: new Date().toISOString() });
  const self = extractMyAccountId(login.payload); assert(self != null, 'own-id');
  bot.botInfo = await bot.telegram.getMe();
  const methods: string[] = [];
  const originalApi = bot.telegram.callApi.bind(bot.telegram);
  let lastMutationAt = 0;
  bot.telegram.callApi = (async (method: string, payload: any, extra?: any) => {
    if (method === 'getUpdates') throw new Error('Polling is forbidden during acceptance');
    if (/^send|^editMessage|^deleteMessage/.test(method)) {
      assert(String(payload.chat_id) === target, 'destination-outside-acceptance');
      await new Promise(resolve => setTimeout(resolve, Math.max(0, 3100 - (Date.now() - lastMutationAt))));
      lastMutationAt = Date.now();
      methods.push(method);
    }
    return (originalApi as Function)(method, payload, extra);
  }) as typeof bot.telegram.callApi;
  const temporary = await mkdtemp(path.join(root, '.data/media-acceptance-'));
  await copyFile(path.join(root, 'package.json'), path.join(temporary, 'package.json'));
  process.chdir(temporary);
  const map = new ChatMapStore(); await map.upsert(saved);
  db = new BridgeDatabase(path.join(temporary, 'acceptance.sqlite'));
  // The actual TCP client's dispatch stays intact; only explicitly read back test messages enter
  // bridge handlers. Action journalling wraps the facade, never the underlying client's methods.
  const events = new EventEmitter(), overrides = new Map<PropertyKey, unknown>();
  const facade = new Proxy(client, {
    get(target, key) {
      if (overrides.has(key)) return overrides.get(key);
      if (key === 'on') return events.on.bind(events);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, key, value) { overrides.set(key, value); return true; },
  });
  const unavailable = async (): Promise<never> => { throw new Error('Acceptance action forbidden'); };
  wired = wireBridge({ max: facade, bot, database: db, ownerUserId: owner, targetGroupId: target, chatMapStore: map,
    getChats: () => [{ id: 0, type: 'DIALOG' }], getMyAccountId: () => Number(self), getContactProfiles: () => new Map(), getActivePhone: () => '',
    getMaxState: () => ({ connected: true, lastLoginAt: Date.now() }), triggerFullResync: unavailable, killEverything: unavailable, suspendChatSync: unavailable,
    auth: { getLastKnownPhone: () => '', requestSms: unavailable, verifyCode: unavailable, checkPassword: unavailable },
    pause: { start: () => {}, stop: () => true, until: () => null },
  });
  wired.deliveryQueue!.stop(); await wired.deliveryQueue!.drain(); wired.chatSync.markCaughtUp('0');
  const links = new MessageLinkStore(100, db);
  let updateId = Date.now();
  async function update(message: any, edit = false): Promise<void> {
    const owned = { ...message, from: { id: owner, is_bot: false, first_name: 'Owner' }, message_thread_id: saved!.telegramTopicId };
    await bot.handleUpdate({ update_id: updateId++, [edit ? 'edited_message' : 'message']: owned } as Update);
  }
  async function drain(): Promise<void> {
    wired!.deliveryQueue!.start(); await wired!.deliveryQueue!.drain(); wired!.deliveryQueue!.stop();
    assert(!db!.pending().length, 'delivery-job-not-complete');
  }
  const photo = (color: string) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=128x128`, '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { maxBuffer: 1024 * 1024 });
  const red = photo('red'), blue = photo('blue');
  const opts = { message_thread_id: saved.telegramTopicId, disable_notification: true };
  stage = 'outgoing-photo';
  const fixture = await bot.telegram.sendPhoto(target, { source: red, filename: 'test-red.jpg' }, { ...opts, caption: 'Telemax: фото до замены' });
  await update(fixture); await drain();
  const link = links.getByTelegram(fixture.message_id); assert(link, 'photo-link');
  const first = (await client.getMessages(0, [link!.maxMessageId]))[0]; assert((first?.attaches?.[0] as any)?._type === 'PHOTO', 'photo-max-readback'); checks.outgoingPhoto = true;
  stage = 'outgoing-replace';
  const edited = await bot.telegram.editMessageMedia(target, fixture.message_id, undefined, { type: 'photo', media: { source: blue, filename: 'test-blue.jpg' }, caption: 'Telemax: фото заменено' });
  assert(typeof edited === 'object', 'telegram-edit-result'); await update(edited, true); await drain();
  const replacement = (await client.getMessages(0, [link!.maxMessageId]))[0];
  assert(replacement?.text === 'Telemax: фото заменено' && String((replacement.attaches?.[0] as any)?.photoId) !== String((first!.attaches?.[0] as any)?.photoId), 'photo-replacement-readback'); checks.outgoingReplacement = true;
  stage = 'outgoing-album';
  const album = await bot.telegram.sendMediaGroup(target, [
    { type: 'photo', media: { source: red, filename: 'album-red.jpg' }, caption: 'Telemax: альбом A' },
    { type: 'photo', media: { source: blue, filename: 'album-blue.jpg' }, caption: 'Telemax: альбом B' },
  ], opts);
  for (const part of album) await update(part);
  await new Promise(resolve => setTimeout(resolve, 2200)); await drain();
  const a = links.getByTelegram(album[0]!.message_id), b = links.getByTelegram(album[1]!.message_id);
  assert(a && b && String(a.maxMessageId) === String(b.maxMessageId), 'album-aliases');
  const maxAlbum = (await client.getMessages(0, [a!.maxMessageId]))[0];
  assert(maxAlbum?.attaches?.length === 2 && maxAlbum.text?.includes('альбом A') && maxAlbum.text.includes('альбом B'), 'album-readback'); checks.outgoingAlbum = true;
  stage = 'album-caption-edit';
  const captionEdit = await bot.telegram.editMessageCaption(target, album[1]!.message_id, undefined, 'Telemax: альбом B изменён');
  assert(typeof captionEdit === 'object', 'caption-edit-result'); await update(captionEdit, true); await drain();
  const editedAlbum = (await client.getMessages(0, [a!.maxMessageId]))[0];
  report.albumCaptionReadback = { attaches: editedAlbum?.attaches?.length, text: editedAlbum?.text };
  assert(editedAlbum?.attaches?.length === 2 && editedAlbum.text?.includes('альбом A') && editedAlbum.text.includes('B изменён'), 'album-caption-readback'); checks.albumSiblingPreserved = true;
  stage = 'incoming-album';
  const incoming = await client.sendMessage(0, 'Telemax: альбом из MAX', maxAlbum!.attaches as any[]);
  async function emitReadback(id: unknown, edited = false): Promise<void> {
    const message = (await client.getMessages(0, [id]))[0]; assert(message, 'incoming-readback');
    events.emit('message', { dir: DIR.TX, opcode: OPCODES.PUSH_MESSAGE, payload: { chatId: 0, message: { ...message, ...(edited ? { status: 'EDITED' } : {}) } } });
    await wired!.chatSync.runInChat('0', async () => {});
  }
  const beforeAlbumCalls = methods.filter(m => m === 'sendMediaGroup').length;
  await emitReadback(incoming.messageId);
  const incomingLink = links.getByMax(0, incoming.messageId);
  assert(incomingLink?.mediaTelegramMessageIds?.length === 2 && methods.filter(m => m === 'sendMediaGroup').length === beforeAlbumCalls + 1, 'incoming-native-telegram-album'); checks.incomingAlbum = true;
  stage = 'incoming-replace';
  const beforeIds = [...incomingLink!.mediaTelegramMessageIds!];
  const beforeEdits = methods.filter(m => m === 'editMessageMedia').length;
  await client.editMessage(0, incoming.messageId, 'Telemax: альбом MAX изменён', [], [replacement!.attaches![0]!, maxAlbum!.attaches![1]!] as any[]);
  await emitReadback(incoming.messageId, true); await drain();
  const afterLink = links.getByMax(0, incoming.messageId);
  assert(JSON.stringify(afterLink?.mediaTelegramMessageIds) === JSON.stringify(beforeIds) && methods.filter(m => m === 'editMessageMedia').length > beforeEdits, 'incoming-edit-in-place'); checks.incomingReplacement = true;
  stage = 'anonymous-poll';
  const pollMessage = await client.sendMessage(0, null, [{ _type: 'POLL', title: 'Telemax: проверка анонимного голосования', settings: 5,
    answers: [{ text: 'Проверка A', answerId: null }, { text: 'Проверка B', answerId: null }] }]);
  await emitReadback(pollMessage.messageId);
  const widget = db.values<PollWidget>('pollWidgets').find(w => String(w.maxMessageId) === String(pollMessage.messageId));
  assert(widget?.messageId, 'poll-widget-created');
  async function click(action: string): Promise<void> {
    await bot.handleUpdate({ update_id: updateId++, callback_query: { id: `acceptance-${updateId}`, chat_instance: 'acceptance',
      from: { id: owner, is_bot: false, first_name: 'Owner' }, data: `tlmx_poll:${widget!.key}:${action}`,
      message: { message_id: widget!.messageId!, date: Math.floor(Date.now() / 1000), chat: { id: Number(target), type: 'supergroup', title: 'Owner test' }, from: bot.botInfo, text: 'Acceptance poll' } } } as Update);
    await drain();
  }
  await click('i0'); await click('s');
  const votes = (await client.getMessages(0, [pollMessage.messageId]))[0]?.attaches?.find(a => (a as any)._type === 'POLL') as any;
  assert(Number(votes?.state?.total) === 1, 'anonymous-vote-max-readback'); checks.anonymousPollVote = true;
  await click('c'); await click('s');
  const removed = (await client.getMessages(0, [pollMessage.messageId]))[0]?.attaches?.find(a => (a as any)._type === 'POLL') as any;
  assert(Number(removed?.state?.total ?? 0) === 0, 'anonymous-vote-removal-readback'); checks.anonymousPollVoteRemoval = true;
  stage = 'reactions';
  async function react(before: boolean, after: boolean): Promise<void> {
    await bot.handleUpdate({ update_id: updateId++, message_reaction: { chat: { id: Number(target), type: 'supergroup', title: 'Owner test' },
      message_id: fixture.message_id, user: { id: owner, is_bot: false, first_name: 'Owner' }, date: Math.floor(Date.now() / 1000),
      old_reaction: before ? [{ type: 'emoji', emoji: '❤' }] : [], new_reaction: after ? [{ type: 'emoji', emoji: '❤' }] : [] } } as Update);
    await drain();
  }
  await react(false, true);
  assert((await client.getReactions(0, link!.maxMessageId)).some(c => c.count === 1), 'reaction-readback');
  await react(true, false);
  assert(!(await client.getReactions(0, link!.maxMessageId)).some(c => c.count > 0), 'reaction-removal-readback'); checks.reactionLifecycle = true;
  report.ok = true;
} catch (error) {
  report.ok = false; report.failedStage = stage;
  report.error = { name: (error as Error).name, serverCode: (error as { serverCode?: string }).serverCode ?? null,
    assertion: /^[a-z-]+$/.test((error as Error).message) ? (error as Error).message : undefined };
  process.exitCode = 1;
} finally {
  wired?.deliveryQueue?.stop(); await wired?.deliveryQueue?.drain(); db?.close(); client.disconnect(); clearTimeout(deadline);
  process.chdir(root); report.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report));
}
