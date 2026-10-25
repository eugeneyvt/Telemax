/** Explicit owner-only bootstrap for the Saved Messages pilot. Production must be stopped;
 * no MAX connection, polling, message send to MAX, or bot creation is performed here.
 * It sends the real Telegram owner a creation button and persists the pending request.
 */
import path from 'node:path';
import { Telegraf } from 'telegraf';
import { MaxClient } from '../src/max/client.js';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { ChatMapStore } from '../src/store/chatMapStore.js';
import { DedicatedBots } from '../src/bridge/dedicatedBots.js';
if (process.env.TELEMAX_ACCEPTANCE !== 'owner-bot-create') throw new Error('Explicit owner-only creation prompt required');
process.env.LOG_LEVEL = 'error'; process.umask(0o077);
const owner = Number(process.env.TELEGRAM_OWNER_ID), target = process.env.TARGET_TELEGRAM_GROUP!;
if (!Number.isSafeInteger(owner) || owner <= 0 || !target?.startsWith('-100')) throw new Error('Existing private control group required');
const directory = path.join(process.cwd(), '.data', `telegram-${target}`);
const database = new BridgeDatabase(path.join(directory, 'bridge.sqlite'));
const chatMapStore = new ChatMapStore(path.join(directory, 'chat-map.json'));
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const max = new MaxClient({ reconnect: false });
const forbidden = async (): Promise<never> => { throw new Error('Bootstrap operation forbidden'); };
try {
  bot.botInfo = await bot.telegram.getMe();
  const manager = new DedicatedBots({ bot, max, database, chatMapStore, ownerUserId: owner, targetGroupId: target,
    getChats: () => [], getMyAccountId: () => null, getContactProfiles: () => new Map(), getActivePhone: () => '', getMaxState: () => ({ connected: false, lastLoginAt: null }),
    triggerFullResync: forbidden, killEverything: forbidden, suspendChatSync: forbidden,
    auth: { getLastKnownPhone: () => '', requestSms: forbidden, verifyCode: forbidden, checkPassword: forbidden }, pause: { start: () => {}, stop: () => true, until: () => null },
  }, { createBot: token => new Telegraf(token), previousChat: forbidden, groupChat: () => undefined, polling: false });
  await manager.request('0');
  console.log(JSON.stringify({ savedCreationRequestPersisted: Boolean(database.values<{ maxChatId: string }>('dedicatedRequests').find(r => r.maxChatId === '0')), creationPromptSent: true }));
} finally { database.close(); }
