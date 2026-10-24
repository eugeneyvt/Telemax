import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'telegraf';
import { createMaxAuthFlow, MaxAuthUnavailableError } from '../src/bridge/maxAuthFlow.js';
import { MaxPasswordSetupRequiredError } from '../src/max/authErrors.js';

// A refusal about the connection state is shown alone and ends the flow (review 2026-09-26, client-r2#2).

function fakeCtx(update: { text?: string; data?: string }) {
  const replies: string[] = [];
  const ctx = {
    chat: { id: 7 },
    from: { id: 8 },
    message: update.text != null ? { text: update.text } : undefined,
    callbackQuery: update.data != null ? { data: update.data } : undefined,
    telegram: { getChatMember: vi.fn(async () => ({ status: 'creator' })), sendMessage: vi.fn(async () => ({})) },
    reply: vi.fn(async (text: string) => {
      replies.push(text);
      return {};
    }),
    answerCbQuery: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
  };
  return { ctx: ctx as unknown as Context, replies };
}

function flowWith(requestSms: (phone: string) => Promise<void>) {
  return createMaxAuthFlow({
    targetGroupId: '-100',
    auth: {
      getLastKnownPhone: () => '+79999999999',
      requestSms,
      verifyCode: async () => ({ ok: true }),
      checkPassword: async () => {},
    },
  });
}

describe('maxAuthFlow — requestSms refusals', () => {
  it('explains mandatory setup on the existing device, removes the SMS code and ends the code-retry loop', async () => {
    const verify = vi.fn(async () => { throw new MaxPasswordSetupRequiredError(); });
    const flow = createMaxAuthFlow({ targetGroupId: '-100', auth: {
      getLastKnownPhone: () => '', requestSms: async () => {}, verifyCode: verify, checkPassword: async () => {},
    } });
    await flow.handlePrivate(fakeCtx({ text: '/login' }).ctx);
    await flow.handlePrivate(fakeCtx({ text: '+79999999999' }).ctx);
    const code = fakeCtx({ text: '000000' }); await flow.handlePrivate(code.ctx);
    expect(code.ctx.deleteMessage).toHaveBeenCalledOnce();
    expect(code.replies[0]).toContain('Установить пароль');
    expect(code.replies[0]).toContain('/login заново');
    expect(code.replies[0]).not.toContain('Пришлите код ещё раз');
    expect(flow.hasPending(7)).toBe(false);
    expect(await flow.handlePrivate(fakeCtx({ text: '000000' }).ctx)).toBe(false);
    expect(verify).toHaveBeenCalledOnce();
  });
  it('shows a connection-state refusal without «Проверьте номер» and ends the flow', async () => {
    const flow = flowWith(async () => {
      throw new MaxAuthUnavailableError('MAX на паузе — снимите паузу в /panel (▶️ Возобновить MAX) и повторите /login.');
    });
    await flow.handlePrivate(fakeCtx({ text: '/login' }).ctx);
    const confirm = fakeCtx({ data: 'maxauth:yes' });
    await flow.handlePrivate(confirm.ctx);
    expect(confirm.replies).toEqual(['❌ MAX на паузе — снимите паузу в /panel (▶️ Возобновить MAX) и повторите /login.']);
    // The flow is over: a later message is no longer taken as auth input.
    expect(await flow.handlePrivate(fakeCtx({ text: '+79999999999' }).ctx)).toBe(false);
  });

  it('keeps asking for the number on any other failure', async () => {
    const flow = flowWith(async () => {
      throw new Error('Неверный номер');
    });
    await flow.handlePrivate(fakeCtx({ text: '/login' }).ctx);
    const confirm = fakeCtx({ data: 'maxauth:yes' });
    await flow.handlePrivate(confirm.ctx);
    expect(confirm.replies[0]).toContain('Проверьте номер');
    expect(await flow.handlePrivate(fakeCtx({ text: '+79999999999' }).ctx)).toBe(true);
  });
});
