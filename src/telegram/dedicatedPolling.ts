import type { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import type { BridgeDatabase } from '../store/bridgeDatabase.js';

/** Each distinct bot token has one poller and its own durable offset. Never drops pending updates. */
export class DedicatedPolling {
  private controller = new AbortController();
  private work?: Promise<void>;
  private stopping = false;
  lastPollAt = Date.now();
  failed = false;
  constructor(private readonly bot: Telegraf, private readonly db: BridgeDatabase,
    private readonly commit: (u: Update) => Promise<void>, private readonly handle: (u: Update) => Promise<void>) {}
  start(): void { this.work ??= this.run(); }
  async batch(updates: Update[]): Promise<void> {
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('Invalid Telegram update id');
      await this.commit(update);
    }
    const next = updates.reduce((n, u) => Math.max(n, u.update_id + 1), this.db.get<number>('dedicatedPolling', 'offset') ?? 0);
    this.db.set('dedicatedPolling', 'offset', next);
    this.lastPollAt = Date.now(); this.failed = false;
    for (const update of updates) await this.handle(update);
  }
  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const request = new AbortController(), abort = () => request.abort();
        const deadline = setTimeout(abort, 90_000); this.controller.signal.addEventListener('abort', abort, { once: true });
        let result: Update[];
        try {
          result = await this.bot.telegram.callApi('getUpdates', { offset: this.db.get<number>('dedicatedPolling', 'offset') ?? 0, timeout: 50,
            allowed_updates: ['message', 'edited_message', 'message_reaction', 'poll_answer', 'callback_query', 'my_chat_member'] }, { signal: request.signal as any }); // Telegraf's older AbortSignal type predates native Node AbortSignal.
        } finally { clearTimeout(deadline); this.controller.signal.removeEventListener('abort', abort); }
        await this.batch(result);
      } catch (error) {
        if (this.stopping) break;
        this.failed = true;
        const code = (error as { response?: { error_code?: number } }).response?.error_code;
        // Never log raw errors: Telegram client errors can contain a token-bearing URL.
        if (code === 401 || code === 409) return;
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, 5_000);
          const signal = this.controller.signal;
          function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
          signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done();
        });
      }
    }
  }
  async stop(): Promise<void> { this.stopping = true; this.controller.abort(); await this.work; }
}
