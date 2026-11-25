import { sanitizeText } from '../agent/grounding.js';

type NormalizedMessage = { ok: true; text: string } |
  { ok: false; code: 'INVALID_MESSAGE' | 'MESSAGE_TOO_LONG' };

export function normalizeMessage(raw: unknown): NormalizedMessage {
  if (typeof raw !== 'string') return { ok: false, code: 'INVALID_MESSAGE' };
  if (raw.length > 2000) return { ok: false, code: 'MESSAGE_TOO_LONG' };
  // Node 24 implements isWellFormed, which is newer than the project's ES2023 type library.
  if (!(raw as string & { isWellFormed(): boolean }).isWellFormed()) return { ok: false, code: 'INVALID_MESSAGE' };

  let text = '';
  let pendingSpace = false;
  let length = 0;
  for (const char of sanitizeText(raw.normalize('NFKC'), ' ')) {
    if (!char.trim()) {
      pendingSpace = length > 0;
      continue;
    }
    length += pendingSpace ? 2 : 1;
    if (length > 1000) return { ok: false, code: 'MESSAGE_TOO_LONG' };
    text += pendingSpace ? ` ${char}` : char;
    pendingSpace = false;
  }
  return length ? { ok: true, text } : { ok: false, code: 'INVALID_MESSAGE' };
}

export function foldForMatching(text: string): string {
  let folded = '';
  for (const char of text.toLocaleLowerCase('tr').normalize('NFD')) {
    const point = char.codePointAt(0)!;
    if (point < 0x0300 || point > 0x036f) folded += char === 'ı' ? 'i' : char;
  }
  return folded;
}
