import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { ReactionSummaries } from '../src/bridge/reactionSummaries.js';
let db: BridgeDatabase;
beforeEach(() => { db = new BridgeDatabase(':memory:'); });
afterEach(() => { db.close(); });
describe('persistent MAX reaction counters', () => {
  it('renders all counters including emoji Telegram cannot use as reactions', async () => {
    const create = vi.fn(async () => 100);
    const cards = new ReactionSummaries(db, {} as Telegraf, '-10055', create);
    await cards.update('55', 99n, 7, [{ reaction: '🔥', count: 3 }, { reaction: '🦄', count: 2 }]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ text: 'Реакции MAX: 🔥 × 3 · 🦄 × 2' }));
    expect(cards.active()).toHaveLength(1);
  });
  it('restores removal tracking and edits one card rather than creating duplicates', async () => {
    const create = vi.fn(async () => 100), editMessageText = vi.fn(async () => true);
    const bot = { telegram: { editMessageText } } as unknown as Telegraf;
    await new ReactionSummaries(db, bot, '-10055', create).update('55', 99n, 7, [{ reaction: '🔥', count: 3 }]);
    const restored = new ReactionSummaries(db, bot, '-10055', create);
    await restored.update('55', 99n, 7, []);
    expect(create).toHaveBeenCalledTimes(1); expect(editMessageText).toHaveBeenCalledWith('-10055', 100, undefined, 'Реакций MAX больше нет.');
    expect(restored.active()).toHaveLength(0);
  });
  it('does not overwrite a newer count which arrived during the original card send', async () => {
    let release!: (id: number) => void;
    const create = vi.fn(() => new Promise<number>(resolve => { release = resolve; }));
    const editMessageText = vi.fn(async () => true);
    const cards = new ReactionSummaries(db, { telegram: { editMessageText } } as unknown as Telegraf, '-10055', create);
    const first = cards.update('55', 99n, 7, [{ reaction: '🔥', count: 1 }]);
    await Promise.resolve(); await Promise.resolve();
    const second = cards.update('55', 99n, 7, [{ reaction: '🔥', count: 2 }]);
    release(100); await Promise.all([first, second]);
    expect(editMessageText).toHaveBeenCalledWith('-10055', 100, undefined, 'Реакции MAX: 🔥 × 2');
    expect(db.values<any>('reactionSummaries')[0].dirty).toBe(false);
  });
  it('keeps a watched message for later MAX polling without inventing counts', async () => {
    const create = vi.fn(); const cards = new ReactionSummaries(db, {} as Telegraf, '-10055', create);
    cards.watch('55', 99n, 7); await cards.flush();
    expect(create).not.toHaveBeenCalled(); expect(cards.active()).toHaveLength(1);
  });
});
