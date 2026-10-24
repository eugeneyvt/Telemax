import { AsyncLocalStorage } from 'node:async_hooks';
import type { Telegraf } from 'telegraf';
import type { BridgeDatabase } from '../store/bridgeDatabase.js';
import { isConnectFailure } from './transient.js';

interface Part { ids: number[]; textIds: number[] }
interface Scope { key: string; ids: number[]; textIds: number[]; save: (part: Part) => void }
export class IncomingDeliveryUncertainError extends Error {
  constructor(readonly key: string, diagnostic?: string) { super(`Telegram мог принять часть сообщения ${key}; нужна сверка в /queue.${diagnostic ? ` Причина: ${diagnostic}.` : ''}`); this.name = 'IncomingDeliveryUncertainError'; }
}

/** Transport categories only: error messages may contain a bot token or a private upload URL. */
function transportDiagnostic(error: unknown): string {
  const e = error as { name?: unknown; code?: unknown; type?: unknown; cause?: { code?: unknown } } | null;
  return [e?.name, e?.code, e?.type, e?.cause?.code]
    .filter((v): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v))
    .join('/') || 'unknown';
}

/** Checkpoint every confirmed Telegram part before another part can be sent. */
export class IncomingCheckpoint {
  private readonly context = new AsyncLocalStorage<Scope>();
  constructor(private readonly bot: Telegraf, private readonly db: BridgeDatabase) {
    const original = bot.telegram.callApi.bind(bot.telegram);
    bot.telegram.callApi = (async (method: string, payload: unknown, extra?: unknown) => {
      const scope = this.context.getStore();
      if (!scope || !/^(send|copyMessage|forwardMessage)/.test(method) || method === 'sendChatAction') {
        return (original as Function)(method, payload, extra);
      }
      if (this.db.get('incomingPending', scope.key)) throw new IncomingDeliveryUncertainError(scope.key);
      // A durable intent distinguishes a process/network failure from a known API refusal.
      this.db.set('incomingPending', scope.key, { key: scope.key, method, created: Date.now() });
      let result: any;
      try { result = await (original as Function)(method, payload, extra); }
      catch (error) {
        const code = (error as { response?: { error_code?: number } }).response?.error_code;
        if ((code != null && code >= 400 && code < 500) || isConnectFailure(error)) this.db.delete('incomingPending', scope.key);
        else {
          const diagnostic = transportDiagnostic(error);
          this.db.set('incomingPending', scope.key, { key: scope.key, method, created: Date.now(), diagnostic });
          throw new IncomingDeliveryUncertainError(scope.key, diagnostic);
        }
        throw error;
      }
      const parts = Array.isArray(result) ? result : [result];
      if (!parts.length || parts.some(x => !Number.isSafeInteger(x?.message_id) || x.message_id <= 0)) {
        throw new IncomingDeliveryUncertainError(scope.key, 'invalid-message-id');
      }
      const ids = parts.map(x => x.message_id as number);
      scope.ids.push(...ids);
      if (method === 'sendMessage') scope.textIds.push(...ids);
      scope.save({ ids: [...scope.ids], textIds: [...scope.textIds] });
      this.db.delete('incomingPending', scope.key);
      return result;
    }) as typeof bot.telegram.callApi;
  }
  async run<T>(key: string, chat: string, previous: Part | undefined, save: Scope['save'], run: () => Promise<T>): Promise<T> {
    const pending = this.db.get<{ diagnostic?: string }>('incomingPending', key);
    if (pending) {
      // Old builds also parked failures that provably occurred before a connection
      // existed. Only a recorded, recognized connect errno authorizes a safe retry.
      const knownUnsent = typeof pending.diagnostic === 'string'
        && pending.diagnostic.split('/').some(code => isConnectFailure({ code }));
      if (!knownUnsent) throw new IncomingDeliveryUncertainError(key);
      this.db.delete('incomingPending', key);
    }
    // A crash can leave acknowledged parts without a completed source link. Remove those
    // known bot copies before replaying the original, including media and native polls.
    for (const id of previous?.ids ?? []) {
      try { await this.bot.telegram.deleteMessage(chat, id); }
      catch (error) {
        const message = (error as { response?: { description?: string } }).response?.description ?? String(error);
        if (!/message to delete not found/i.test(message)) throw error;
      }
    }
    return this.context.run({ key, ids: [], textIds: [], save }, run);
  }
}
