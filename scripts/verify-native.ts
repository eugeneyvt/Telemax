/** Explicit acceptance against the owner's Saved Messages and an optionally created, owner-only test group.
 * Stop the production bridge and make a consistent backup first. Never run two clients against its state.
 * Run the bundled script with TELEMAX_ACCEPTANCE=owner-test and ALLOW_CREATE_TEST_GROUP=1.
 * The current session is resumed and its rotated token is saved encrypted, without printing it.
 */
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MaxClient } from '../src/max/client.js';
import { SessionStore } from '../src/store/sessionStore.js';
import { extractMyAccountId } from '../src/max/names.js';
import { DIR } from '../src/max/opcodes.js';

if (process.env.TELEMAX_ACCEPTANCE !== 'owner-test') throw new Error('Explicit owner-only acceptance mode is required.');
process.umask(0o077);
process.env.LOG_LEVEL = 'error';
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: {} };
const checks = report.checks as Record<string, unknown>;
const output = path.join(process.cwd(), '.data', 'acceptance-native.json');
const store = new SessionStore();
const session = await store.load();
if (!session) throw new Error('An existing encrypted session is required.');
const client = new MaxClient({ host: process.env.MAX_HOST || undefined, sni: process.env.MAX_SNI || undefined, reconnect: false });
client.on('error', () => {});
const watchdog = setTimeout(() => { client.disconnect(); process.exitCode = 1; }, 180_000);
let stage = 'connect';
client.on('message', event => {
  if (stage === 'native-forward' && event.dir === DIR.ERR) report.forwardValidation = event.payload;
});
function assert(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
try {
  const ready = once(client, 'ready'); client.connect(); await ready;
  stage = 'resume';
  const login = await client.login(session.sessionToken);
  await store.save({ ...session, deviceId: client.deviceId, sessionToken: login.sessionToken, savedAt: new Date().toISOString() });
  const self = extractMyAccountId(login.payload); assert(self != null, 'missing-own-id');
  checks.resume = true;
  stage = 'devices'; const devices = await client.getDeviceSessions(); checks.devices = { count: devices.length };
  stage = 'folders-read'; const folders = await client.getFolders(); checks.foldersRead = { count: folders.length };
  stage = 'profile-read'; const own = (await client.getContactInfo([self]))[0]; checks.profileRead = { found: Boolean(own), structuredName: Boolean(own?.names?.some(n => n.firstName)) };
  stage = 'saved-verify'; assert((await client.chatsInfo([0])).some(c => String((c as { id?: unknown }).id) === '0'), 'saved-not-verified');
  let priorReport: { testGroupId?: string; scheduledTestMessageId?: string; checks?: { cancelSchedule?: boolean } } = {};
  try { priorReport = JSON.parse(await readFile(output, 'utf8')); } catch { /* first run */ }
  if (priorReport.testGroupId) report.testGroupId = priorReport.testGroupId;
  if (priorReport.scheduledTestMessageId) report.scheduledTestMessageId = priorReport.scheduledTestMessageId;
  if (priorReport.scheduledTestMessageId && priorReport.checks?.cancelSchedule !== true) {
    stage = 'cleanup-prior-schedule'; await client.deleteMessages(0, [BigInt(priorReport.scheduledTestMessageId)], false, 'DELAYED');
    checks.cancelSchedule = true;
  }
  let testGroupId: unknown;
  if (process.env.ALLOW_CREATE_TEST_GROUP === '1') {
    stage = 'test-group-create';
    const group = priorReport.testGroupId ? { chatId: priorReport.testGroupId } : await client.createGroup('Telemax · проверка моста', []);
    report.testGroupId = String(group.chatId);
    const chat = (await client.chatsInfo([group.chatId]))[0] as { participants?: Record<string, unknown>; participantsCount?: number } | undefined;
    const members = chat?.participants && Object.keys(chat.participants);
    assert(chat != null && members && members.length === 1 && members.every(id => String(id) === String(self)) && Number(chat.participantsCount ?? 1) <= 1, 'test-group-not-owner-only');
    testGroupId = group.chatId;
  }
  const test = `Telemax: проверка дополнительных функций ${new Date().toISOString()}`;
  const sourceChat = testGroupId ?? 0;
  stage = 'quiet-send'; const sent = await client.sendMessage(sourceChat, test, [], undefined, { notify: false });
  assert((await client.getMessages(sourceChat, [sent.messageId]))[0]?.text === test, 'quiet-send-readback'); checks.quietSend = true;
  stage = 'native-forward'; const forward = await client.forwardMessage(0, sourceChat, sent.messageId);
  const readForward = (await client.getMessages(0, [forward.messageId]))[0];
  assert((readForward?.link as { type?: string })?.type === 'FORWARD', 'native-forward-link'); checks.nativeForward = true;
  stage = 'schedule'; const delayed = await client.sendMessage(0, 'Telemax: отложенная проверка, подлежит отмене', [], undefined, { sendAt: Date.now() + 3_600_000, notify: false });
  checks.cancelSchedule = false;
  report.scheduledTestMessageId = String(delayed.messageId);
  const pending = await client.getChatHistory(0, Date.now() + 86_400_000, 100, 'DELAYED');
  assert(pending.some(m => String(m.id) === String(delayed.messageId)), 'scheduled-history-readback'); checks.schedule = true;
  stage = 'cancel-schedule'; await client.deleteMessages(0, [delayed.messageId], false, 'DELAYED');
  const after = await client.getChatHistory(0, Date.now() + 86_400_000, 100, 'DELAYED');
  assert(!after.some(m => String(m.id) === String(delayed.messageId)), 'scheduled-cancel-readback'); checks.cancelSchedule = true;
  stage = 'folder-create'; const id = randomUUID(); report.testFolderId = id;
  await client.saveFolder({ id, title: 'Telemax · проверка', include: [0], filters: [], options: [] });
  assert((await client.getFolders()).some(f => f.id === id), 'folder-create-readback');
  stage = 'folder-update'; await client.saveFolder({ id, title: 'Telemax · проверено', include: [], filters: [], options: [] });
  assert((await client.getFolders()).find(f => f.id === id)?.title === 'Telemax · проверено', 'folder-update-readback');
  stage = 'folder-delete'; await client.deleteFolder(id); assert(!(await client.getFolders()).some(f => f.id === id), 'folder-delete-readback'); checks.folderLifecycle = true;
  if (testGroupId != null) {
    stage = 'pin-test'; const pin = await client.sendMessage(testGroupId, 'Telemax: проверка закрепления, только собственный аккаунт.', [], undefined, { notify: false });
    await client.pinMessage(testGroupId, pin.messageId);
    const pinned = (await client.chatsInfo([testGroupId]))[0] as { pinnedMessageId?: unknown; pinnedMessage?: { id?: unknown } };
    assert(String(pinned.pinnedMessageId ?? pinned.pinnedMessage?.id) === String(pin.messageId), 'pin-readback'); checks.pin = true;
    stage = 'unpin-test'; await client.pinMessage(testGroupId, null);
    const unpinned = (await client.chatsInfo([testGroupId]))[0] as { pinnedMessageId?: unknown; pinnedMessage?: { id?: unknown } };
    const pinnedId = unpinned.pinnedMessageId ?? unpinned.pinnedMessage?.id;
    assert(pinnedId == null || String(pinnedId) === '0', 'unpin-readback'); checks.unpin = true;
  }
  report.ok = true;
} catch (error) {
  report.ok = false; report.failedStage = stage;
  report.error = { name: (error as Error).name, serverCode: (error as { serverCode?: string }).serverCode ?? null,
    ...(!['connect', 'resume'].includes(stage) ? { explanation: (error as Error).message.slice(0, 200) } : {}) };
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog); client.disconnect();
  report.finishedAt = new Date().toISOString();
  const json = JSON.stringify(report, (_, value) => typeof value === 'bigint' ? String(value) : value, 2);
  await writeFile(output, json, { mode: 0o600 });
  console.log(json);
}
