import type { Telegraf } from 'telegraf';

export interface GroupCandidate { chatId: string; title: string; isForum: boolean; memberCount: number; botCanManageTopics: boolean; ownerIsAdmin: boolean }
/** Records an explicit owner setup request; never grants a new group access to MAX. */
export function installGroupDiscovery(bot: Telegraf, owner: number | undefined, configuredChat: string, save: (candidate: GroupCandidate) => Promise<void>): void {
  bot.use(async (ctx, next) => {
    const chat = ctx.chat;
    if (owner == null || ctx.from?.id !== owner || !chat || !['group', 'supergroup'].includes(chat.type)
      || String(chat.id) === configuredChat || !ctx.message || !('text' in ctx.message)
      || !/^\/panel(?:@\w+)?\s*$/.test(ctx.message.text)) return next();
    const [info, count, admin, me] = await Promise.all([
      ctx.telegram.getChat(chat.id), ctx.telegram.getChatMembersCount(chat.id),
      ctx.telegram.getChatMember(chat.id, owner), ctx.telegram.getChatMember(chat.id, ctx.botInfo.id),
    ]);
    await save({ chatId: String(chat.id), title: 'title' in info ? info.title : '', isForum: 'is_forum' in info && info.is_forum === true,
      memberCount: count, ownerIsAdmin: admin.status === 'creator' || admin.status === 'administrator',
      botCanManageTopics: me.status === 'creator' || (me.status === 'administrator' && me.can_manage_topics === true) });
    await ctx.reply('Группа обнаружена. Проверю темы и права бота перед подключением MAX.');
  });
}
