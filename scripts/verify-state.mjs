/** Offline restore check. Run with the restored .env and restored data mounted read-only at /restore. */
import { readFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
const encoded = JSON.parse(readFileSync('/restore/max.session.json', 'utf8'));
const key = Buffer.from(process.env.MAX_SESSION_KEY ?? '', 'hex');
if (key.length !== 32) throw new Error('Restored encryption key is invalid');
const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encoded.iv, 'base64'));
decipher.setAuthTag(Buffer.from(encoded.authTag, 'base64'));
const session = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encoded.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
if (!session.sessionToken || !session.deviceId) throw new Error('Restored session is incomplete');
console.log(JSON.stringify({ encryptedSessionDecrypts: true, offline: true }));
