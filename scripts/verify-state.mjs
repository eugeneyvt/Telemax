/** Offline restore check. Run with the restored .env and restored data mounted read-only at /restore. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDecipheriv } from 'node:crypto';
const encoded = JSON.parse(readFileSync('/restore/max.session.json', 'utf8'));
const key = Buffer.from(process.env.MAX_SESSION_KEY ?? '', 'hex');
if (key.length !== 32) throw new Error('Restored encryption key is invalid');
const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encoded.iv, 'base64'));
decipher.setAuthTag(Buffer.from(encoded.authTag, 'base64'));
const session = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encoded.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
if (!session.sessionToken || !session.deviceId) throw new Error('Restored session is incomplete');
let dedicatedTokens = 0;
const decode = ([tag, value]) => tag === 'o' ? Object.fromEntries(value.map(([k, v]) => [k, decode(v)])) : tag === 'a' ? value.map(decode) : ['u', 'z'].includes(tag) ? undefined : value;
function verifyDatabases(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { verifyDatabases(file); continue; }
    if (!entry.isFile() || !readFileSync(file).subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='objects'").get()) continue;
      const records = db.prepare("SELECT value FROM objects WHERE kind='dedicatedBots'").all().map(r => decode(JSON.parse(r.value)));
      for (const row of db.prepare("SELECT key,value FROM objects WHERE kind='dedicatedTokens'").all()) {
        const record = records.find(r => String(r.botId) === row.key); if (!record) throw new Error('Restored dedicated token has no binding');
        const sealed = decode(JSON.parse(row.value));
        const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
        cipher.setAAD(Buffer.from(`telemax-dedicated-v1:${record.botId}:${record.maxChatId}`)); cipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        const token = Buffer.concat([cipher.update(Buffer.from(sealed.data, 'base64')), cipher.final()]).toString('utf8');
        if (!token.startsWith(`${record.botId}:`)) throw new Error('Restored dedicated bot identity mismatch'); dedicatedTokens++;
      }
    } finally { db.close(); }
  }
}
if (process.env.RESTORED_SQLITE_ROOT) verifyDatabases(process.env.RESTORED_SQLITE_ROOT);
console.log(JSON.stringify({ encryptedSessionDecrypts: true, dedicatedTokens, offline: true }));
