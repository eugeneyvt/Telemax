import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { TelegramAlbums, type TelegramAlbum } from '../src/bridge/telegramAlbums.js';
import { MessageLinkStore, sendAttachments, type MessageLink } from '../src/bridge/sync.js';
import { DeliveryQueue, journalMaxActions, journalTelegramActions } from '../src/bridge/deliveryQueue.js';
import type { MaxClient } from '../src/max/client.js';
import { editOutgoingMedia, replaceIncomingMedia, maxMediaSignature } from '../src/bridge/mediaEditing.js';
import { uploadTelegramAttachmentToMax } from '../src/bridge/upload.js';
import { downloadMaxAttachment } from '../src/bridge/attachments.js';
import { sendAttachmentAlbum } from '../src/bridge/attachmentAlbums.js';

vi.mock('../src/bridge/upload.js', () => ({ uploadTelegramAttachmentToMax: vi.fn() }));
vi.mock('../src/bridge/attachments.js', async original => ({ ...await original<typeof import('../src/bridge/attachments.js')>(), downloadMaxAttachment: vi.fn() }));
let db: BridgeDatabase;
beforeEach(() => {
  db = new BridgeDatabase(':memory:'); vi.useFakeTimers(); vi.setSystemTime(1700000000000);
  vi.mocked(uploadTelegramAttachmentToMax).mockImplementation(async (_b, _m, id) => ({ _type: 'PHOTO', photoToken: id }));
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const mapping = { maxChatId: '55', telegramTopicId: 7, createdAt: 'fixture' };
const update = (id: number, text = '') => ({ update_id: id, message: { message_id: id + 100, media_group_id: 'album1', caption: text, photo: [{ file_id: `photo${id}`, file_size: 5 }] } }) as any;

describe('durable Telegram album assembly', () => {
  it('keeps the first part read boundary across later parts and assembler restarts', () => {
    const first = new TelegramAlbums(db, '-10055').add(update(1), mapping, { chatId: '55', messageId: 80n });
    const second = new TelegramAlbums(db, '-10055').add(update(2), mapping, { chatId: '55', messageId: 81n });
    expect(second.id).toBe(first.id);
    expect((second.payload as TelegramAlbum).readTarget).toEqual({ chatId: '55', messageId: 80n });
  });
  it('debounces and deduplicates individual updates while blocking following chat jobs', () => {
    const albums = new TelegramAlbums(db, '-10055');
    const first = albums.add(update(1), mapping); const second = albums.add(update(2), mapping);
    expect(first.id).toBe(second.id); expect((second.payload as TelegramAlbum).messages).toHaveLength(2);
    expect(albums.add(update(1), mapping).id).toBe(first.id);
    db.enqueue('later', '55', {}); expect(db.next()).toBeUndefined();
    vi.advanceTimersByTime(2001); expect(db.next()!.id).toBe(first.id);
  });
  it('never appends a late part to a frozen effect sequence', () => {
    const albums = new TelegramAlbums(db, '-10055'); const first = albums.add(update(1), mapping);
    db.updateJobPayload(first.id, { ...(first.payload as TelegramAlbum), started: true });
    const late = albums.add(update(2), mapping);
    expect(late.id).not.toBe(first.id); expect((db.job(first.id)!.payload as TelegramAlbum).messages).toHaveLength(1);
  });
  it('reconstructs an album assembler without losing pending parts or aliases', async () => {
    const albums = new TelegramAlbums(db, '-10055'); const job = albums.add(update(1, 'one'), mapping);
    new TelegramAlbums(db, '-10055').add(update(2, 'two'), mapping);
    let cid = 10;
    const max = { sendMessage: vi.fn(async () => ({ cid: ++cid, messageId: BigInt(cid), time: Date.now() })) } as unknown as MaxClient;
    const links = new MessageLinkStore(1, db);
    const queue = new DeliveryQueue(db, payload => albums.run(payload as TelegramAlbum, {} as Telegraf, max, links, async () => mapping, () => {}), () => true, async () => {});
    vi.advanceTimersByTime(2100); queue.start(); await queue.drain(); queue.stop();
    expect(db.job(job.id)!.status).toBe('done');
    expect(max.sendMessage).toHaveBeenCalledWith('55', 'one\ntwo', [{ _type: 'PHOTO', photoToken: 'photo1' }, { _type: 'PHOTO', photoToken: 'photo2' }], undefined, { elements: [] });
    expect(new MessageLinkStore(1, db).getByTelegram(101)!.maxMessageId).toBe(new MessageLinkStore(1, db).getByTelegram(102)!.maxMessageId);
  });
  it('splits combined long captions while retaining every media part and MAX alias', async () => {
    const albums = new TelegramAlbums(db, '-10055'); albums.add(update(1, 'a'.repeat(3000)), mapping); albums.add(update(2, 'b'.repeat(3000)), mapping);
    let cid = 10; const max = { sendMessage: vi.fn(async () => ({ cid: ++cid, messageId: BigInt(cid), time: Date.now() })) } as unknown as MaxClient;
    const links = new MessageLinkStore(1, db);
    const queue = new DeliveryQueue(db, payload => albums.run(payload as TelegramAlbum, {} as Telegraf, max, links, async () => mapping, () => {}), () => true, async () => {});
    vi.advanceTimersByTime(2100); queue.start(); await queue.drain(); queue.stop();
    expect(max.sendMessage).toHaveBeenCalledTimes(2);
    expect(links.getByMax('55', 12n)!.extraMaxMessageIds).toEqual([12n]);
  });
});

describe('outgoing media replacement', () => {
  const original: MessageLink = { maxChatId: '55', maxMessageId: 99n, telegramMessageId: 101, extraTelegramMessageIds: [102], outgoing: true, telegramMedia: [
    { telegramId: 101, fileId: 'a', fileUniqueId: 'uniqueA', attach: { _type: 'PHOTO', photoToken: 'a' }, caption: 'first' },
    { telegramId: 102, fileId: 'b', attach: { _type: 'PHOTO', photoToken: 'b' }, caption: 'second' },
  ] };
  it('replaces one album picture without discarding its siblings or their captions', async () => {
    const max = { editMessage: vi.fn(async () => {}) } as unknown as MaxClient;
    const save = vi.fn();
    await editOutgoingMedia({} as Telegraf, max, db, original, { message_id: 102, photo: [{ file_id: 'c' }], caption: 'new second' }, save);
    expect(max.editMessage).toHaveBeenCalledWith('55', 99n, 'first\nnew second', [], [{ _type: 'PHOTO', photoToken: 'a' }, { _type: 'PHOTO', photoToken: 'c' }]);
    expect(save.mock.calls[0]![0].extraTelegramMessageIds).toEqual([102]);
  });
  it('does not re-upload the same unique file on a caption edit', async () => {
    const max = { editMessage: vi.fn(async () => {}) } as unknown as MaxClient;
    await editOutgoingMedia({} as Telegraf, max, db, original, { message_id: 101, photo: [{ file_id: 'new-file-id', file_unique_id: 'uniqueA' }], caption: 'new first' }, () => {});
    expect(uploadTelegramAttachmentToMax).not.toHaveBeenCalled();
    expect(max.editMessage).toHaveBeenCalledWith('55', 99n, 'new first\nsecond', [], original.telegramMedia!.map(p => p.attach));
  });
  it('refuses to guess an unknown album part', async () => {
    await expect(editOutgoingMedia({} as Telegraf, {} as MaxClient, db, original, { message_id: 999, photo: [{ file_id: 'c' }] }, () => {})).rejects.toThrow('наугад');
  });
});

describe('incoming albums and media edits', () => {
  beforeEach(() => { vi.mocked(downloadMaxAttachment).mockImplementation(async att => ({ buffer: Buffer.from('fixture'), filename: 'photo.jpg', kind: att._type === 'VIDEO' ? 'video' : 'photo' })); });
  it('sends photos and ordinary videos as one Telegram album', async () => {
    const sendMediaGroup = vi.fn(async () => [{ message_id: 201 }, { message_id: 202 }]);
    const bot = { telegram: { sendMediaGroup } } as unknown as Telegraf;
    const result = await sendAttachmentAlbum(bot, '-10055', 7, [{ _type: 'PHOTO' }, { _type: 'VIDEO', videoType: 0 }], { max: {} as MaxClient, chatId: 55, messageId: 99 });
    expect(result).toEqual([201, 202]); expect(sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(sendMediaGroup.mock.calls[0]).toBeDefined();
  });
  it('never treats a video circle as an ordinary album video', async () => {
    const result = await sendAttachmentAlbum({} as Telegraf, '-10055', 7, [{ _type: 'PHOTO' }, { _type: 'VIDEO', videoType: 1 }], { max: {} as MaxClient, chatId: 55, messageId: 99 });
    expect(result).toBeNull();
  });
  it('edits a bot-owned photo in place without deleting or sending another copy', async () => {
    const editMessageMedia = vi.fn(async () => true), deleteMessage = vi.fn();
    const bot = { telegram: { editMessageMedia, deleteMessage } } as unknown as Telegraf;
    const send = vi.fn();
    const link = await replaceIncomingMedia(bot, {} as MaxClient, '-10055', 7, { maxChatId: 55, maxMessageId: 99n, telegramMessageId: 201, mediaTelegramMessageIds: [201] }, [{ _type: 'PHOTO', photoId: 'new' }], send);
    expect(link.telegramMessageId).toBe(201); expect(editMessageMedia).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled(); expect(deleteMessage).not.toHaveBeenCalled();
  });
  it('preserves the owner-authored Telegram original when MAX changes its media', async () => {
    const deleteMessage = vi.fn();
    const link = await replaceIncomingMedia({ telegram: { deleteMessage } } as unknown as Telegraf, {} as MaxClient, '-10055', 7, { maxChatId: 55, maxMessageId: 99n, telegramMessageId: 101, outgoing: true }, [{ _type: 'PHOTO', photoId: 'new' }], async () => [201]);
    expect(link.telegramMessageId).toBe(101); expect(link.extraTelegramMessageIds).toEqual([201]); expect(deleteMessage).not.toHaveBeenCalled();
  });
  it('fingerprints media identity rather than bigint serialization or download query rotation', () => {
    expect(maxMediaSignature([{ _type: 'PHOTO', photoId: 9007199254740993n }])).not.toBe(maxMediaSignature([{ _type: 'PHOTO', photoId: 9007199254740994n }]));
    expect(maxMediaSignature([{ _type: 'PHOTO', baseUrl: 'https://fixture/photo?token=one' }])).toBe(maxMediaSignature([{ _type: 'PHOTO', baseUrl: 'https://fixture/photo?token=two' }]));
  });
});
