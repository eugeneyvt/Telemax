import { afterEach, describe, expect, it, vi } from 'vitest';
import { Telegraf } from 'telegraf';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { IncomingCheckpoint, IncomingDeliveryUncertainError } from '../src/bridge/incomingCheckpoint.js';
import { MessageLinkStore, linkTelegramIds } from '../src/bridge/sync.js';

const databases: BridgeDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });
function setup() {
  const db = new BridgeDatabase(':memory:'); databases.push(db);
  const bot = new Telegraf('fake');
  const api = vi.spyOn(bot.telegram, 'callApi').mockResolvedValue({ message_id: 10 } as never);
  const checkpoint = new IncomingCheckpoint(bot, db);
  return { db, bot, api, checkpoint };
}
describe('incoming part checkpoints', () => {
  it('saves every confirmed text and media part before sending another one', async () => {
    const { db, bot, checkpoint, api } = setup(); const links = new MessageLinkStore(1, db);
    api.mockResolvedValueOnce({ message_id: 10 } as never).mockResolvedValueOnce({ message_id: 11 } as never);
    await checkpoint.run('55:9:7', '42', undefined, part => links.add({ maxChatId: '55', maxMessageId: 9n, telegramMessageId: part.ids[0]!, extraTelegramMessageIds: part.ids.slice(1), textTelegramMessageIds: part.textIds, partial: true }), async () => {
      await bot.telegram.sendMessage('42', 'part');
      expect(links.getByTelegram(10)?.partial).toBe(true); expect(links.covers('55', 9n)).toBe(false);
      await bot.telegram.sendVideo('42', 'file');
    });
    const link = new MessageLinkStore(1, db).getByMax('55', 9n)!;
    expect(linkTelegramIds(link)).toEqual([10, 11]); expect(link.textTelegramMessageIds).toEqual([10]);
  });
  it('removes only acknowledged partial bot copies before replay after interruption', async () => {
    const { bot, checkpoint, api } = setup();
    await checkpoint.run('55:9:7', '42', { ids: [10, 11], textIds: [10] }, () => {}, () => bot.telegram.sendMessage('42', 'full'));
    expect(api.mock.calls.map(c => c[0])).toEqual(['deleteMessage', 'deleteMessage', 'sendMessage']);
  });
  it('retains an unknown network outcome and never sends it blindly on replay', async () => {
    const { db, bot, checkpoint, api } = setup(); api.mockRejectedValueOnce(new Error('socket hang up'));
    const run = () => checkpoint.run('55:9:7', '42', undefined, () => {}, () => bot.telegram.sendMessage('42', 'part'));
    await expect(run()).rejects.toBeInstanceOf(IncomingDeliveryUncertainError);
    await expect(run()).rejects.toBeInstanceOf(IncomingDeliveryUncertainError);
    expect(api).toHaveBeenCalledTimes(1); expect(db.values('incomingPending')).toHaveLength(1);
  });
  it('a known flood refusal permits the next safe attempt', async () => {
    const { db, bot, checkpoint, api } = setup();
    api.mockRejectedValueOnce({ response: { error_code: 429 } });
    const run = () => checkpoint.run('55:9:7', '42', undefined, () => {}, () => bot.telegram.sendMessage('42', 'part'));
    await expect(run()).rejects.toMatchObject({ response: { error_code: 429 } });
    await run(); expect(db.values('incomingPending')).toEqual([]);
  });
  it('retries a socket allocation failure because no connection could carry the request', async () => {
    const { db, bot, checkpoint, api } = setup();
    api.mockRejectedValueOnce(Object.assign(new Error('connect unavailable'), { name: 'FetchError', code: 'EADDRNOTAVAIL' }));
    const run = () => checkpoint.run('key', '42', undefined, () => {}, () => bot.telegram.sendMessage('42', 'part'));
    await expect(run()).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
    expect(db.values('incomingPending')).toEqual([]); await run(); expect(api).toHaveBeenCalledTimes(2);
  });
  it.each(['FetchError/EADDRNOTAVAIL/system', 'FetchError/ECONNREFUSED/system'])('recovers a previously parked known-unsent request: %s', async diagnostic => {
    const { db, bot, checkpoint, api } = setup(); db.set('incomingPending', 'key', { diagnostic });
    await checkpoint.run('key', '42', undefined, () => {}, () => bot.telegram.sendMessage('42', 'part'));
    expect(api).toHaveBeenCalledTimes(1); expect(db.values('incomingPending')).toEqual([]);
  });
  it.each(['FetchError/ECONNRESET/system', 'FetchError/ETIMEDOUT/system', 'FetchError', undefined])('keeps genuinely unknown stored outcomes blocked: %s', async diagnostic => {
    const { db, bot, checkpoint, api } = setup(); db.set('incomingPending', 'key', { diagnostic });
    await expect(checkpoint.run('key', '42', undefined, () => {}, () => bot.telegram.sendMessage('42', 'part'))).rejects.toBeInstanceOf(IncomingDeliveryUncertainError);
    expect(api).not.toHaveBeenCalled(); expect(db.values('incomingPending')).toHaveLength(1);
  });
  it('records safe transport categories without persisting credential-bearing error text', async () => {
    const { db, bot, checkpoint, api } = setup();
    api.mockRejectedValueOnce(Object.assign(new Error('https://api.telegram.org/botSECRET/sendPhoto'), { name: 'FetchError', code: 'ETIMEDOUT', type: 'request-timeout' }));
    await expect(checkpoint.run('key', '42', undefined, () => {}, () => bot.telegram.sendPhoto('42', 'file'))).rejects.toThrow('FetchError/ETIMEDOUT/request-timeout');
    const pending = JSON.stringify(db.values('incomingPending'));
    expect(pending).toContain('request-timeout'); expect(pending).not.toContain('SECRET');
  });
  it.each([{}, { message_id: 0 }, [{ message_id: 10 }, {}], []])('never confirms an incomplete Telegram acknowledgement: %j', async result => {
    const { db, bot, checkpoint, api } = setup(); const save = vi.fn(); api.mockResolvedValueOnce(result as never);
    await expect(checkpoint.run('key', '42', undefined, save, () => bot.telegram.sendMessage('42', 'part'))).rejects.toBeInstanceOf(IncomingDeliveryUncertainError);
    expect(save).not.toHaveBeenCalled(); expect(db.values('incomingPending')).toHaveLength(1);
  });
});
