import { describe, expect, it, vi } from 'vitest';
import type { Telegraf } from 'telegraf';
import { installGroupDiscovery } from '../src/telegram/groupDiscovery.js';
function setup() {
  let middleware: any; const save = vi.fn(async () => {}); const next = vi.fn();
  const ctx = { from: { id: 42 }, chat: { id: -100, type: 'supergroup' }, message: { text: '/panel' }, botInfo: { id: 99 }, reply: vi.fn(),
    telegram: { getChat: vi.fn(async () => ({ title: 'Test', is_forum: true })), getChatMembersCount: vi.fn(async () => 2), getChatMember: vi.fn(async (_chat: number, id: number) => ({ status: id === 42 ? 'creator' : 'administrator', can_manage_topics: true })) } };
  installGroupDiscovery({ use: (m: any) => { middleware = m; } } as unknown as Telegraf, 42, '42', save);
  return { ctx, save, next, run: () => middleware(ctx, next) };
}
describe('owner-requested group discovery', () => {
  it('records group capabilities without automatically changing the destination', async () => {
    const h = setup(); await h.run(); expect(h.save).toHaveBeenCalledWith({ chatId: '-100', title: 'Test', isForum: true, memberCount: 2, botCanManageTopics: true, ownerIsAdmin: true });
    expect(h.next).not.toHaveBeenCalled();
  });
  it('ignores another person attempting to select a group', async () => {
    const h = setup(); h.ctx.from.id = 7; await h.run(); expect(h.save).not.toHaveBeenCalled(); expect(h.next).toHaveBeenCalled();
  });
  it('ignores ordinary messages, which cannot authorize group setup', async () => {
    const h = setup(); h.ctx.message.text = 'hello'; await h.run(); expect(h.save).not.toHaveBeenCalled(); expect(h.next).toHaveBeenCalled();
  });
});
