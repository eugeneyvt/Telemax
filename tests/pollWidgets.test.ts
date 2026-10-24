import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Telegraf } from 'telegraf';
import type { MaxClient } from '../src/max/client.js';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { PollWidgets, POLL_CALLBACK, renderPollWidget, pollVoteRestriction, type PollWidget } from '../src/bridge/pollWidgets.js';
import { DeliveryQueue, journalMaxActions } from '../src/bridge/deliveryQueue.js';
import type { MaxAttachment } from '../src/bridge/attachments.js';

let db: BridgeDatabase;
beforeEach(() => { db = new BridgeDatabase(':memory:'); vi.stubEnv('LOG_LEVEL', 'error'); });
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const poll: MaxAttachment = { _type: 'POLL', pollId: 10n, title: 'Fixture', answers: [{ text: 'One', answerId: 111 }, { text: 'Two', answerId: 222 }], settings: 1, version: 1,
  state: { total: 7, result: [{ answerId: 111, voteCount: 5, votes: [{ userId: 'private-voter' }] }, { answerId: 222, voteCount: 2 }] } };
async function harness() {
  const sendMessage = vi.fn(async () => ({ message_id: 100 }));
  const editMessageText = vi.fn(async () => true);
  const bot = { telegram: { sendMessage, editMessageText } } as unknown as Telegraf;
  const sendVote = vi.fn(async () => {});
  const max = { sendVote, getMessages: vi.fn(async () => [{ id: 99n, attaches: [poll] }]) } as unknown as MaxClient;
  journalMaxActions(max, db);
  const widgets = new PollWidgets(db, bot, max, '-10055');
  await widgets.create('55', 99n, 7, poll);
  const record = db.values<PollWidget>('pollWidgets')[0]!;
  let id = 1;
  async function click(action: string, messageId = 100) {
    const updateId = id++;
    const job = db.enqueue(`click:${updateId}`, '55', { action });
    const ctx = { update: { update_id: updateId }, callbackQuery: { message: { message_id: messageId, chat: { id: '-10055' } } }, answerCbQuery: vi.fn(async () => {}) } as unknown as Context;
    const queue = new DeliveryQueue(db, async () => widgets.click(ctx, record.key, action), () => true, async () => {});
    queue.start(); await queue.drain(); queue.stop();
    return { job, retry: async () => { db.retryJob(job.id); queue.start(); await queue.drain(); queue.stop(); } };
  }
  return { widgets, record, max, sendVote, sendMessage, editMessageText, click };
}
describe('interactive MAX poll controls', () => {
  it('respects closed polls and the MAX author restriction on revoting', () => {
    const voted = { ...poll, state: { ...poll.state, result: [{ answerId: 111, voteCount: 1, options: 1 }] } };
    expect(pollVoteRestriction(voted)).toContain('запретил');
    expect(pollVoteRestriction({ ...voted, settings: 5 })).toBeUndefined();
    expect(pollVoteRestriction({ ...voted, settings: 13 })).toContain('закрыт');
  });
  it('never sends a vote when a fresh MAX readback says it is immutable', async () => {
    const h = await harness();
    vi.mocked(h.max.getMessages).mockResolvedValue([{ id: 99n, attaches: [{ ...poll, state: { result: [{ options: 1 }] } }] }] as any);
    const task = await h.click('s');
    expect(db.job(task.job.id)!.status).toBe('done'); expect(h.sendVote).not.toHaveBeenCalled();
    expect(h.editMessageText).toHaveBeenCalledWith('-10055', 100, undefined, expect.stringContaining('запретил'), expect.anything());
  });
  it('shows actual MAX counts and supports anonymous voting without exposing voters', async () => {
    const { sendMessage, record } = await harness();
    const view = renderPollWidget(record);
    expect(view.text).toContain('Анонимный опрос MAX'); expect(view.text).toContain('голосов: 7'); expect(view.text).not.toContain('private-voter');
    expect(view.reply_markup.inline_keyboard[0]![0]!.text).toContain('5');
    expect(POLL_CALLBACK.test((view.reply_markup.inline_keyboard[0]![0] as { callback_data: string }).callback_data)).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it('uses server answer ids, never option indexes, and sends only on confirmation', async () => {
    const { click, sendVote } = await harness();
    await click('i1'); expect(sendVote).not.toHaveBeenCalled();
    await click('s'); expect(sendVote).toHaveBeenCalledWith('55', 99n, 10n, [222]);
  });
  it('does not toggle a draft twice if Telegram rendering fails after saving it', async () => {
    const { click, record, editMessageText } = await harness();
    editMessageText.mockRejectedValueOnce({ response: { error_code: 429, description: 'Too Many Requests' } });
    const task = await click('i1'); expect(db.job(task.job.id)!.status).toBe('retry');
    expect(db.get<PollWidget>('pollWidgets', record.key)!.draft).toEqual([1]);
    await task.retry(); expect(db.get<PollWidget>('pollWidgets', record.key)!.draft).toEqual([1]);
  });
  it('does not repeat a confirmed MAX vote if refreshing the result fails', async () => {
    const { click, max, sendVote } = await harness(); await click('i0');
    vi.mocked(max.getMessages).mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'ECONNRESET' }));
    const task = await click('s'); expect(db.job(task.job.id)!.status).toBe('retry');
    await task.retry(); expect(sendVote).toHaveBeenCalledTimes(1);
  });
  it('ignores stale callbacks pointing at a replaced control card', async () => {
    const { click, sendVote } = await harness(); const task = await click('s', 101);
    expect(db.job(task.job.id)!.status).toBe('failed'); expect(sendVote).not.toHaveBeenCalled();
  });
  it('retains a failed result render for a later flush', async () => {
    const { widgets, editMessageText, record } = await harness();
    editMessageText.mockRejectedValueOnce(new Error('network'));
    await expect(widgets.update('55', 99n, { ...poll, version: 2 })).rejects.toThrow('network');
    expect(db.get<PollWidget>('pollWidgets', record.key)!.dirty).toBe(true);
    await widgets.flush(); expect(db.get<PollWidget>('pollWidgets', record.key)!.dirty).toBe(false);
  });
  it('keeps newer results when an older push arrives late', async () => {
    const { widgets, record } = await harness();
    await widgets.update('55', 99n, { ...poll, version: 5 });
    await widgets.update('55', 99n, { ...poll, version: 2 });
    expect(db.get<PollWidget>('pollWidgets', record.key)!.poll.version).toBe(5);
  });
});
