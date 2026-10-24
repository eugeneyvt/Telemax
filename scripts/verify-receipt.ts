/** Explicit, read-only MAX receipt probe. Stop the sole production bridge first.
 * Set TELEMAX_ACCEPTANCE=owner-read-only and RECEIPT_MAX_CHAT_ID to an owner-selected chat.
 * No messages are sent, marked read, played or downloaded. Only anonymous boolean evidence is printed.
 */
import { once } from 'node:events';
import { MaxClient } from '../src/max/client.js';
import { SessionStore } from '../src/store/sessionStore.js';
import { extractMyAccountId } from '../src/max/names.js';
import { participantReadMarks } from '../src/bridge/receiptDetails.js';
if (process.env.TELEMAX_ACCEPTANCE !== 'owner-read-only' || !/^-?\d+$/.test(process.env.RECEIPT_MAX_CHAT_ID ?? '')) throw new Error('Explicit owner-selected read-only probe required');
process.env.LOG_LEVEL = 'error'; process.umask(0o077);
const client = new MaxClient({ reconnect: false, host: process.env.MAX_HOST || undefined, sni: process.env.MAX_SNI || undefined });
client.on('error', () => {});
const store = new SessionStore(); const session = await store.load(); if (!session) throw new Error('Missing existing session');
try {
  const ready = once(client, 'ready'); client.connect(); await ready;
  const login = await client.login(session.sessionToken); await store.save({ ...session, deviceId: client.deviceId, sessionToken: login.sessionToken, savedAt: new Date().toISOString() });
  const own = extractMyAccountId(login.payload); const id = process.env.RECEIPT_MAX_CHAT_ID!;
  const chat = (await client.chatsInfo([id]))[0]; const marks = participantReadMarks(chat, own);
  const messages = await client.getChatHistory(id, Date.now() + 900000, 100);
  const voice = messages.filter(m => String(m.sender) === String(own) && (m.attaches as Array<{ _type?: string }> | undefined)?.some(a => a._type === 'AUDIO' || a._type === 'VOICE')).sort((a, b) => Number(b.time) - Number(a.time))[0];
  console.log(JSON.stringify({ peerReadBoundaryAvailable: marks.length > 0, ownVoiceFound: Boolean(voice), latestOwnVoiceReadByPeer: voice ? marks.some(p => p.mark >= Number(voice.time)) : null, separatePlaybackEvidence: false }));
} finally { client.disconnect(); }
