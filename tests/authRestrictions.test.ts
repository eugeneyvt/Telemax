import { describe, expect, it } from 'vitest';
import { MaxClient } from '../src/max/client.js';
import { DIR } from '../src/max/opcodes.js';
import { MaxPasswordSetupRequiredError, requiresPasswordSetup } from '../src/max/authErrors.js';

class AuthReplyClient extends MaxClient {
  constructor(private readonly response: unknown, private readonly direction: number = DIR.ERR) { super({ reconnect: false }); }
  override send(opcode: number): void {
    queueMicrotask(() => this.emit('message', { dir: this.direction, opcode, payload: this.response }));
  }
}
describe('new-device password setup restriction', () => {
  it('recognizes the observed MAX refusal without confusing it with a bad SMS code', () => {
    expect(requiresPasswordSetup({ localizedMessage: 'Логин ограничен. Требуется установить 2FA' })).toBe(true);
    expect(requiresPasswordSetup({ error: 'login.restricted.2fa.required' })).toBe(true);
    expect(requiresPasswordSetup({ localizedMessage: 'Неверный код подтверждения' })).toBe(false);
    expect(requiresPasswordSetup({ error: 'password2fa.wrong' })).toBe(false);
  });
  it('returns a distinct prerequisite error for CHECK_CODE', async () => {
    const client = new AuthReplyClient({ localizedMessage: 'Логин ограничен. Требуется установить 2FA' });
    await expect(client.verifyCode('local-token', '000000')).rejects.toBeInstanceOf(MaxPasswordSetupRequiredError);
  });
  it('continues the existing-password challenge as before', async () => {
    const client = new AuthReplyClient({ passwordChallenge: { trackId: 'local-track', hint: 'local hint' } }, DIR.OK);
    await expect(client.verifyCode('local-token', '000000')).resolves.toEqual({ status: 'password_required', challenge: { trackId: 'local-track', hint: 'local hint' } });
  });
  it('leaves an ordinary wrong-code response retryable by the auth flow', async () => {
    const client = new AuthReplyClient({ localizedMessage: 'Неверный код подтверждения' });
    await expect(client.verifyCode('local-token', '000000')).rejects.toThrow('Неверный код');
  });
});
