import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface HealthInput {
  startedAt: number; maxState: string; telegramEnabled: boolean; telegramActive: boolean;
  lastTelegramPollAt: number | null; paused: boolean;
  queue?: { pending: number; failed: number; uncertain: number; oldestAt: number | null };
  incomingUncertain?: number;
}
export function bridgeHealth(input: HealthInput, now = Date.now()) {
  const starting = now - input.startedAt < 180_000;
  const reasons: string[] = [];
  if (!starting && !input.paused && input.maxState !== 'loggedIn') reasons.push('max-disconnected');
  if (!starting && input.telegramEnabled && (!input.telegramActive || input.lastTelegramPollAt == null || now - input.lastTelegramPollAt > 180_000)) reasons.push('telegram-polling-stale');
  const queueStalled = !input.paused && input.queue?.oldestAt != null && input.queue.pending > 0 && now - input.queue.oldestAt > 15 * 60_000;
  return { schema: 1, at: now, ...input, ok: reasons.length === 0, reasons, queueStalled,
    attention: Math.max(queueStalled ? 1 : 0, (input.queue?.failed ?? 0) + (input.queue?.uncertain ?? 0) + (input.incomingUncertain ?? 0)) };
}

/** Atomic, private, content-free status for Docker and an independent host-side observer. */
export async function writeBridgeHealth(file: string, input: HealthInput): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.partial`;
  await writeFile(temporary, JSON.stringify(bridgeHealth(input)), { mode: 0o600 });
  await rename(temporary, file);
}

/** Optional private readiness endpoint. Deployment publishes it only on the Tailscale address. */
export function serveBridgeHealth(input: () => HealthInput, token: string, port: number, host = '0.0.0.0'): Server {
  if (token.length < 32 || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Для мониторинга нужны отдельный секрет и непривилегированный порт.');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (request.method !== 'GET' || request.url !== '/health' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(404); response.end(); return; }
    const result = bridgeHealth(input());
    response.writeHead(result.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(result));
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  server.listen(port, host);
  return server;
}
