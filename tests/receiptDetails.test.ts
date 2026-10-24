import { describe, expect, it } from 'vitest';
import { participantReadMarks, messageReceiptText } from '../src/bridge/receiptDetails.js';
describe('message-specific MAX read evidence', () => {
  it('accepts only actual peer timestamp values, never participant objects or the owner', () => {
    expect(participantReadMarks({ participants: { 1: 1700000000000n, 2: '1700000001000', 3: {}, 4: 0, bad: 1700000000000 } }, 1)).toEqual([{ userId: '2', mark: 1700000001000 }]);
  });
  it('does not equate reading a voice message with having listened to it', async () => {
    const text = await messageReceiptText({ id: 99n, sender: 1, time: 1700000000000, attaches: [{ _type: 'AUDIO' }] }, [{ userId: '2', mark: 1700000001000 }], 1, async () => 'Contact');
    expect(text).toContain('сообщение прочитано'); expect(text).toContain('Прочтение не доказывает воспроизведение'); expect(text).not.toContain('прослушано');
  });
  it('describes absent or earlier read evidence without claiming that the recipient has not read it', async () => {
    const text = await messageReceiptText({ id: 99n, sender: 1, time: 1700000000000 }, [{ userId: '2', mark: 1699999999999 }], 1, async () => 'Contact');
    expect(text).toContain('подтверждения прочтения этого сообщения нет'); expect(text).not.toContain('не прочитано');
  });
});
