import type { Context, Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import type { MaxClient, MaxMessageEvent } from '../max/client.js';
import { outsideDelivery } from './deliveryQueue.js';

export const standaloneTitle = (name: string): string => `${name.replace(/\s*[·|]\s*MAX$/i, '').trim().slice(0, 118)} · MAX`;

/** Keep the bridge's internal topic routing while presenting an ordinary group with no topics. */
export function standaloneUpdate(update: Update): Update {
  const u = structuredClone(update) as any;
  for (const key of ['message', 'edited_message']) if (u[key]) u[key].message_thread_id = 1;
  if (u.callback_query?.message) u.callback_query.message.message_thread_id = 1;
  return u;
}

export function installStandaloneTelegram(bot: Telegraf, destination: string, available: () => boolean): void {
  const original = bot.telegram.callApi.bind(bot.telegram);
  bot.telegram.callApi = (async (method: string, raw: any, extra?: unknown) => {
    if (method === 'getUpdates') throw new Error('Separate groups never poll Telegram independently.');
    const payload = { ...raw };
    if (payload.chat_id != null) {
      if (String(payload.chat_id) !== destination) throw new Error('Separate-group destination mismatch.');
      if (!available() && !['getChat', 'getChatMember', 'getChatMemberCount'].includes(method)) throw new Error('Private group membership must be verified.');
      delete payload.message_thread_id;
      if (payload.reply_parameters) {
        payload.reply_parameters = { ...payload.reply_parameters };
        delete payload.reply_parameters.message_thread_id;
      }
    }
    if (method === 'createForumTopic') throw new Error('A separate group cannot acquire another MAX chat.');
    if (method === 'deleteForumTopic') return true; // Never delete the real group through a topic operation.
    if (method === 'editForumTopic') {
      try {
        return await (original as Function)('setChatTitle', { chat_id: destination, title: standaloneTitle(payload.name ?? 'MAX') }, extra);
      } catch (error) {
        const response = (error as { response?: { error_code?: number; description?: string } }).response;
        // Topic liveness probes rename to the current title. Telegram uses a different
        // "not modified" error for ordinary groups; it still proves that the group exists.
        if (response?.error_code === 400 && /not modified|CHAT_NOT_MODIFIED/i.test(response.description ?? '')) return true;
        throw error;
      }
    }
    return (original as Function)(method, payload, extra);
  }) as typeof bot.telegram.callApi;
  // Telegraf normally constructs another API object for Context. Keep all calls behind the
  // same destination guard, topic translation and delivery checkpoint wrappers.
  bot.use(async (ctx, next) => {
    (ctx as unknown as { telegram: Context['telegram'] }).telegram = bot.telegram;
    return next();
  });
}

/** A scoped facade shares the existing MAX socket, but never its action-journal mutations. */
export function standaloneMax(real: MaxClient, chatId: string, available: () => boolean): { client: MaxClient; close(): void } {
  const overrides = new Map<PropertyKey, unknown>();
  const subscriptions: Array<{ event: string; listener: (...args: any[]) => void }> = [];
  const scoped = new Set(['sendMessage', 'forwardMessage', 'editMessage', 'deleteMessages', 'getMessages', 'getChatHistory', 'markRead', 'pinMessage', 'addReaction', 'removeReaction', 'getReactions', 'sendVote']);
  const client = new Proxy(real, {
    get(target, key) {
      if (overrides.has(key)) return overrides.get(key);
      if (key === 'isLoggedIn') return target.isLoggedIn && available();
      if (key === 'on') return (event: string, callback: (...args: any[]) => void) => {
        const listener = (...args: any[]) => {
          if (!available()) return;
          if (event === 'message') {
            const payload = (args[0] as MaxMessageEvent)?.payload as any;
            if (String(payload?.chatId ?? payload?.chat?.id) !== chatId) return;
          }
          callback(...args);
        };
        subscriptions.push({ event, listener });
        if (target.getMaxListeners() > 0) target.setMaxListeners(target.getMaxListeners() + 1);
        target.on(event, listener); return client;
      };
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (scoped.has(String(key)) && String(args[0]) !== chatId) throw new Error('Separate-group MAX chat mismatch.');
        return outsideDelivery(() => value.apply(target, args));
      };
    },
    set(_target, key, value) { overrides.set(key, value); return true; },
  });
  let closed = false;
  return { client, close: () => {
    if (closed) return; closed = true;
    for (const { event, listener } of subscriptions) real.off(event, listener);
    if (real.getMaxListeners() > 0) real.setMaxListeners(Math.max(1, real.getMaxListeners() - subscriptions.length));
  } };
}
