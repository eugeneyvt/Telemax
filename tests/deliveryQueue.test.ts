import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Telegraf } from 'telegraf';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { DeliveryQueue, installPollingInbox, journalMaxActions } from '../src/bridge/deliveryQueue.js';
import { MaxRequestOutcomeUnknownError, type MaxClient } from '../src/max/client.js';
import { OPCODES } from '../src/max/opcodes.js';
const opened: BridgeDatabase[] = [], workers: DeliveryQueue[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.stubEnv('LOG_LEVEL', 'error'); });
afterEach(async () => { for (const q of workers.splice(0)) { q.stop(); await q.drain(); } for (const d of opened.splice(0)) d.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function setup(run: (max: MaxClient) => Promise<void>, fake: object) {
  const db = new BridgeDatabase(':memory:'); opened.push(db);
  const max = fake as MaxClient; journalMaxActions(max, db);
  const notice = vi.fn(async () => {});
  const q = new DeliveryQueue(db, () => run(max), () => true, notice); workers.push(q);
  const job = db.enqueue('u1', 'chat1', {});
  return { db, q, job, notice };
}
describe('durable delivery queue', () => {
  it('repairs legacy binary attachment fields before retrying a refused send', async () => {
    const send = vi.fn(async () => ({ messageId: 1n }));
    const { db, q, job } = setup(async max => { await max.sendMessage('55', '', [{ thumbhash: Buffer.from([1, 255]) }]); }, { sendMessage: send });
    const effect = db.prepareEffect(job.id, 0, 'sendMessage', ['55', '', [{ thumbhash: { '0': 1, '1': 255 }, wave: { '0': 2 }, other: { '0': 3 } }]], true);
    q.start(); await q.drain();
    expect(db.job(job.id)?.status).toBe('done');
    const args = send.mock.calls[0] as unknown as any[];
    expect(args[2][0].thumbhash).toEqual(Buffer.from([1, 255])); expect(args[2][0].wave).toEqual(Buffer.from([2]));
    expect(args[2][0].other).toEqual({ '0': 3 }); expect(args[4].cid).toBe(effect.cid);
  });
  it('retries temporary no-write failures without forgetting the original task', async () => {
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })).mockResolvedValue({ messageId: 1n });
    const { db, q, job } = setup(async max => { await max.sendMessage('55', 'hello'); }, { sendMessage: send });
    q.start(); await q.drain(); expect(db.job(job.id)?.status).toBe('retry');
    await vi.advanceTimersByTimeAsync(3000); await q.drain();
    expect(db.job(job.id)?.status).toBe('done'); expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![4].cid).toBe(send.mock.calls[1]![4].cid);
  });
  it('does not repeat a confirmed first part when a later part failed', async () => {
    const send = vi.fn().mockResolvedValueOnce({ messageId: 1n }).mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })).mockResolvedValue({ messageId: 2n });
    const { db, q, job } = setup(async max => { await max.sendMessage('55', 'one'); await max.sendMessage('55', 'two'); }, { sendMessage: send });
    q.start(); await q.drain(); await vi.advanceTimersByTimeAsync(3000); await q.drain();
    expect(db.job(job.id)?.status).toBe('done');
    expect(send.mock.calls.map(c => c[1])).toEqual(['one', 'two', 'two']);
  });
  it('reconciles an unknown send by cid without transmitting the message twice', async () => {
    let cid: number;
    const send = vi.fn(async (...args: unknown[]) => { cid = (args[4] as { cid: number }).cid; throw new MaxRequestOutcomeUnknownError(OPCODES.MSG_SEND); });
    const history = vi.fn(async () => [{ id: 900n, time: Date.now(), cid: cid!, text: 'hello' }]);
    let received: unknown;
    const { db, q, job } = setup(async max => { received = await max.sendMessage('55', 'hello'); }, { sendMessage: send, getChatHistory: history });
    q.start(); await q.drain(); expect(db.job(job.id)?.status).toBe('uncertain');
    db.retryJob(job.id); q.wake(); await q.drain();
    expect(db.job(job.id)?.status).toBe('done'); expect(send).toHaveBeenCalledTimes(1);
    expect(received).toMatchObject({ messageId: 900n, cid: cid! });
  });
  it('keeps an unresolved send on disk and blocks a later message in that chat', async () => {
    const send = vi.fn(async () => { throw new MaxRequestOutcomeUnknownError(OPCODES.MSG_SEND); });
    const { db, q, job } = setup(async max => { await max.sendMessage('55', 'hello'); }, { sendMessage: send, getChatHistory: async () => [] });
    db.enqueue('u2', 'chat1', {}); q.start(); await q.drain();
    await vi.advanceTimersByTimeAsync(65_000); await q.drain();
    expect(db.job(job.id)?.status).toBe('uncertain'); expect(db.pending()).toHaveLength(2); expect(send).toHaveBeenCalledTimes(1);
  });
  it('accepts a positive PUSH confirmation even if the request ACK is lost', async () => {
    let db: BridgeDatabase;
    const send = vi.fn(async (...args: unknown[]) => {
      const cid = (args[4] as { cid: number }).cid;
      db.confirmSend(cid, '55', 'hello', { cid, messageId: 71n, time: Date.now(), attaches: [] });
      throw new MaxRequestOutcomeUnknownError(OPCODES.MSG_SEND);
    });
    const h = setup(async max => { await max.sendMessage('55', 'hello'); }, { sendMessage: send }); db = h.db;
    h.q.start(); await h.q.drain(); expect(db.job(h.job.id)?.status).toBe('done'); expect(send).toHaveBeenCalledTimes(1);
  });
  it('commits a polling batch before returning it to Telegraf, and refuses acknowledgement on disk failure', async () => {
    const bot = new Telegraf('0:FAKE');
    const update = { update_id: 42 } as any;
    bot.telegram.callApi = vi.fn(async () => [update]) as any;
    const db = new BridgeDatabase(':memory:'); opened.push(db);
    const enqueue = vi.spyOn(db, 'enqueue').mockImplementationOnce(() => { throw new Error('disk full'); });
    installPollingInbox(bot, async u => { db.enqueue(String(u.update_id), '55', u); });
    await expect(bot.telegram.callApi('getUpdates', {})).rejects.toMatchObject({ name: 'FetchError' });
    await expect(bot.telegram.callApi('getUpdates', {})).resolves.toEqual([update]);
    expect(db.hasJob('42')).toBe(true); expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
