import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
interface Sealed { v: 1; iv: string; tag: string; data: string }
function key(): Buffer {
  const value = process.env.MAX_SESSION_KEY ?? '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('A valid existing session encryption key is required');
  return Buffer.from(value, 'hex');
}
const context = (botId: number, chat: string) => Buffer.from(`telemax-dedicated-v1:${botId}:${chat}`);
export function sealDedicatedToken(token: string, botId: number, chat: string): Sealed {
  if (!new RegExp(`^${botId}:[A-Za-z0-9_-]+$`).test(token)) throw new Error('Managed bot token identity mismatch');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(context(botId, chat));
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]).toString('base64');
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data };
}
export function openDedicatedToken(value: Sealed, botId: number, chat: string): string {
  if (value.v !== 1) throw new Error('Unsupported managed token version');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(value.iv, 'base64'));
  decipher.setAAD(context(botId, chat)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
}
