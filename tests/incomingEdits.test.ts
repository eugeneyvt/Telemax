import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Telegraf } from 'telegraf';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { MessageLinkStore } from '../src/bridge/sync.js';
import { IncomingEdits, isIncomingEdit } from '../src/bridge/incomingEdits.js';
import { DeliveryQueue, journalTelegramActions } from '../src/bridge/deliveryQueue.js';

const resources: Array<{ db: BridgeDatabase; queue: DeliveryQueue }> = [];
const directories: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('LOG_LEVEL', 'error'); });
afterEach(async () => {
  for (const r of resources.splice(0)) { r.queue.stop(); await r.queue.drain(); r.db.close(); }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});
function setup(file = ':memory:') {
  const db = new BridgeDatabase(file), links = new MessageLinkStore(1, db), bot = new Telegraf('local_fake');
  let nextId = 100;
  const api = vi.spyOn(bot.telegram, 'callApi').mockImplementation((async (method: string) => method === 'sendMessage' ? { message_id: ++nextId } : true) as typeof bot.telegram.callApi);
  const edits = new IncomingEdits(db, bot, '42', links, async () => ({ telegramTopicId: 7 }));
  journalTelegramActions(bot, db, job => isIncomingEdit(job.payload));
  const notice = vi.fn(async () => {});
  const queue = new DeliveryQueue(db, payload => {
    if (!isIncomingEdit(payload)) throw new Error('unexpected payload');
    return edits.run(payload);
  }, () => true, notice);
  resources.push({ db, queue });
  const enqueue = (text: string) => edits.enqueue({ maxChatId: '55', maxMessageId: 9n, topicId: 7, rich: { text, entities: [] } }, { text });
  return { db, links, bot, api, edits, queue, notice, enqueue };
}
const original = { maxChatId: '55', maxMessageId: 9n, telegramMessageId: 10, textTelegramMessageIds: [10] };
describe('durable incoming edits', () => {
  it('deduplicates repeat pushes but keeps a later intentional reversion', async () => {
    const h = setup(); h.links.add({ ...original });
    const first = h.enqueue('B'); expect(h.enqueue('B').id).toBe(first.id);
    h.enqueue('A'); const reverted = h.enqueue('B'); expect(reverted.id).not.toBe(first.id);
    h.queue.start(); await h.queue.drain();
    expect(h.db.pending()).toEqual([]);
    expect(h.api.mock.calls.filter(c => c[0] === 'editMessageText').map(c => (c[1] as { text: string }).text)).toEqual(['B', 'A', 'B']);
  });
  it('resumes a growing edit without repeating its acknowledged extra Telegram part', async () => {
    const h = setup(); h.links.add({ ...original });
    let sends = 0;
    h.api.mockImplementation((async (method: string) => {
      if (method !== 'sendMessage') return true;
      sends++;
      if (sends === 2) throw { response: { error_code: 429 } };
      return { message_id: 100 + sends };
    }) as typeof h.bot.telegram.callApi);
    const job = h.enqueue('x'.repeat(9000)); h.queue.start(); await h.queue.drain();
    expect(h.db.job(job.id)?.status).toBe('retry'); expect(h.links.getByTelegram(101)?.maxMessageId).toBe(9n);
    h.db.retryJob(job.id); h.queue.wake(); await h.queue.drain();
    expect(h.db.pending()).toEqual([]); expect(sends).toBe(3);
    expect(h.links.getByMax('55', 9n)?.textTelegramMessageIds).toEqual([10, 101, 103]);
  });
  it('retains an unknown Telegram send and blocks the next edit without a blind resend', async () => {
    const h = setup(); h.links.add({ ...original });
    h.api.mockImplementation((async (method: string) => {
      if (method === 'sendMessage') throw new Error('socket hang up');
      return true;
    }) as typeof h.bot.telegram.callApi);
    const job = h.enqueue('x'.repeat(5000)); h.enqueue('next'); h.queue.start(); await h.queue.drain();
    expect(h.db.job(job.id)?.status).toBe('uncertain');
    h.db.retryJob(job.id); h.queue.wake(); await h.queue.drain();
    expect(h.api.mock.calls.filter(c => c[0] === 'sendMessage')).toHaveLength(1);
    expect(h.db.pending()).toHaveLength(2);
  });
  it('recovers a confirmed edit effect from disk after interruption before binding the new part', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'telemax-edit-')); directories.push(dir);
    const file = path.join(dir, 'bridge.sqlite');
    const first = setup(file); first.links.add({ ...original }); const job = first.enqueue('x'.repeat(5000));
    const prepared = first.db.prepareEffect(job.id, 0, 'telegram.editMessageText', [{ chat_id: '42', message_id: 10, text: 'x'.repeat(4096), entities: [] }], false);
    first.db.markEffect(prepared.key, 'done', true);
    const sent = first.db.prepareEffect(job.id, 1, 'telegram.sendMessage', [{ chat_id: '42', text: 'x'.repeat(904), message_thread_id: 7, entities: [] }], false);
    first.db.markEffect(sent.key, 'done', { message_id: 101 }); first.db.close();
    const resumed = setup(file); resumed.queue.start(); await resumed.queue.drain();
    expect(resumed.db.pending()).toEqual([]);
    expect(resumed.api.mock.calls.some(c => c[0] === 'sendMessage')).toBe(false);
    expect(resumed.links.getByTelegram(101)?.maxMessageId).toBe(9n);
  });
  it('clears a removed keyboard on the last text part after growth', async () => {
    const h = setup(); h.links.add({ ...original }); h.enqueue('x'.repeat(5000)); h.queue.start(); await h.queue.drain();
    const call = h.api.mock.calls.find(c => c[0] === 'editMessageReplyMarkup');
    expect(call?.[1]).toMatchObject({ message_id: 101, reply_markup: { inline_keyboard: [] } });
  });
  it('does not create a binding from an acknowledged Telegram response missing its message id', async () => {
    const h = setup(); h.links.add({ ...original });
    h.api.mockResolvedValue({} as never); const job = h.enqueue('x'.repeat(5000));
    h.queue.start(); await h.queue.drain();
    expect(h.db.job(job.id)?.status).toBe('uncertain');
    expect(h.links.getByMax('55', 9n)?.textTelegramMessageIds).toEqual([10]);
  });
});
