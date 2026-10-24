import { describe, expect, it } from 'vitest';
import { bridgeHealth, serveBridgeHealth, type HealthInput } from '../src/server/health.js';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
const now = 1700000000000;
const healthy: HealthInput = { startedAt: now - 600000, maxState: 'loggedIn', telegramEnabled: true, telegramActive: true, lastTelegramPollAt: now - 50000, paused: false };
describe('bridge health evidence', () => {
  it('requires the independent observer credential and exposes no message content', async () => {
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
    const token = 'fixture-observer-key-'.repeat(3);
    const server = serveBridgeHealth(() => ({ ...healthy, startedAt: Date.now() - 600000, lastTelegramPollAt: Date.now() }), token, port, '127.0.0.1');
    await once(server, 'listening');
    try {
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(404);
      const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const status = await response.text(); expect(status).not.toContain(token); expect(status).not.toContain('message');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('detects an alive process that lost Telegram polling', () => {
    expect(bridgeHealth({ ...healthy, lastTelegramPollAt: now - 600000 }, now)).toMatchObject({ ok: false, reasons: ['telegram-polling-stale'] });
  });
  it('does not declare a connected but unauthenticated MAX socket ready', () => {
    expect(bridgeHealth({ ...healthy, maxState: 'ready' }, now)).toMatchObject({ ok: false, reasons: ['max-disconnected'] });
  });
  it('allows startup grace and deliberate MAX pauses', () => {
    expect(bridgeHealth({ ...healthy, startedAt: now, maxState: 'connecting', telegramActive: false }, now).ok).toBe(true);
    expect(bridgeHealth({ ...healthy, maxState: 'paused', paused: true }, now).ok).toBe(true);
  });
  it('reports failed deliveries for attention without restarting a healthy worker', () => {
    const status = bridgeHealth({ ...healthy, queue: { pending: 2, failed: 1, uncertain: 1, oldestAt: now - 1000 } }, now);
    expect(status).toMatchObject({ ok: true, attention: 2 });
  });
  it('counts all persisted jobs rather than the first UI page', () => {
    const db = new BridgeDatabase(':memory:');
    for (let i = 0; i < 50; i++) db.markJob(db.enqueue(String(i), String(i), {}).id, i % 2 ? 'failed' : 'uncertain');
    expect(db.health()).toMatchObject({ pending: 50, failed: 25, uncertain: 25 }); db.close();
  });
  it('alerts on a long retry backlog without restarting an otherwise healthy process', () => {
    const queue = { pending: 1, failed: 0, uncertain: 0, oldestAt: now - 20 * 60000 };
    expect(bridgeHealth({ ...healthy, queue }, now)).toMatchObject({ ok: true, attention: 1, queueStalled: true });
    expect(bridgeHealth({ ...healthy, queue, paused: true }, now).attention).toBe(0);
  });
});
