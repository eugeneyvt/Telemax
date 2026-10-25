import type { BridgeDatabase } from '../store/bridgeDatabase.js';
import type { ChatMapStore } from '../store/chatMapStore.js';

/** A cursor proves delivery only within its own Telegram destination. Repair older transfers
 * once, keeping local links/checkpoints so interrupted backfills skip confirmed deliveries. */
export async function initializeStandaloneHistory(db: BridgeDatabase, map: ChatMapStore, chatId: string): Promise<void> {
  if (db.get('standaloneHistory', 'destination-v1')) return;
  const mapping = await map.getByMaxChatId(chatId);
  if (!mapping) throw new Error('Standalone history mapping missing');
  const { historyBackfillCursor: _inherited, ...fresh } = mapping;
  await map.upsert(fresh);
  // Commit after the file: a crash before this write safely repeats with existing links intact.
  db.set('standaloneHistory', 'destination-v1', true);
}
