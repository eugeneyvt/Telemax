import { describe, expect, it } from 'vitest';
import { formattingInRendered, maxToTelegram, splitRichText, telegramToMax } from '../src/bridge/formatting.js';

describe('formatting across both protocols', () => {
  it('round-trips common formatting, nested spans, links and UTF-16 offsets', () => {
    const text = '😀 bold link';
    const entities = [{ type: 'bold' as const, offset: 3, length: 4 }, { type: 'text_link' as const, offset: 8, length: 4, url: 'https://example.com' }];
    const max = telegramToMax(text, entities);
    expect(max[0]).toEqual({ type: 'STRONG', from: 3, length: 4 });
    expect(maxToTelegram(text, max)).toEqual(entities);
  });
  it('preserves every character and rebases a format that crosses a part boundary', () => {
    const text = 'a'.repeat(3998) + '😀 ' + 'b'.repeat(100);
    const parts = splitRichText(text, [{ type: 'bold', offset: 3990, length: 25 }], 4000);
    expect(parts.map(p => p.text).join('')).toBe(text);
    expect(parts.every(p => p.text.length <= 4000)).toBe(true);
    expect(parts[1]!.entities[0]!.offset).toBe(0);
    expect(parts[0]!.entities[0]!.length + parts[1]!.entities[0]!.length).toBe(25);
  });
  it('does not style the bridge author/quote prefix or mistake a quoted copy for the main body', () => {
    expect(formattingInRendered('hello', [{ type: 'STRONG', from: 0, length: 5 }], 'quote hello\n👤 Name:\nhello\n🕓')).toEqual([{ type: 'bold', offset: 21, length: 5 }]);
  });
  it('ignores malformed ranges and dangerous URLs; never treats Telegram ids as MAX users', () => {
    expect(telegramToMax('😀x', [{ type: 'bold', offset: 1, length: 1 }, { type: 'text_link', offset: 0, length: 2, url: 'javascript:bad' }])).toEqual([]);
    const got = telegramToMax('Alice', [{ type: 'text_mention', offset: 0, length: 5, user: { id: 42, is_bot: false, first_name: 'Alice' } }]);
    expect(got[0]?.type).toBe('LINK'); expect(got[0]?.entityId).toBeUndefined();
  });
  it('removes formatting nested in code so Telegram does not reject the entire message', () => {
    expect(maxToTelegram('code', [{ type: 'CODE', from: 0, length: 4 }, { type: 'STRONG', from: 0, length: 4 }])).toEqual([{ type: 'pre', offset: 0, length: 4, language: '' }]);
  });
});
