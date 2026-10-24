import { afterEach, describe, expect, it, vi } from 'vitest';
import { MaxClient, MaxServerError, MaxRequestOutcomeUnknownError } from '../src/max/client.js';
import { OPCODES, DIR } from '../src/max/opcodes.js';
import { parseSchedule, isDurableCommand, commandRichText } from '../src/bridge/nativeTools.js';
import { BridgeDatabase } from '../src/store/bridgeDatabase.js';
import { DeliveryQueue, journalMaxActions } from '../src/bridge/deliveryQueue.js';
import { ReactionStore } from '../src/bridge/reactionStore.js';

class ScriptedClient extends MaxClient {
  calls: Array<{ opcode: number; payload: any }> = [];
  response: any = { message: { id: 99n, attaches: [], time: 123 } };
  responseDir: number = DIR.OK;
  override send(opcode: number, payload: unknown): void {
    this.calls.push({ opcode, payload });
    queueMicrotask(() => this.emit('message', { opcode, payload: this.response, dir: this.responseDir, seq: 0 }));
  }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('native MAX expansion protocol', () => {
  it('passes native scheduling and quiet flags without changing message identity', async () => {
    const max = new ScriptedClient();
    const at = Date.now() + 60000;
    await max.sendMessage('55', 'later', [], undefined, { cid: 123, sendAt: at, notify: false });
    expect(max.calls[0]).toEqual({ opcode: OPCODES.MSG_SEND, payload: { chatId: 55n, message: { cid: 123n, text: 'later', attaches: [], elements: [], link: null, delayedAttributes: { timeToFire: BigInt(at), notifySender: false } }, notify: false } });
  });
  it('rejects an expired native schedule before any network request', async () => {
    const max = new ScriptedClient();
    await expect(max.sendMessage('55', 'old', [], undefined, { sendAt: Date.now() - 1 })).rejects.toThrow('будущем');
    expect(max.calls).toHaveLength(0);
  });
  it('forwards both original message and source chat as native int64 values', async () => {
    const max = new ScriptedClient();
    await max.forwardMessage('66', '55', 9007199254740993n, undefined, { cid: -123 });
    expect(max.calls[0]).toEqual({ opcode: OPCODES.MSG_SEND, payload: { chatId: 66n, message: { cid: -123n, link: { type: 'FORWARD', messageId: 9007199254740993n, chatId: 55n }, attaches: [] }, notify: true } });
  });
  it('does not claim a forward succeeded without a MAX message id', async () => {
    const max = new ScriptedClient(); max.response = {};
    await expect(max.forwardMessage('66', '55', 99n)).rejects.toThrow('unknown');
  });
  it('sends replacement media through MSG_EDIT attachments', async () => {
    const max = new ScriptedClient();
    await max.editMessage('55', 99n, 'caption', [], [{ _type: 'PHOTO', photoToken: 'fixture' }]);
    expect(max.calls[0]!.payload.attachments).toEqual([{ _type: 'PHOTO', photoToken: 'fixture' }]);
  });
  it('preserves untouched folder filters and chat ids in updates', async () => {
    const max = new ScriptedClient();
    await max.saveFolder({ id: 'folder', title: 'Work', include: ['9007199254740993', -55], filters: ['UNREAD'], options: ['KEEP'] });
    expect(max.calls[0]).toEqual({ opcode: OPCODES.FOLDERS_UPDATE, payload: { id: 'folder', title: 'Work', include: [9007199254740993n, -55n], filters: ['UNREAD'], options: ['KEEP'] } });
  });
  it('rejects unknown folder and session response shapes', async () => {
    const max = new ScriptedClient(); max.response = {};
    await expect(max.getFolders()).rejects.toThrow('формат');
    await expect(max.getDeviceSessions()).rejects.toThrow('формат');
    await expect(max.closeOtherSessions()).rejects.toThrow('токен');
  });
  it('does not turn server errors into empty lists', async () => {
    const max = new ScriptedClient(); max.responseDir = DIR.ERR; max.response = { error: 'not.allowed' };
    await expect(max.getFolders()).rejects.toBeInstanceOf(MaxServerError);
  });
  it('changes the profile using the native avatar enum and no plaintext auth data', async () => {
    const max = new ScriptedClient(); await max.changeProfile({ firstName: 'Alex', lastName: '', description: 'Fixture' });
    expect(max.calls[0]).toEqual({ opcode: OPCODES.PROFILE, payload: { firstName: 'Alex', lastName: '', description: 'Fixture', avatarType: 'USER_AVATAR' } });
  });
  it('cancels scheduled messages in the DELAYED namespace and requires their ids in the ACK', async () => {
    const max = new ScriptedClient(); max.response = { messageIds: [99n] };
    await max.deleteMessages('55', [99n], false, 'DELAYED');
    expect(max.calls[0]).toEqual({ opcode: OPCODES.MSG_DELETE, payload: { chatId: 55n, messageIds: [99n], forMe: false, itemType: 'DELAYED' } });
    max.response = { messageIds: [] };
    await expect(max.deleteMessages('55', [99n], false, 'DELAYED')).rejects.toThrow('не подтвердил');
  });
});

describe('command planning and persistence', () => {
  it('keeps UTF-16 formatting after removing command and scheduling prefixes', () => {
    expect(commandRichText({ text: '/silent  😀 bold ', entities: [{ type: 'bold', offset: 12, length: 4 }] })).toEqual({ text: '😀 bold', entities: [{ type: 'bold', offset: 3, length: 4 }] });
    expect(commandRichText({ text: '/schedule +30m bold', entities: [{ type: 'bold', offset: 15, length: 4 }] }, true)).toEqual({ text: 'bold', entities: [{ type: 'bold', offset: 0, length: 4 }] });
  });
  it('requires an explicit timezone for absolute schedules', () => {
    const now = Date.parse('2030-01-01T00:00Z');
    expect(parseSchedule('2030-01-01T18:00+03:00 hi', now)).toEqual({ at: Date.parse('2030-01-01T15:00Z'), text: 'hi' });
    expect(() => parseSchedule('2030-01-01T18:00 hi', now)).toThrow('поясом');
    expect(parseSchedule('+30m hi\nthere', now)).toEqual({ at: now + 1800000, text: 'hi\nthere' });
  });
  it('rejects past, zero-delay and unbounded schedules', () => {
    for (const input of ['+0m text', '+900d text', '2020-01-01T12:00Z text', 'tomorrow text']) expect(() => parseSchedule(input)).toThrow();
  });
  it('queues writes but keeps read-only commands out of the delivery queue', () => {
    for (const name of ['silent', 'schedule', 'unschedule', 'forward', 'folderadd', 'profile']) expect(isDurableCommand(`/${name}@bridge data`)).toBe(true);
    for (const name of ['folders', 'devices', 'scheduled', 'login', 'start']) expect(isDurableCommand(`/${name}`)).toBe(false);
  });
  it('restores reaction removal tracking and removes retired entries permanently', () => {
    const db = new BridgeDatabase(':memory:');
    const first = new ReactionStore(db); first.set('55:99', { chatId: 55n, messageId: 99n, emoji: '🔥' });
    const restored = new ReactionStore(db); expect(restored.get('55:99')!.messageId).toBe(99n);
    restored.delete('55:99'); expect(new ReactionStore(db).size).toBe(0);
    db.close();
  });
  it('does not resend a confirmed native forward after restarting its queue handler', async () => {
    const db = new BridgeDatabase(':memory:');
    const max = new ScriptedClient(); journalMaxActions(max, db);
    let fail = true;
    const queue = new DeliveryQueue(db, async () => { await max.forwardMessage('66', '55', 99n); if (fail) throw new Error('local failure after ACK'); }, () => true, async () => {});
    const job = db.enqueue('fixture', '66', {});
    queue.start(); await queue.drain(); queue.stop();
    expect(db.job(job.id)!.status).toBe('failed');
    const cid = max.calls[0]!.payload.message.cid; expect(cid).toBeLessThan(0n);
    fail = false; db.retryJob(job.id); queue.start(); await queue.drain(); queue.stop();
    expect(db.job(job.id)!.status).toBe('done'); expect(max.calls).toHaveLength(1);
    db.close();
  });
  it('reconciles a lost scheduling ACK against delayed history before regular history', async () => {
    const db = new BridgeDatabase(':memory:'); let cid = 0;
    const send = vi.fn(async (_chat: unknown, _text: unknown, _a: unknown, _r: unknown, options: { cid: number }) => { cid = options.cid; throw new MaxRequestOutcomeUnknownError(OPCODES.MSG_SEND); });
    const history = vi.fn(async (_chat: unknown, _from: unknown, _limit: unknown, type?: string) => type === 'DELAYED' ? [{ cid, id: 99n, time: 1 }] : []);
    const max = { sendMessage: send, getChatHistory: history } as unknown as MaxClient;
    journalMaxActions(max, db);
    const at = Date.now() + 3600000;
    const queue = new DeliveryQueue(db, async () => { await max.sendMessage('55', 'later', [], undefined, { sendAt: at }); }, () => true, async () => {});
    const job = db.enqueue('schedule-fixture', '55', {}); queue.start(); await queue.drain(); queue.stop();
    expect(db.job(job.id)!.status).toBe('uncertain');
    db.retryJob(job.id); queue.start(); await queue.drain(); queue.stop();
    expect(send).toHaveBeenCalledTimes(1); expect(history.mock.calls[0]?.[3]).toBe('DELAYED'); expect(db.job(job.id)!.status).toBe('done');
    db.close();
  });
});
