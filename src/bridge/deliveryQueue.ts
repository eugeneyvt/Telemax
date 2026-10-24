import { AsyncLocalStorage } from 'node:async_hooks';
import type { MaxClient, MaxHistoryMessage } from '../max/client.js';
import { MaxServerError, MaxRequestOutcomeUnknownError } from '../max/client.js';
import { BridgeDatabase, type DeliveryJob, type EffectRecord } from '../store/bridgeDatabase.js';
import { isTransientMaxError, isTransientTelegramError } from './transient.js';
import { createLogger } from '../logger.js';
import type { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';

const logger = createLogger('delivery');
interface JobContext { job: DeliveryJob; effectIndex: number }
const context = new AsyncLocalStorage<JobContext>();
export const currentDelivery = (): DeliveryJob | undefined => context.getStore()?.job;
export const outsideDelivery = <T>(run: () => T): T => context.exit(run);
export class UncertainDeliveryError extends Error {
  constructor(service = 'MAX') { super(`Исход отправки ещё не подтверждён; сохранено для сверки с ${service}, без слепого повтора.`); }
}

/** Incoming edit jobs can grow a message: journal the new Telegram parts as carefully as MAX sends. */
export function journalTelegramActions(bot: Telegraf, store: BridgeDatabase, applies: (job: DeliveryJob) => boolean): void {
  const original = bot.telegram.callApi.bind(bot.telegram);
  bot.telegram.callApi = (async (method: string, payload: unknown, extra?: unknown) => {
    const active = context.getStore();
    if (!active || !applies(active.job) || !['sendMessage', 'sendPhoto', 'sendVideo', 'sendVideoNote', 'sendVoice', 'sendAudio', 'sendDocument', 'sendSticker', 'sendMediaGroup', 'editMessageMedia', 'editMessageCaption', 'editMessageText', 'editMessageReplyMarkup', 'deleteMessage'].includes(method)) {
      return (original as Function)(method, payload, extra);
    }
    const effect = store.prepareEffect(active.job.id, active.effectIndex++, `telegram.${method}`, [payload], false);
    if (effect.status === 'done') return effect.result;
    const createsMessage = method.startsWith('send');
    if (createsMessage && effect.status === 'uncertain') throw new UncertainDeliveryError('Telegram');
    store.markEffect(effect.key, 'running');
    let received = false;
    try {
      const result = await (original as Function)(method, effect.args[0], extra);
      received = true;
      const parts = Array.isArray(result) ? result : [result];
      if (createsMessage && (!parts.length || parts.some(part => !Number.isSafeInteger(part?.message_id) || part.message_id <= 0))) throw new UncertainDeliveryError('Telegram');
      store.markEffect(effect.key, 'done', result);
      return result;
    } catch (error) {
      const response = (error as { response?: { error_code?: number; description?: string } }).response;
      const description = response?.description ?? (error as Error).message;
      if (response?.error_code === 400 && ((method === 'deleteMessage' && /message to delete not found/i.test(description)) || (method.startsWith('editMessage') && /message is not modified/i.test(description)))) {
        store.markEffect(effect.key, 'done', true);
        return true;
      }
      const uncertain = received || (createsMessage && !(response?.error_code && response.error_code >= 400 && response.error_code < 500));
      store.markEffect(effect.key, uncertain ? 'uncertain' : 'prepared');
      if (uncertain && createsMessage) throw new UncertainDeliveryError('Telegram');
      throw error;
    }
  }) as typeof bot.telegram.callApi;
}

/** Commit before Telegraf advances its getUpdates offset, including its shutdown offset sync. */
export function installPollingInbox(bot: Telegraf, accept: (update: Update) => Promise<void>, beforeBatch?: () => void): void {
  const call = bot.telegram.callApi.bind(bot.telegram);
  bot.telegram.callApi = (async (method: string, payload: unknown, extra?: unknown) => {
    const result = await (call as (m: string, p: unknown, e?: unknown) => Promise<unknown>)(method, payload, extra);
    if (method === 'getUpdates' && Array.isArray(result)) {
      try { beforeBatch?.(); for (const update of result) await accept(update as Update); }
      catch (cause) {
        // Polling retries a FetchError without increasing offset. Never return an uncommitted batch.
        const error = new Error('Не удалось сохранить Telegram updates на диск; подтверждение отложено.', { cause });
        error.name = 'FetchError';
        throw error;
      }
    }
    return result;
  }) as typeof bot.telegram.callApi;
}

/** Receives a durable update before returning control to Telegram polling. */
export class DeliveryQueue {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(
    readonly store: BridgeDatabase,
    private readonly run: (payload: unknown) => Promise<void>,
    private readonly ready: () => boolean,
    private readonly notice: (job: DeliveryJob, state: 'retry' | 'uncertain' | 'failed') => Promise<void>,
  ) {}
  start(): void { this.stopped = false; this.wake(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  async drain(): Promise<void> { await this.running; }
  wake(): void {
    if (this.stopped || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = this.work().catch(e => logger.error('Queue worker failed; all tasks remain on disk', e)).finally(() => {
      this.running = null;
      if (!this.stopped) { this.timer = setTimeout(() => this.wake(), 2000); this.timer.unref(); }
    });
  }
  private async work(): Promise<void> {
    // Also recover an interrupted worker after a temporary local disk/SQLite failure.
    this.store.recoverInterrupted();
    while (!this.stopped && this.ready()) {
      const job = this.store.next();
      if (!job) return;
      this.store.markJob(job.id, 'running');
      try {
        await context.run({ job, effectIndex: 0 }, () => this.run(job.payload));
        this.store.markJob(job.id, 'done');
      } catch (error) {
        const uncertain = error instanceof UncertainDeliveryError || error instanceof MaxRequestOutcomeUnknownError;
        const retryable = uncertain || isTransientMaxError(error) || isTransientTelegramError(error);
        const state = uncertain ? 'uncertain' : retryable ? 'retry' : 'failed';
        const delay = uncertain ? 30_000 : Math.min(15 * 60_000, 1000 * 2 ** Math.min(job.attempts, 10));
        const reason = error instanceof MaxServerError ? error.message : uncertain ? 'delivery outcome unknown' : retryable ? 'temporary connection failure' : 'processing failed; see local logs';
        this.store.markJob(job.id, state, reason, Date.now() + delay);
        logger.error(`Job ${job.id} ${state}`, error);
        if (job.status !== state || job.error !== reason) await this.notice(job, state).catch(e => logger.warn('Could not show queue status', e));
      }
    }
  }
}

type MutableMax = Record<string, (...args: any[]) => Promise<any>>;

/** Journal actual effects, not just updates: a retried handler must not repeat an earlier part. */
export function journalMaxActions(max: MaxClient, store: BridgeDatabase, onPrepared?: (cid: number, options?: { sendAt?: number }) => void): void {
  const obj = max as unknown as MutableMax;
  for (const method of ['sendMessage', 'sendToNewDialog', 'forwardMessage', 'editMessage', 'deleteMessages', 'addReaction', 'removeReaction', 'sendVote', 'markRead', 'pinMessage', 'saveFolder', 'deleteFolder', 'changeProfile']) {
    const original = obj[method]?.bind(max);
    if (!original) continue;
    obj[method] = async (...args: unknown[]) => {
      const active = context.getStore();
      const isSend = method === 'sendMessage' || method === 'sendToNewDialog' || method === 'forwardMessage';
      if (!active) {
        if (isSend) {
          const cid = store.nextCid() * (method === 'forwardMessage' ? -1 : 1);
          args[4] = { ...(args[4] as object | undefined), cid };
          onPrepared?.(cid, args[4] as { sendAt?: number });
        }
        return original(...args);
      }
      const effect = store.prepareEffect(active.job.id, active.effectIndex++, method, args, isSend);
      if (effect.status === 'done') return effect.result;
      if (effect.status === 'uncertain' && isSend) {
        const recovered = await reconcileSend(max, effect);
        if (!recovered) throw new UncertainDeliveryError();
        store.markEffect(effect.key, 'done', recovered);
        return recovered;
      }
      const savedArgs = [...effect.args];
      // Earlier local builds encoded binary attachment fields as numeric-key objects.
      // Restore only MAX's explicitly binary fields, without reinterpreting user JSON.
      if (isSend && Array.isArray(savedArgs[2])) for (const attachment of savedArgs[2] as Record<string, unknown>[]) {
        for (const field of ['thumbhash', 'wave', 'previewData']) {
          const value = attachment?.[field];
          if (!value || typeof value !== 'object' || value instanceof Uint8Array) continue;
          const entries = Object.entries(value);
          if (entries.length && entries.every(([key, byte], index) => key === String(index) && Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255)) {
            attachment[field] = Buffer.from(entries.map(([, byte]) => Number(byte)));
          }
        }
      }
      if (isSend) { savedArgs[4] = { ...(savedArgs[4] as object | undefined), cid: effect.cid }; onPrepared?.(effect.cid!, savedArgs[4] as { sendAt?: number }); }
      // FULL synchronous commit before the network write.
      store.markEffect(effect.key, 'running');
      let receivedResult = false;
      try {
        const result = await original(...savedArgs);
        receivedResult = true;
        store.markEffect(effect.key, 'done', result);
        return result;
      } catch (error) {
        const confirmed = store.effect(effect.key);
        if (confirmed?.status === 'done') return confirmed.result; // a PUSH confirmed it before the ACK was lost
        const unknown = error instanceof MaxRequestOutcomeUnknownError || receivedResult;
        store.markEffect(effect.key, unknown ? 'uncertain' : 'prepared');
        if (receivedResult) throw new UncertainDeliveryError();
        throw error;
      }
    };
  }
}

async function reconcileSend(max: MaxClient, effect: EffectRecord): Promise<unknown | null> {
  if (effect.cid == null) return null;
  let chatId = effect.args[0];
  if (effect.method === 'sendToNewDialog') {
    const user = String(chatId);
    const chats = await max.getAllChats();
    const candidate = chats.find(c => {
      const chat = c as { type?: string; participants?: Record<string, unknown> };
      return chat.type === 'DIALOG' && chat.participants && Object.hasOwn(chat.participants, user);
    }) as { id?: unknown } | undefined;
    if (candidate?.id == null) return null;
    chatId = candidate.id;
  }
  // Scheduled messages are not in regular history before their firing time.
  const scheduledAt = (effect.args[4] as { sendAt?: number } | undefined)?.sendAt;
  if (scheduledAt) {
    const delayed = await max.getChatHistory(chatId, Math.max(Date.now(), scheduledAt) + 86_400_000, 100, 'DELAYED');
    const match = delayed.find(m => m.cid != null && String(m.cid) === String(effect.cid) && m.id != null);
    if (match) return { cid: effect.cid, messageId: match.id, attaches: match.attaches ?? [], time: match.time };
  }
  // A positive cid match is a proof. Failure to find it is NOT proof that a send never landed.
  let from = Date.now() + 15 * 60_000;
  const seen = new Set<string>();
  for (let page = 0; page < 200; page++) {
    const messages: MaxHistoryMessage[] = await max.getChatHistory(chatId, from, 100);
    if (!messages.length) return null;
    for (const m of messages) {
      if (m.cid != null && String(m.cid) === String(effect.cid) && m.id != null) {
        return { cid: effect.cid, messageId: m.id, attaches: m.attaches ?? [], time: m.time, ...(effect.method === 'sendToNewDialog' ? { chatId } : {}) };
      }
    }
    const oldest = Math.min(...messages.map(m => Number(m.time)));
    if (!Number.isFinite(oldest) || oldest < effect.createdAt - 24 * 60 * 60_000) return null;
    const key = messages.map(m => String(m.id)).join(',');
    if (seen.has(key)) return null;
    seen.add(key);
    from = oldest + 1;
  }
  return null;
}
