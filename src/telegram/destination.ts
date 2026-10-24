export interface TelegramDestination { chatId: string; ownerUserId?: number; mode: 'private' | 'group' }
/** No automatic owner discovery: knowing a bot's username must never grant access to MAX. */
export function telegramDestination(env: NodeJS.ProcessEnv = process.env): TelegramDestination {
  const ownerRaw = (env.TELEGRAM_OWNER_ID ?? '').trim();
  const ownerUserId = ownerRaw ? Number(ownerRaw) : undefined;
  if (ownerRaw && (!/^\d+$/.test(ownerRaw) || !Number.isSafeInteger(ownerUserId) || ownerUserId! <= 0)) throw new Error('TELEGRAM_OWNER_ID должен быть положительным числовым Telegram user id.');
  const mode = (env.TELEGRAM_CHAT_MODE ?? 'private').trim();
  if (mode !== 'private' && mode !== 'group') throw new Error('TELEGRAM_CHAT_MODE: допустимы private и group.');
  if (env.TELEGRAM_BOT_TOKEN && ownerUserId == null) throw new Error('Укажите TELEGRAM_OWNER_ID владельца. Для тем в личке включите темы бота в BotFather и отправьте ему /start.');
  const chatId = mode === 'private' ? ownerUserId == null ? '' : String(ownerUserId) : (env.TARGET_TELEGRAM_GROUP ?? '').trim();
  if (mode === 'group' && chatId && (!/^-\d+$/.test(chatId))) throw new Error('Для group нужен отрицательный TARGET_TELEGRAM_GROUP.');
  return { chatId, ownerUserId, mode };
}
