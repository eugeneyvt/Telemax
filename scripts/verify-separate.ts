/** Owner-authorized pilot only: real Telegram API and MAX Saved Messages, synthetic owner
 * updates. Stop production and back up consistent state first. No getUpdates or other MAX chat.
 * The new binding persists in the production registry for the subsequent release cutover.
 */
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Telegraf, Telegram } from 'telegraf';
import type { Update } from 'telegraf/types';
import { MaxClient } from '../src/max/client.js';
import { SessionStore } from '../src/store/sessionStore.js';
import { ChatMapStore } from '../src/store/chatMapStore.js';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { SeparateGroups } from '../src/bridge/separateGroups.js';
import { MessageLinkStore, type BridgeOptions } from '../src/bridge/sync.js';
import { extractMyAccountId } from '../src/max/names.js';
import { DIR, OPCODES } from '../src/max/opcodes.js';

if (process.env.TELEMAX_ACCEPTANCE !== 'owner-plain-group') throw new Error('Explicit owner-only pilot required');
process.umask(0o077); process.env.LOG_LEVEL = 'error'; process.env.FILES = 'off'; process.env.TELEMETRY = 'off';
const root = process.cwd(), owner = Number(process.env.TELEGRAM_OWNER_ID), target = process.env.TARGET_TELEGRAM_GROUP!;
const candidate = JSON.parse(await readFile(path.join(root, '.data/group-candidate.json'), 'utf8'));
if (candidate.isForum || candidate.memberCount !== 2 || !candidate.ownerIsAdmin || candidate.chatId === target) throw new Error('Owner-created private plain test group required');
const destination = String(candidate.chatId);
const client = new MaxClient({ reconnect: false, host: process.env.MAX_HOST || undefined, sni: process.env.MAX_SNI || undefined });
client.on('error', () => {});
const store = new SessionStore(), session = await store.load(); if (!session) throw new Error('Existing session required');
const db = new BridgeDatabase(path.join(root, `.data/telegram-${target}/bridge.sqlite`));
const map = new ChatMapStore(path.join(root, `.data/telegram-${target}/chat-map.json`));
let manager: SeparateGroups | undefined, stage = 'connect';
const report: any = { syntheticOwnerUpdates: true, checks: {} }, checks = report.checks;
const assert = (ok: unknown, label: string) => { if (!ok) throw new Error(label); };
const originalApi = Telegram.prototype.callApi;
let lastMutation = 0; const calls: Array<{ method: string; text?: string; thread?: number }> = [];
Telegram.prototype.callApi = (async function (this: Telegram, method: any, payload: any, extra: any) {
  if (method === 'getUpdates') throw new Error('pilot-polling-forbidden');
  if (payload?.chat_id != null) assert(String(payload.chat_id) === destination, 'pilot-destination-mismatch');
  if (/^(send|edit|delete|setChat|pin|unpin)/.test(method)) {
    await new Promise(r => setTimeout(r, Math.max(0, 3100 - (Date.now() - lastMutation)))); lastMutation = Date.now();
    calls.push({ method, text: payload.text, thread: payload.message_thread_id });
  }
  return (originalApi as Function).call(this, method, payload, extra);
}) as typeof Telegram.prototype.callApi;
const makeBot = () => new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
let bot = makeBot();
const forbidden = async (): Promise<never> => { throw new Error('pilot-operation-forbidden'); };
const watchdog = setTimeout(() => { client.disconnect(); process.exitCode = 1; }, 240_000);
try {
  assert(db.pending().length === 0, 'primary-queue-must-be-empty');
  const ready = once(client, 'ready'); client.connect(); await ready;
  stage = 'resume'; const login = await client.login(session.sessionToken);
  await store.save({ ...session, deviceId: client.deviceId, sessionToken: login.sessionToken, savedAt: new Date().toISOString() });
  const own = extractMyAccountId(login.payload); assert(own != null, 'own-id-missing');
  const saved = (await client.chatsInfo([0]))[0]; assert(saved && String((saved as any).id) === '0', 'saved-unavailable');
  bot.botInfo = await bot.telegram.getMe();
  const options = (): BridgeOptions => ({ max: client, bot, database: db, ownerUserId: owner, targetGroupId: target, chatMapStore: map,
    getChats: () => [saved], getMyAccountId: () => own, getContactProfiles: () => new Map(), getActivePhone: () => '', getMaxState: () => ({ connected: true, lastLoginAt: Date.now() }),
    triggerFullResync: forbidden, killEverything: forbidden, suspendChatSync: forbidden,
    auth: { getLastKnownPhone: () => '', requestSms: forbidden, verifyCode: forbidden, checkPassword: forbidden }, pause: { start: () => {}, stop: () => true, until: () => null } });
  manager = new SeparateGroups(options(), makeBot); await manager.start();
  let updateId = Date.now();
  async function update(message: any, edited = false) {
    await bot.handleUpdate({ update_id: updateId++, [edited ? 'edited_message' : 'message']: { ...message, from: { id: owner, is_bot: false, first_name: 'Owner' } } } as Update);
  }
  stage = 'bind';
  if (!manager.byMax('0')) {
    const original = await map.getByMaxChatId('0'); assert(original && !original.banned, 'saved-map-missing');
    const code = randomBytes(16).toString('hex');
    db.set('separateRequests', code, { code, maxChatId: '0', title: 'Избранное', topicId: original!.telegramTopicId, created: Date.now() });
    const command = `/start separate_${code}`;
    await update({ message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: Number(destination), type: 'supergroup', title: 'Owner pilot' }, text: command, entities: [{ type: 'bot_command', offset: 0, length: 6 }] });
  }
  assert(manager.byMax('0')?.telegramChatId === destination && manager.byMax('0')?.state === 'active', 'binding-not-active');
  checks.privateBinding = true;
  const runtime = () => (manager as any).runtimes.get('0') as { db: BridgeDatabase; bridge: any };
  runtime().bridge.chatSync.markCaughtUp('0');
  const links = () => new MessageLinkStore(100, runtime().db);
  async function drain() { runtime().bridge.deliveryQueue.start(); await runtime().bridge.deliveryQueue.drain(); assert(!runtime().db.pending().length, 'child-queue-not-empty'); }
  stage = 'outgoing';
  const text = `Telemax: отдельная группа ${new Date().toISOString()}`;
  const fixture = await bot.telegram.sendMessage(destination, text, { entities: [{ type: 'bold', offset: 0, length: 7 }], disable_notification: true });
  await update(fixture); await drain();
  const link = links().getByTelegram(fixture.message_id); assert(link, 'text-link-missing');
  const result = (await client.getMessages(0, [link!.maxMessageId]))[0];
  assert(result?.text === text && (result as any).elements?.length > 0, 'formatted-text-readback'); checks.formattedOutgoing = true;
  stage = 'edit';
  const edit = await bot.telegram.editMessageText(destination, fixture.message_id, undefined, `${text} · изменено`);
  assert(typeof edit === 'object', 'telegram-edit-result'); await update(edit, true); await drain();
  assert((await client.getMessages(0, [link!.maxMessageId]))[0]?.text === `${text} · изменено`, 'edit-readback'); checks.edit = true;
  stage = 'reply';
  const reply = await bot.telegram.sendMessage(destination, 'Telemax: ответ из отдельной группы', { reply_parameters: { message_id: fixture.message_id }, disable_notification: true });
  await update({ ...reply, reply_to_message: fixture }); await drain();
  const replyLink = links().getByTelegram(reply.message_id); assert(replyLink, 'reply-link-missing');
  assert((await client.getMessages(0, [replyLink!.maxMessageId]))[0]?.link?.type === 'REPLY', 'reply-readback'); checks.reply = true;
  stage = 'incoming';
  const incomingText = `Telemax: входящее из MAX ${Date.now()}`;
  const incoming = await client.sendMessage(0, incomingText, []);
  const message = (await client.getMessages(0, [incoming.messageId]))[0]; assert(message, 'incoming-readback-missing');
  client.emit('message', { dir: DIR.TX, opcode: OPCODES.PUSH_MESSAGE, payload: { chatId: 0, message } });
  await runtime().bridge.chatSync.runInChat('0', async () => {});
  assert(links().getByMax(0, incoming.messageId), 'incoming-link-missing'); checks.incoming = true;
  stage = 'receipt';
  const receipt = await bot.telegram.sendMessage(destination, '/receipt', { reply_parameters: { message_id: fixture.message_id }, disable_notification: true });
  await update({ ...receipt, entities: [{ type: 'bot_command', offset: 0, length: 8 }], reply_to_message: fixture });
  assert(calls.some(c => c.method === 'sendMessage' && c.text?.includes('Сообщение есть в MAX')), 'receipt-response-missing'); checks.receipt = true;
  stage = 'restart';
  const file = runtime().db.file; await manager.stop(); manager.closeDatabases();
  bot = makeBot(); bot.botInfo = await bot.telegram.getMe(); manager = new SeparateGroups(options(), makeBot); await manager.start();
  assert(runtime().db.file === file && links().getByTelegram(fixture.message_id), 'restart-link-lost'); checks.restart = true;
  assert(calls.every(c => c.thread == null), 'forum-thread-leaked'); checks.noTopics = true;
  assert((await bot.telegram.getChat(destination) as any).title === 'Избранное · MAX', 'group-title'); checks.name = true;
  assert(manager.health().failed === 0 && manager.health().uncertain === 0, 'child-health');
  report.ok = true;
} catch (error) {
  report.ok = false; report.failedStage = stage;
  report.error = { name: (error as Error).name, serverCode: (error as any).serverCode ?? null,
    assertion: /^[a-z-]+$/.test((error as Error).message) ? (error as Error).message : undefined };
  process.exitCode = 1;
} finally {
  await manager?.stop(); manager?.closeDatabases(); db.close(); client.disconnect(); clearTimeout(watchdog);
  Telegram.prototype.callApi = originalApi;
  await writeFile(path.join(root, '.data/acceptance-separate.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
