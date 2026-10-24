import { describe, expect, it, vi } from 'vitest';
import { fetchFullHistory } from '../src/bridge/sync.js';
import type { MaxClient, MaxHistoryMessage } from '../src/max/client.js';
describe('lossless history timestamp boundary', () => {
  it('fetches every id on a timestamp boundary larger than a page, including the saved cursor time', async () => {
    const messages = Array.from({ length: 240 }, (_, i) => ({ id: BigInt(i + 1), time: 1000, text: String(i + 1) })) as MaxHistoryMessage[];
    messages.push({ id: 999n, time: 999, text: 'older' } as MaxHistoryMessage);
    const getChatHistory = vi.fn(async (_chat: unknown, from: number, count: number) => messages.filter(m => Number(m.time) < from).slice(0, count));
    const result = await fetchFullHistory({ getChatHistory } as unknown as MaxClient, '55', 1000);
    expect(result.messages).toHaveLength(240); expect(result.messages[0]!.id).toBe(1n); expect(result.messages.at(-1)!.id).toBe(240n);
    expect(new Set(result.messages.map(m => String(m.id))).size).toBe(240);
    expect(getChatHistory.mock.calls.some(c => c[2] > 100)).toBe(true);
  });
  it('refuses to claim completion when a full timestamp boundary cannot be paged', async () => {
    const getChatHistory = vi.fn(async (_chat: unknown, _from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: BigInt(i), time: 1000 })));
    await expect(fetchFullHistory({ getChatHistory } as unknown as MaxClient, '55', 1000)).rejects.toThrow('слишком много');
  });
});
