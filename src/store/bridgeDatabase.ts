import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// Explicit tags for EVERY value avoid collisions with user-supplied JSON and preserve BigInt ids.
function encode(v: unknown): unknown {
  if (v === undefined) return ['u'];
  if (v === null) return ['z'];
  if (typeof v === 'bigint') return ['i', String(v)];
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return [typeof v, v];
  if (Array.isArray(v)) return ['a', v.map(encode)];
  if (v instanceof Uint8Array) return ['b', Buffer.from(v).toString('base64')];
  if (typeof v === 'object') return ['o', Object.entries(v).map(([k, x]) => [k, encode(x)])];
  throw new Error('Unsupported persistent value');
}
function decode(v: unknown): unknown {
  const [tag, data] = v as [string, unknown];
  switch (tag) {
    case 'u': return undefined;
    case 'z': return null;
    case 'i': return BigInt(data as string);
    case 'b': return Buffer.from(data as string, 'base64');
    case 'a': return (data as unknown[]).map(decode);
    case 'o': return Object.fromEntries((data as Array<[string, unknown]>).map(([k, x]) => [k, decode(x)]));
    case 'string': case 'number': case 'boolean': return data;
    default: throw new Error('Invalid persistent value');
  }
}
export const encodePersistent = (v: unknown): string => JSON.stringify(encode(v));
export const decodePersistent = <T>(v: string): T => decode(JSON.parse(v)) as T;

export type JobStatus = 'pending' | 'running' | 'retry' | 'uncertain' | 'failed' | 'done';
export interface DeliveryJob {
  id: number; key: string; chat: string; payload: unknown; status: JobStatus;
  attempts: number; nextAt: number; error?: string;
}
export interface EffectRecord {
  key: string; jobId: number; method: string; args: unknown[];
  status: 'prepared' | 'running' | 'done' | 'uncertain';
  cid?: number; result?: unknown; createdAt: number;
}
interface Row { [key: string]: string | number | bigint | null | Uint8Array }

