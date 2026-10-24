import { describe, expect, it, vi, afterEach } from 'vitest';
import { MaxClient } from '../src/max/client.js';
import { OPCODES, DIR } from '../src/max/opcodes.js';
import type { Telegraf } from 'telegraf';
vi.mock('../src/max/ca.js', () => ({ maxFetch: vi.fn(), maxFetchBig: vi.fn() }));
import { maxFetch } from '../src/max/ca.js';
import { uploadTelegramAttachmentToMax } from '../src/bridge/upload.js';
class ScriptedClient extends MaxClient {
  readonly sent: Array<{ opcode: number; payload: any }> = [];
  override send(opcode: number, payload?: unknown): void {
    this.sent.push({ opcode, payload });
    const answer = opcode === OPCODES.MSG_GET ? { messages: [{ id: 9n, time: 1234567890 }] }
      : opcode === OPCODES.VIDEO_UPLOAD ? { info: [{ url: 'https://example.test/upload', videoId: 99n, token: 'local' }] } : {};
    queueMicrotask(() => this.emit('message', { dir: DIR.OK, seq: 1, opcode, payload: answer, length: 0 }));
  }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('native MAX actions', () => {
  it('marks the selected message using its actual timestamp and integer ids', async () => {
    const client = new ScriptedClient(); await client.markRead('55', 9n);
    expect(client.sent).toEqual([
      { opcode: OPCODES.MSG_GET, payload: { chatId: 55n, messageIds: [9n] } },
      { opcode: OPCODES.CHAT_MARK, payload: { type: 'READ_MESSAGE', chatId: 55n, messageId: 9n, mark: 1234567890n } },
    ]);
  });
  it('pins and unpins through CHAT_SET_INFO, using zero for unpin', async () => {
    const client = new ScriptedClient(); await client.pinMessage('55', 9n); await client.pinMessage('55', null);
    expect(client.sent.map(s => s.payload)).toEqual([{ chatId: 55n, pinMessageId: 9n, notifyPin: false }, { chatId: 55n, pinMessageId: 0n, notifyPin: false }]);
  });
  it('allocates a round-video slot using both native type flags', async () => {
    const client = new ScriptedClient(); await client.requestVideoUpload(true);
    expect(client.sent[0]).toEqual({ opcode: OPCODES.VIDEO_UPLOAD, payload: { count: 1, type: 1, uploaderType: 1, profile: false } });
  });
  it('uploads a Telegram circle and creates a native VIDEO attach with millisecond duration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    vi.mocked(maxFetch).mockResolvedValue(Response.json({ thumbhash: 'AQID' }) as never);
    const max = { requestVideoUpload: vi.fn(async () => ({ url: 'https://example.test/upload', videoId: 99n, token: 'local' })), waitForVideoReady: vi.fn(async () => {}) };
    const bot = { telegram: { getFileLink: vi.fn(async () => new URL('https://example.test/file')) } };
    const attach = await uploadTelegramAttachmentToMax(bot as unknown as Telegraf, max as unknown as MaxClient, 'file-id', 'video_note', 'video_note.mp4', 12);
    expect(max.requestVideoUpload).toHaveBeenCalledWith(true);
    expect(max.waitForVideoReady).not.toHaveBeenCalled();
    const headers = vi.mocked(maxFetch).mock.calls[0]![1]!.headers;
    expect(headers).toMatchObject({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=video_note.mp4' });
    expect(headers).not.toHaveProperty('Content-Range');
    expect(attach).toEqual({ _type: 'VIDEO', videoId: 99n, token: 'local', videoType: 1, duration: 12000, thumbhash: Buffer.from([1, 2, 3]) });
  });
  it('still waits for the processing push when uploading an ordinary video', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    vi.mocked(maxFetch).mockResolvedValue(new Response('ok') as never);
    const max = { requestVideoUpload: vi.fn(async () => ({ url: 'https://example.test/upload', videoId: 99n, token: 'local' })), waitForVideoReady: vi.fn(async () => {}) };
    const bot = { telegram: { getFileLink: vi.fn(async () => new URL('https://example.test/file')) } };
    await uploadTelegramAttachmentToMax(bot as unknown as Telegraf, max as unknown as MaxClient, 'file-id', 'video', 'video.mp4', 12);
    expect(max.waitForVideoReady).toHaveBeenCalledWith(99n, expect.any(Number));
  });
  it('never sends an unprocessed circle when the direct uploader returns HTTP 200 without a thumbhash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    vi.mocked(maxFetch).mockResolvedValue(Response.json({ error_code: 'not-ready' }) as never);
    const max = { requestVideoUpload: vi.fn(async () => ({ url: 'https://example.test/upload', videoId: 99n, token: 'local' })), waitForVideoReady: vi.fn() };
    const bot = { telegram: { getFileLink: vi.fn(async () => new URL('https://example.test/file')) } };
    await expect(uploadTelegramAttachmentToMax(bot as unknown as Telegraf, max as unknown as MaxClient, 'file-id', 'video_note')).rejects.toThrow('нет thumbhash');
  });
});
