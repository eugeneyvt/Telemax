import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { ReadReceipts } from '../src/bridge/readReceipts.js';

let db: BridgeDatabase;
beforeEach(() => { db = new BridgeDatabase(':memory:'); });
afterEach(() => { db.close(); vi.restoreAllMocks(); });
function setup() {
  const sendMessage = vi.fn(async (_chat: unknown, _text: string, _options?: unknown) => ({ message_id: 100 }));
  const editMessageText = vi.fn(async () => true);
  const deps = { db, bot: { telegram: { sendMessage, editMessageText } } as unknown as Telegraf, destination: '-10055', ownId: () => 1, topic: vi.fn(async () => ({ telegramTopicId: 7 })), name: async () => 'Fixture' };
  return { deps, receipts: new ReadReceipts(deps), sendMessage, editMessageText };
}
const mark = (value = 1700000000000) => ({ chatId: 55, userId: 2, mark: value, setAsUnread: false });

describe('MAX read receipt rendering', () => {
  it('initializes old read evidence from chat snapshots without waiting for a new push', async () => {
    const { receipts, sendMessage } = setup(); receipts.seed({ id: 55, participants: { 1: 1700000000000, 2: 1700000060000 } }); await receipts.flush();
    expect(sendMessage.mock.calls[0]?.[1]).toContain('прочитано до'); expect(db.values('readMarks')).toHaveLength(1);
  });
  it('recovers an outgoing status refresh even when the peer has never sent a read marker', async () => {
    const h = setup(); h.receipts.touch('55');
    const receipts = new ReadReceipts({ ...h.deps, latestOutgoing: async () => ({ time: 1700000000000, telegramId: 7 }) });
    await receipts.flush(); expect(h.sendMessage.mock.calls[0]?.[1]).toContain('подтверждения прочтения пока нет');
  });
  it('does not roll an explicit unread toggle back from an unchanged cached chat snapshot', () => {
    const { receipts } = setup(); receipts.accept({ ...mark(), setAsUnread: true });
    receipts.seed({ id: 55, participants: { 2: 1700000000000 } }); expect(db.values<any>('readMarks')[0].setAsUnread).toBe(true);
  });
  it('ignores the owner, malformed marks and events with unknown semantics', () => {
    const { receipts } = setup();
    expect(receipts.accept({ ...mark(), userId: 1 })).toBe(false);
    expect(receipts.accept({ ...mark(), mark: 'bad' })).toBe(false);
    expect(receipts.accept({ ...mark(), setAsUnread: undefined })).toBe(false);
    expect(db.values('readMarks')).toHaveLength(0);
  });
  it('persists before rendering, reuses one card and rejects stale read markers', async () => {
    const { receipts, sendMessage, editMessageText } = setup();
    expect(receipts.accept(mark())).toBe(true);
    expect(db.values('readMarks')).toHaveLength(1);
    await receipts.flush(); expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(receipts.accept(mark(1699999999999))).toBe(false);
    receipts.accept(mark(1700000060000)); await receipts.flush();
    expect(sendMessage).toHaveBeenCalledTimes(1); expect(editMessageText).toHaveBeenCalledTimes(1);
    expect(editMessageText.mock.calls[0]).toMatchObject(['-10055', 100, undefined, expect.stringContaining('прочитано до')]);
  });
  it('recovers pending receipt rendering after reconstructing from SQLite', async () => {
    const { receipts, deps, sendMessage } = setup(); receipts.accept(mark());
    await new ReadReceipts(deps).flush(); expect(sendMessage).toHaveBeenCalledTimes(1);
    await new ReadReceipts(deps).flush(); expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it('does not falsely describe an unread toggle as evidence of never reading', async () => {
    const { receipts, sendMessage } = setup(); receipts.accept({ ...mark(), setAsUnread: true }); await receipts.flush();
    expect(sendMessage.mock.calls[0]?.[1]).toContain('отметил(а) чат непрочитанным');
  });
  it('does not duplicate a card after an unknown Telegram send outcome', async () => {
    const { receipts, deps, sendMessage } = setup(); sendMessage.mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    receipts.accept(mark()); await expect(receipts.flush()).rejects.toThrow('reset');
    await new ReadReceipts(deps).flush(); expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it('safely retries a connection refusal which could not have created a card', async () => {
    const { receipts, sendMessage } = setup(); sendMessage.mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    receipts.accept(mark()); await expect(receipts.flush()).rejects.toThrow('refused');
    await receipts.flush(); expect(sendMessage).toHaveBeenCalledTimes(2);
  });
  it('keeps an event that arrived during a card creation for the next flush', async () => {
    const { receipts, sendMessage, editMessageText } = setup();
    sendMessage.mockImplementationOnce(async () => { receipts.accept(mark(1700000060000)); return { message_id: 100 }; });
    receipts.accept(mark()); await receipts.flush(); await receipts.flush();
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });
});