/** One database per Telegram destination. No automatic retention limit or loss of old bindings. */
export class BridgeDatabase {
  private readonly db: DatabaseSync;
  private readonly ownerLock: DatabaseSync;
  private closed = false;
  constructor(readonly file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 1) { this.db.close(); throw new Error(`База bridge.sqlite имеет более новую версию ${version}; откат без миграции запрещён.`); }
    // Hold an OS-backed SQLite file lock for the process lifetime. PID checks are unsafe:
    // a restarted container commonly reuses PID 1 and would mistake itself for its predecessor.
    this.ownerLock = new DatabaseSync(file === ':memory:' ? ':memory:' : `${file}.lock`);
    if (file !== ':memory:') chmodSync(`${file}.lock`, 0o600);
    try {
      this.ownerLock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS guard (id INTEGER); BEGIN EXCLUSIVE;');
    } catch (cause) {
      this.ownerLock.close(); this.db.close();
      throw new Error('Эта база уже открыта другим экземпляром Telemax либо недоступен файл блокировки; параллельная отправка запрещена.', { cause });
    }
    try {
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,key));
      CREATE TABLE IF NOT EXISTS links (key TEXT PRIMARY KEY, chat TEXT NOT NULL, value TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, outgoing INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (kind TEXT NOT NULL, chat TEXT NOT NULL, id TEXT NOT NULL, link_key TEXT NOT NULL REFERENCES links(key), PRIMARY KEY(kind,chat,id));
      CREATE INDEX IF NOT EXISTS links_chat ON links(chat,active,created);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, chat TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status,next_at,id);
      CREATE TABLE IF NOT EXISTS effects (key TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), method TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL, cid INTEGER, result TEXT, created INTEGER NOT NULL);
      PRAGMA user_version=1;`);
    // An interrupted network write has an unknown outcome, not a licence to send it again.
    this.recoverInterrupted();
    } catch (error) { this.db.close(); this.ownerLock.close(); throw error; }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const v = fn(); this.db.exec('COMMIT'); return v; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.ownerLock.close();
    this.closed = true;
  }
  bindAccount(id: string): void {
    const prior = this.get<string>('meta', 'maxAccount');
    if (prior && prior !== id) throw new Error('Эти данные принадлежат другому аккаунту MAX. Используйте отдельный каталог данных; автоматическая перепривязка запрещена.');
    this.set('meta', 'maxAccount', id);
  }
  get<T>(kind: string, key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM objects WHERE kind=? AND key=?').get(kind, key);
    return r ? decodePersistent<T>(String(r.value)) : undefined;
  }
  set(kind: string, key: string, value: unknown): void {
    this.db.prepare('INSERT INTO objects(kind,key,value) VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value').run(kind, key, encodePersistent(value));
  }
  values<T>(kind: string): T[] { return this.db.prepare('SELECT value FROM objects WHERE kind=?').all(kind).map(r => decodePersistent<T>(String(r.value))); }
  clearKind(kind: string): void { this.db.prepare('DELETE FROM objects WHERE kind=?').run(kind); }
  delete(kind: string, key: string): void { this.db.prepare('DELETE FROM objects WHERE kind=? AND key=?').run(kind, key); }
  putLink(key: string, chat: string, value: unknown, maxIds: unknown[], tgIds: number[], outgoing: boolean, created: number): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO links(key,chat,value,active,outgoing,created) VALUES(?,?,?,1,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,active=1,outgoing=excluded.outgoing').run(key, chat, encodePersistent(value), Number(outgoing), created);
      this.db.prepare('DELETE FROM aliases WHERE link_key=?').run(key);
      const insert = this.db.prepare('INSERT INTO aliases(kind,chat,id,link_key) VALUES(?,?,?,?) ON CONFLICT(kind,chat,id) DO UPDATE SET link_key=excluded.link_key');
      const bind = (kind: string, destination: string, id: unknown) => {
        const existing = this.db.prepare('SELECT a.link_key FROM aliases a JOIN links l ON l.key=a.link_key WHERE a.kind=? AND a.chat=? AND a.id=? AND l.active=1').get(kind, destination, String(id));
        if (existing && existing.link_key !== key) throw new Error('Конфликт привязок сообщений: существующая связь сохранена, автоматическая подмена запрещена.');
        insert.run(kind, destination, String(id), key);
      };
      for (const id of maxIds) bind('max', chat, id);
      for (const id of tgIds) bind('tg', '', id);
    });
  }
  findLink<T>(kind: 'max' | 'tg', chat: string, id: unknown): T | undefined {
    const r = this.db.prepare('SELECT l.value FROM aliases a JOIN links l ON l.key=a.link_key WHERE a.kind=? AND a.chat=? AND a.id=? AND l.active=1').get(kind, chat, String(id));
    return r ? decodePersistent<T>(String(r.value)) : undefined;
  }
  links<T>(chat?: string, outgoing?: boolean, limit = 0): T[] {
    const rows = this.db.prepare(`SELECT value FROM links WHERE active=1 AND (? IS NULL OR chat=?) AND (? IS NULL OR outgoing=?) ORDER BY created DESC,rowid DESC ${limit > 0 ? 'LIMIT '+Math.floor(limit) : ''}`).all(chat ?? null, chat ?? null, outgoing == null ? null : Number(outgoing), outgoing == null ? null : Number(outgoing));
    return rows.map(r => decodePersistent<T>(String(r.value)));
  }
  retireLink(key: string): void { this.db.prepare('UPDATE links SET active=0 WHERE key=?').run(key); }
  retireChat(chat: string): void { this.db.prepare('UPDATE links SET active=0 WHERE chat=?').run(chat); }
  retireAllLinks(): void { this.db.exec('UPDATE links SET active=0'); }
  enqueue(key: string, chat: string, payload: unknown): DeliveryJob {
    for (let i = 0; i < 10; i++) {
      const resolved = this.get<string>('queueChatAlias', chat);
      if (!resolved || resolved === chat) break;
      chat = resolved;
    }
    const prior = this.db.prepare('SELECT id FROM jobs WHERE key=?').get(key);
    if (prior) return this.job(Number(prior.id))!;
    this.db.prepare("INSERT OR IGNORE INTO jobs(key,chat,payload,status,created) VALUES(?,?,?,'pending',?)").run(key, chat, encodePersistent(payload), Date.now());
    return this.job(Number(this.db.prepare('SELECT id FROM jobs WHERE key=?').get(key)!.id))!;
  }
  private parseJob(r: Row): DeliveryJob {
    return { id: Number(r.id), key: String(r.key), chat: String(r.chat), payload: decodePersistent(String(r.payload)), status: r.status as JobStatus, attempts: Number(r.attempts), nextAt: Number(r.next_at), error: r.error == null ? undefined : String(r.error) };
  }
  job(id: number): DeliveryJob | undefined { const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); return r ? this.parseJob(r) : undefined; }
  hasJob(key: string): boolean { return Boolean(this.db.prepare('SELECT id FROM jobs WHERE key=?').get(key)); }
  updateJobPayload(id: number, payload: unknown): void { this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(encodePersistent(payload), id); }
  rebindQueuedChat(previous: string, actual: string): void {
    if (previous === actual) return;
    this.transaction(() => {
      this.set('queueChatAlias', previous, actual);
      this.db.prepare('UPDATE jobs SET chat=? WHERE chat=?').run(actual, previous);
    });
  }
  recoverInterrupted(): void {
    this.transaction(() => this.db.exec("UPDATE effects SET status='uncertain' WHERE status='running'; UPDATE jobs SET status='retry',next_at=0 WHERE status='running';"));
  }
  pending(limit = 30): DeliveryJob[] { return this.db.prepare("SELECT * FROM jobs WHERE status!='done' ORDER BY id LIMIT ?").all(limit).map(r => this.parseJob(r)); }
  next(now = Date.now()): DeliveryJob | undefined {
    const r = this.db.prepare(`SELECT j.* FROM jobs j WHERE j.status IN ('pending','retry','uncertain') AND j.next_at<=? AND NOT EXISTS(SELECT 1 FROM jobs p WHERE p.chat=j.chat AND p.id<j.id AND p.status!='done') ORDER BY j.id LIMIT 1`).get(now);
    return r ? this.parseJob(r) : undefined;
  }
  markJob(id: number, status: JobStatus, error?: string, nextAt = 0): void {
    this.db.prepare("UPDATE jobs SET status=?,error=?,next_at=?,attempts=attempts+CASE WHEN ?='running' THEN 1 ELSE 0 END WHERE id=?").run(status, error?.slice(0, 500) ?? null, nextAt, status, id);
  }
  retryJob(id: number): boolean {
    return Number(this.db.prepare("UPDATE jobs SET status='retry',next_at=0,error=NULL WHERE id=? AND status IN ('failed','retry','uncertain')").run(id).changes) > 0;
  }
  cancelPending(): void { this.db.exec("UPDATE jobs SET status='done',error='cancelled by owner' WHERE status!='done'"); }
  nextCid(): number {
    const cid = Math.max(Date.now(), (this.get<number>('meta', 'lastCid') ?? 0) + 1);
    this.set('meta', 'lastCid', cid);
    return cid;
  }
  prepareEffect(jobId: number, index: number, method: string, args: unknown[], needsCid: boolean): EffectRecord {
    const key = `${jobId}:${index}`;
    const found = this.effect(key);
    if (found) {
      if (found.method !== method) throw new Error('Изменился порядок действий сохранённого задания; нужна проверка очереди.');
      return found;
    }
    return this.transaction(() => {
      const cid = needsCid ? this.nextCid() : undefined;
      this.db.prepare("INSERT INTO effects(key,job_id,method,args,status,cid,created) VALUES(?,?,?,?,'prepared',?,?)").run(key, jobId, method, encodePersistent(args), cid ?? null, Date.now());
      return this.effect(key)!;
    });
  }
  effect(key: string): EffectRecord | undefined {
    const r = this.db.prepare('SELECT * FROM effects WHERE key=?').get(key);
    return r ? { key, jobId: Number(r.job_id), method: String(r.method), args: decodePersistent<unknown[]>(String(r.args)), status: r.status as EffectRecord['status'], cid: r.cid == null ? undefined : Number(r.cid), result: r.result == null ? undefined : decodePersistent(String(r.result)), createdAt: Number(r.created) } : undefined;
  }
  markEffect(key: string, status: EffectRecord['status'], result?: unknown): void {
    this.db.prepare('UPDATE effects SET status=?,result=? WHERE key=?').run(status, result === undefined ? null : encodePersistent(result), key);
  }
  confirmSend(cid: number, chatId: unknown, text: string | undefined, result: unknown): void {
    const row = this.db.prepare("SELECT key FROM effects WHERE cid=? AND method='sendMessage' AND status IN ('running','uncertain')").get(cid);
    if (!row) return;
    const e = this.effect(String(row.key))!;
    if (String(e.args[0]) === String(chatId) && (e.args[1] ?? '') === (text ?? '')) this.markEffect(e.key, 'done', result);
  }
  hasPendingCid(cid: unknown): boolean {
    if (cid == null || !Number.isSafeInteger(Number(cid))) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM effects e JOIN jobs j ON j.id=e.job_id WHERE e.cid=? AND e.status IN ('running','uncertain','done') AND j.status!='done' LIMIT 1").get(Number(cid)));
  }
}
