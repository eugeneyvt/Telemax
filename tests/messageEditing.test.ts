import { describe, expect, it, vi } from 'vitest';
import type { MaxClient } from '../src/max/client.js';
import type { Telegraf } from 'telegraf';
import { editIncomingText, editOutgoingText } from '../src/bridge/messageEditing.js';
import type { MessageLink } from '../src/bridge/sync.js';
describe('editing all parts of a logical message', () => {
  it('splits a 4096-character outgoing edit and deletes obsolete tails on shrink', async () => {
    const fake = { editMessage: vi.fn(async (_chat: unknown, _id: unknown, _text: string, _elements?: unknown[]) => {}), sendMessage: vi.fn(async () => ({ messageId: 12n })), deleteMessages: vi.fn(async () => {}) };
    const save = vi.fn();
    const original: MessageLink = { maxChatId: '55', maxMessageId: 10n, telegramMessageId: 7, outgoing: true, extraMaxMessageIds: [11n] };
    await editOutgoingText(fake as unknown as MaxClient, original, { text: 'b'.repeat(4096), entities: [{ type: 'bold', offset: 0, length: 4096 }] }, save);
    expect(fake.editMessage.mock.calls.map(c => c[2].length)).toEqual([4000, 96]);
    expect(fake.editMessage.mock.calls[1]?.[3]).toEqual([{ type: 'STRONG', from: 0, length: 96 }]);
    await editOutgoingText(fake as unknown as MaxClient, original, { text: 'short', entities: [] }, save);
    expect(fake.deleteMessages).toHaveBeenCalledWith('55', [11n], false);
    expect(save.mock.calls.at(-1)?.[0].extraMaxMessageIds).toEqual([]);
  });
  it('grows an outgoing message and saves every confirmed new id', async () => {
    const max = { editMessage: vi.fn(async () => {}), sendMessage: vi.fn(async () => ({ messageId: 12n })), deleteMessages: vi.fn(async () => {}) };
    const save = vi.fn();
    await editOutgoingText(max as unknown as MaxClient, { maxChatId: '55', maxMessageId: 10n, telegramMessageId: 7, outgoing: true }, { text: 'x'.repeat(4096), entities: [] }, save);
    expect(max.sendMessage).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].extraMaxMessageIds).toEqual([12n]);
  });
  it('resizes incoming text without truncating it or editing/deleting media', async () => {
    const t = { editMessageText: vi.fn(async (_chat: string, _id: number, _inline: unknown, _text: string, _options?: unknown) => true), sendMessage: vi.fn(async (_chat: string, _text: string, _options?: unknown) => ({ message_id: 30 })), deleteMessage: vi.fn(async () => true) };
    const save = vi.fn();
    const original: MessageLink = { maxChatId: '55', maxMessageId: 10n, telegramMessageId: 20, textTelegramMessageIds: [20], extraTelegramMessageIds: [21] };
    await editIncomingText({ telegram: t } as unknown as Telegraf, '42', 9, original, { text: 'x'.repeat(5000), entities: [] }, save);
    expect(t.editMessageText.mock.calls[0]?.[3]).toHaveLength(4096);
    expect(t.sendMessage.mock.calls[0]?.[1]).toHaveLength(904);
    const grown = save.mock.calls.at(-1)?.[0] as MessageLink;
    expect(grown.extraTelegramMessageIds).toEqual([30, 21]);
    expect(grown.textTelegramMessageIds).toEqual([20, 30]);
    await editIncomingText({ telegram: t } as unknown as Telegraf, '42', 9, grown, { text: 'short', entities: [] }, save);
    expect(t.deleteMessage).toHaveBeenCalledWith('42', 30);
    expect(t.deleteMessage).not.toHaveBeenCalledWith('42', 21);
  });
});
