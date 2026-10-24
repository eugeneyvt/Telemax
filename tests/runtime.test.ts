import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Telegraf } from 'telegraf';
import { assertSupportedRuntime } from '../src/server/runtime.js';

describe('supported production runtime', () => {
  it.each(['22.19.0', '22.21.1', '24.0.0', '24.19.0'])('accepts %s', version => {
    expect(() => assertSupportedRuntime(version)).not.toThrow();
  });
  it.each(['20.19.0', '22.18.0', '23.0.0', '25.0.0', '26.0.0'])('refuses %s before starting a partial bridge', version => {
    expect(() => assertSupportedRuntime(version)).toThrow('Node.js');
  });
  it.skipIf(Number(process.versions.node.split('.')[0]) >= 26)('transfers a real multipart body through Telegraf, including its final boundary', async () => {
    let body = '';
    const server = createServer((request, response) => {
      request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
      request.on('end', () => response.end(JSON.stringify({ ok: true, result: { message_id: 123 } })));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const timer = setTimeout(() => server.closeAllConnections(), 3000);
    try {
      const bot = new Telegraf('fake', { telegram: { apiRoot: `http://127.0.0.1:${address.port}` } });
      const result = await bot.telegram.sendDocument(42, { source: Buffer.from('multipart transport probe'), filename: 'probe.txt' });
      expect(result.message_id).toBe(123); expect(body).toContain('multipart transport probe'); expect(body).toMatch(/--[a-f0-9]+--$/);
    } finally {
      clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
