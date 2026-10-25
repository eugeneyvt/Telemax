import type { Telegraf } from 'telegraf';
import type { BridgeDatabase } from '../store/bridgeDatabase.js';
import { withFloodRetry } from './transient.js';

/** Remove only recorded automatic receipt cards. Never enumerate or delete conversation history. */
export async function removeReceiptCards(db: BridgeDatabase, bot: Pick<Telegraf, 'telegram'>, destination: string): Promise<void> {
  for (const card of db.values<{ id: number }>('readCards')) {
    if (!Number.isSafeInteger(card.id) || card.id <= 0) throw new Error('Invalid stored receipt-card id');
    try { await withFloodRetry(() => bot.telegram.deleteMessage(destination, card.id)); }
    catch (error) {
      const response = (error as { response?: { error_code?: number; description?: string } }).response;
      if (response?.error_code !== 400 || !/message to delete not found/i.test(response.description ?? '')) throw error;
    }
  }
  db.clearKind('readCards'); db.clearKind('readCardPending'); db.clearKind('receiptChats');
}
