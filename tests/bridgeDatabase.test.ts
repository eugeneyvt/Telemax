import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { BridgeDatabase, decodePersistent, encodePersistent } from '../src/store/bridgeDatabase.js';
import { MessageLinkStore, PollLinkStore } from '../src/bridge/sync.js';

const opened: BridgeDatabase[] = [];
const dirs: string[] = [];
function open(file = ':memory:') { const d = new BridgeDatabase(file); opened.push(d); return d; }
function tempFile() { const dir = mkdtempSync(path.join(tmpdir(), 'telemax-db-')); dirs.push(dir); return path.join(dir, 'bridge.sqlite'); }
afterEach(() => { for (const d of opened.splice(0)) d.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('durable bridge state', () => {
  it('round-trips nested BigInt/undefined without interpreting user JSON as codec tags', () => {
    const v = { id: 99999999999999999n, missing: undefined, input: { '$bigint': '123', tag: ['i', '123'] } };
    expect(decodePersistent(encodePersistent(v))).toEqual(v);
  });
  it('keeps every part, notice and poll after cache eviction and reopening', () => {
    const file = tempFile(); let db = open(file); let links = new MessageLinkStore(2, db);
    for (let i = 1; i <= 501; i++) links.add({ maxChatId: 55, maxMessageId: BigInt(i), telegramMessageId: i, outgoing: true });
    links.add({ maxChatId: 56, maxMessageId: 999999999999999999n, telegramMessageId: 9000, extraTelegramMessageIds: [9001], extraMaxMessageIds: [999999999999999998n], noticeTelegramMessageIds: [9002] });
    new PollLinkStore(1, db).add('poll1', { maxChatId: 55, maxMessageId: 1n, maxPollId: 500n, answerIdByOptionIndex: [2, 7] });
    db.close(); db = open(file); links = new MessageLinkStore(2, db);
    expect(links.getByTelegram(1)?.maxMessageId).toBe(1n);
    expect(links.getByMax(56, 999999999999999998n)?.telegramMessageId).toBe(9000);
    expect(links.getByTelegram(9002)?.noticeTelegramMessageIds).toEqual([9002]);
    expect(new PollLinkStore(1, db).getByTelegramPollId('poll1')?.maxPollId).toBe(500n);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it('preserves binary media fields through disk serialization, including typed-array slices', () => {
    const file = tempFile(); let db = open(file);
    const bytes = new Uint8Array([0, 1, 255, 2]);
    const job = db.enqueue('binary', '55', {});
    db.prepareEffect(job.id, 0, 'sendMessage', ['55', '', [{ thumbhash: Buffer.from([1, 255]), wave: bytes.subarray(1, 3), empty: Buffer.alloc(0), json: { '0': 1, '1': 2 } }]], true);
    db.close(); db = open(file);
    const attach = (db.effect(`${job.id}:0`)!.args[2] as any[])[0];
    expect(Buffer.isBuffer(attach.thumbhash)).toBe(true); expect(attach.thumbhash).toEqual(Buffer.from([1, 255]));
    expect(attach.wave).toEqual(Buffer.from([1, 255])); expect(attach.empty).toEqual(Buffer.alloc(0));
    expect(attach.json).toEqual({ '0': 1, '1': 2 }); expect(Buffer.isBuffer(attach.json)).toBe(false);
  });
  it('deduplicates updates and refuses to rebind another MAX account', () => {
    const db = open(); db.bindAccount('1'); db.bindAccount('1');
    expect(() => db.bindAccount('2')).toThrow('другому аккаунту');
    const a = db.enqueue('u:1', '55', { text: 'first' });
    expect(db.enqueue('u:1', '55', { text: 'other' }).id).toBe(a.id);
    expect(db.job(a.id)?.payload).toEqual({ text: 'first' });
  });
  it('prevents two active processes from recovering/sending from the same database', () => {
    const file = tempFile(); const first = open(file);
    expect(() => new BridgeDatabase(file)).toThrow('другим экземпляром');
    first.close(); expect(open(file).pending()).toEqual([]);
  });
  it('recovers committed WAL state after an actual child process exits without cleanup', () => {
    const file = tempFile();
    const module = new URL('../src/store/bridgeDatabase.ts', import.meta.url).href;
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { BridgeDatabase } from ${JSON.stringify(module)};
      const d = new BridgeDatabase(${JSON.stringify(file)});
      const j=d.enqueue('u:crash','55',{id:123456789012345678n});
      d.markJob(j.id,'running');const e=d.prepareEffect(j.id,0,'sendMessage',['55','hello'],true);
      d.markEffect(e.key,'running');process.exit(0);
    `], { cwd: process.cwd(), stdio: 'pipe' });
    const db = open(file); const j = db.pending()[0]!;
    expect(j.payload).toEqual({ id: 123456789012345678n });
    expect(j.status).toBe('retry');
    expect(db.effect(`${j.id}:0`)?.status).toBe('uncertain');
  });
  it('does not let later tasks overtake a failed predecessor in the same chat', () => {
    const db = open(); const a = db.enqueue('1', 'chatA', {}); db.markJob(a.id, 'failed');
    db.enqueue('2', 'chatA', {}); const b = db.enqueue('3', 'chatB', {});
    expect(db.next()?.id).toBe(b.id);
  });
  it('never silently replaces a live binding with a different source message', () => {
    const db = open(); const links = new MessageLinkStore(1, db);
    links.add({ maxChatId: '55', maxMessageId: 1n, telegramMessageId: 10 });
    expect(() => links.add({ maxChatId: '56', maxMessageId: 2n, telegramMessageId: 10 })).toThrow('Конфликт');
    expect(new MessageLinkStore(1, db).getByTelegram(10)?.maxChatId).toBe('55');
    expect(db.findLink('max', '56', 2n)).toBeUndefined();
  });
  it('recovers despite a stale owner record using the current PID, as after container PID reuse', () => {
    const file = tempFile(); const initial = open(file); initial.close();
    const raw = new DatabaseSync(file);
    raw.prepare("INSERT INTO metadata(key,value) VALUES('process',?)").run(JSON.stringify({ pid: process.pid, token: 'previous-container' }));
    raw.close();
    const recovered = open(file); expect(recovered.enqueue('after-restart', '55', {}).status).toBe('pending');
  });
  it('keeps queue ordering after a pending dialog acquires its real MAX id', () => {
    const db = open(); const first = db.enqueue('1', 'pending:99', {});
    db.markJob(first.id, 'uncertain', undefined, Date.now() + 60_000);
    db.rebindQueuedChat('pending:99', '55');
    expect(db.enqueue('2', 'pending:99', {}).chat).toBe('55'); db.enqueue('3', '55', {});
    expect(db.next()).toBeUndefined();
    expect(db.pending().every(j => j.chat === '55')).toBe(true);
  });
});
