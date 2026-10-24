import type { MessageEntity } from 'telegraf/types';
import { truncateUtf16 } from './text.js';

export interface MaxTextElement {
  type: string; from?: number; length?: number;
  entityId?: unknown; entityName?: string;
  attributes?: { url?: string; [key: string]: unknown };
}
export interface RichText { text: string; entities: MessageEntity[] }
const TO_MAX: Record<string, string> = {
  bold: 'STRONG', italic: 'EMPHASIZED', underline: 'UNDERLINE', strikethrough: 'STRIKETHROUGH',
  code: 'MONOSPACED', pre: 'CODE', blockquote: 'QUOTE', expandable_blockquote: 'QUOTE',
};
const TO_TG: Record<string, MessageEntity['type']> = {
  STRONG: 'bold', EMPHASIZED: 'italic', UNDERLINE: 'underline', STRIKETHROUGH: 'strikethrough',
  MONOSPACED: 'code', CODE: 'pre', QUOTE: 'blockquote', HEADING: 'bold', USER_MENTION: 'bold',
};
function safeUrl(s: unknown): s is string { return typeof s === 'string' && /^(https?:|mailto:|tel:|tg:)\S+$/i.test(s); }
function range(text: string, offset: number, length: number): boolean {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset + length > text.length) return false;
  const cutsPair = (i: number) => i > 0 && i < text.length && /[\uD800-\uDBFF]/.test(text[i - 1]!) && /[\uDC00-\uDFFF]/.test(text[i]!);
  return !cutsPair(offset) && !cutsPair(offset + length);
}
export function telegramToMax(text: string, entities: readonly MessageEntity[] = []): MaxTextElement[] {
  const out: MaxTextElement[] = [];
  for (const e of entities) {
    if (!range(text, e.offset, e.length)) continue;
    const base = { from: e.offset, length: e.length };
    if (TO_MAX[e.type]) out.push({ type: TO_MAX[e.type]!, ...base });
    else if (e.type === 'text_link' && safeUrl(e.url)) out.push({ type: 'LINK', ...base, attributes: { url: e.url } });
    else if (e.type === 'url') {
      const url = text.slice(e.offset, e.offset + e.length);
      const full = /^https?:/i.test(url) ? url : `https://${url}`;
      if (safeUrl(full)) out.push({ type: 'LINK', ...base, attributes: { url: full } });
    } else if (e.type === 'text_mention') {
      // A Telegram user id is never a MAX user id.
      out.push({ type: 'LINK', ...base, attributes: { url: `tg://user?id=${e.user.id}` } });
    }
  }
  return out;
}
export function maxToTelegram(text: string, elements: readonly MaxTextElement[] = []): MessageEntity[] {
  const out: MessageEntity[] = [];
  for (const e of elements) {
    const offset = Number(e.from), length = Number(e.length);
    if (!range(text, offset, length)) continue;
    if (e.type === 'LINK' && safeUrl(e.attributes?.url)) out.push({ type: 'text_link', offset, length, url: e.attributes.url });
    else if (TO_TG[e.type]) out.push({ type: TO_TG[e.type]!, offset, length, ...(e.type === 'CODE' ? { language: '' } : {}) } as MessageEntity);
  }
  // Telegram forbids nesting any formatting inside code/pre and crossing entity ranges.
  return out.filter((e, i) => !out.some((other, j) => {
    if (i === j) return false;
    const overlap = e.offset < other.offset + other.length && other.offset < e.offset + e.length;
    if (!overlap) return false;
    if (['pre', 'code'].includes(other.type) && !['pre', 'code'].includes(e.type)) return true;
    const crossing = (e.offset < other.offset && e.offset + e.length > other.offset && e.offset + e.length < other.offset + other.length) || (other.offset < e.offset && other.offset + other.length > e.offset && other.offset + other.length < e.offset + e.length);
    return crossing && j < i;
  }));
}

/** Prefixes added by the bridge never inherit the user's formatting. */
export function formattingInRendered(original: string | undefined, elements: readonly MaxTextElement[] | undefined, rendered: string): MessageEntity[] {
  if (!original || !elements?.length) return [];
  const offset = rendered.lastIndexOf(original);
  if (offset < 0) return [];
  return maxToTelegram(original, elements).map(e => ({ ...e, offset: e.offset + offset }));
}
export function shiftFormatting(entities: readonly MessageEntity[] | undefined, by: number): MessageEntity[] {
  return (entities ?? []).map(e => ({ ...e, offset: e.offset + by }));
}

/** Exact text preservation, UTF-16-safe cuts, and clipped/rebased spans for every part. */
export function splitRichText(text: string, entities: readonly MessageEntity[] = [], limit = 4096): RichText[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('Rich-text part limit must be at least 2');
  const result: RichText[] = [];
  let start = 0;
  while (start < text.length) {
    let length = truncateUtf16(text.slice(start), limit).length;
    if (start + length < text.length) {
      const chunk = text.slice(start, start + length);
      const boundary = Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf(' '));
      if (boundary >= Math.floor(limit / 2)) length = boundary + 1;
    }
    const end = start + length;
    const spans = entities.flatMap(e => {
      if (!range(text, e.offset, e.length)) return [];
      const a = Math.max(start, e.offset), b = Math.min(end, e.offset + e.length);
      return b > a ? [{ ...e, offset: a - start, length: b - a }] : [];
    });
    const piece = text.slice(start, end);
    // Telegram rejects whitespace-only messages; retain such a tail in the preceding part when possible.
    if (piece.trim()) result.push({ text: piece, entities: spans });
    else if (result.length && result[result.length - 1]!.text.length + piece.length <= limit) result[result.length - 1]!.text += piece;
    start = end;
  }
  return result;
}
