import { describe, expect, it } from 'vitest';
import { resolveChatName, resolveContactDisplayName, resolveContactTopicName } from '../src/max/names.js';

describe('contact labels as Telegram topic names', () => {
  const names = [{ type: 'ONEME', firstName: 'Иван', lastName: 'Иванов', name: 'nickname' }, { type: 'CUSTOM', name: '  Иван — мастер  ' }];
  it('prefers the owner label over both the public name and nickname', () => {
    expect(resolveContactTopicName(2, { names })).toBe('Иван — мастер');
    expect(resolveChatName({ id: 55, type: 'DIALOG', participants: { 1: {}, 2: {} } }, 1, new Map([[2, { names }]]))).toBe('Иван — мастер');
    expect(resolveContactDisplayName(2, { names })).toBe('Иван Иванов');
  });
  it('falls back to the person name for an absent or blank label', () => {
    expect(resolveContactTopicName(2, { names: [{ type: 'CUSTOM', name: '   ' }, names[0]!] })).toBe('Иван Иванов');
    expect(resolveContactTopicName(2, undefined)).toBe('MAX ID 2');
  });
  it('accepts structured custom names and preserves group titles and Saved Messages', () => {
    expect(resolveContactTopicName(2, { names: [{ type: 'CUSTOM', firstName: 'Мой', lastName: 'мастер' }, names[0]!] })).toBe('Мой мастер');
    expect(resolveChatName({ id: 4, type: 'CHAT', title: 'Работа', participants: { 1: {}, 2: {}, 3: {} } }, 1, new Map())).toBe('Работа');
    expect(resolveChatName({ id: 0 }, 1, new Map())).toBe('Избранное');
  });
});
