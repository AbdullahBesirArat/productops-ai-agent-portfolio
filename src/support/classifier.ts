import { foldForMatching } from './normalize.js';

const INTENTS = ['order_status', 'low_stock', 'shipping_delay', 'returns', 'warranty', 'general_question', 'unknown'] as const;
export type SupportIntent = typeof INTENTS[number];
type Flag = 'instruction_like_text';

export interface Classification {
  intent: SupportIntent;
  entities: { orderCode?: string };
  ambiguous: boolean;
  candidateIntents: SupportIntent[];
  needsInformation: boolean;
  ruleId: string;
  flags: Flag[];
}

export interface SupportClassifier {
  readonly name: string;
  classify(normalizedText: string): unknown;
}

export const RULE_IDS = Object.freeze({
  order_status: 'rule.order_status.v1',
  low_stock: 'rule.low_stock.v1',
  shipping_delay: 'rule.shipping_delay.v1',
  returns: 'rule.returns.v1',
  warranty: 'rule.warranty.v1',
  general_question: 'rule.general_question.v1',
  unknown: 'rule.unknown.v1',
  ambiguous: 'rule.ambiguous.v1',
});

export const ORDER_CODE = /^ORD-[A-Z0-9][A-Z0-9._-]{0,27}$/u;
// Match complete tokens with explicit delimiters. A sentence-ending period can follow a code.
const ORDER_TOKEN = /(?<![^\s.,;:!?()[\]{}"])[Oo][Rr][Dd]-[A-Za-z0-9][A-Za-z0-9._-]{0,27}?(?=(?:(?<=[A-Za-z0-9])\.(?=\s|$))|[\s,;:!?()[\]{}"]|$)/gu;
const TOPICS = [
  ['order_status', /\b(?:siparisim nerede|siparis durumu|kargom nerede|siparis takip)\b/u,
    /\b(?:order status|where is my order|track my order|tracking)\b/u],
  ['low_stock', /\b(?:stok\w*|tukendi|mevcut mu)\b/u, /\b(?:stock|availability)\b/u],
  ['shipping_delay', /\b(?:gecik\w*|gec geldi|gelmedi|teslim edilmedi)\b/u,
    /\b(?:delay|delayed|late delivery|not arrived)\b/u],
  ['returns', /\b(?:iade\w*|geri gonder\w*|degisim\w*)\b/u, /\b(?:returns?|refunds?)\b/u],
  ['warranty', /\bgaranti\w*\b/u, /\b(?:warranty|guarantee)\b/u],
] as const;
const TURKISH_GENERAL = /\b(?:merhaba|selam|tesekkur\w*|yardim\w*)\b/u;
const ENGLISH_GENERAL = /\b(?:hello|hi|thanks|help)\b/u;
const TURKISH_ORDER_WORDS = /\b(?:siparis(?:im|iniz)?|kargom)\b/u;
const TURKISH_INSTRUCTIONS = /\b(?:onceki talimat\w*|tum kullanici\w*|parola\w*)\b/u;
const ENGLISH_INSTRUCTIONS = /\b(?:ignore previous|ignore all|system prompt|you are now|act as|admin|list all users|drop table|reveal|password)\b|\bselect \* from\b/u;

export function detectLanguage(text: string): 'tr' | 'en' {
  const folded = foldForMatching(text);
  return /[çğıöşüÇĞİÖŞÜ]/u.test(text) || TURKISH_GENERAL.test(folded) || TURKISH_INSTRUCTIONS.test(folded)
    || TURKISH_ORDER_WORDS.test(folded)
    || TOPICS.some(([, turkish]) => turkish.test(folded)) ? 'tr' : 'en';
}

export class MockSupportClassifier implements SupportClassifier {
  readonly name = 'mock-rules';

  classify(normalizedText: string): Classification {
    const folded = foldForMatching(normalizedText);
    const orderCodes = new Set(Array.from(normalizedText.matchAll(ORDER_TOKEN), ([code]) => code.toUpperCase()));
    const candidateIntents = TOPICS.filter(([intent, turkish, english]) =>
      (intent === 'order_status' && orderCodes.size > 0) || turkish.test(folded) || english.test(folded),
    ).map(([intent]) => intent);
    const ambiguous = candidateIntents.length > 1 || orderCodes.size > 1;
    const orderCode = orderCodes.size === 1 ? orderCodes.values().next().value : undefined;
    const general = TURKISH_GENERAL.test(folded) || ENGLISH_GENERAL.test(folded);
    const intent = ambiguous ? 'unknown' : candidateIntents[0] ?? (general ? 'general_question' : 'unknown');
    return {
      intent, entities: orderCode ? { orderCode } : {}, ambiguous, candidateIntents,
      needsInformation: intent === 'order_status' && orderCode === undefined,
      ruleId: RULE_IDS[ambiguous ? 'ambiguous' : intent],
      flags: TURKISH_INSTRUCTIONS.test(folded) || ENGLISH_INSTRUCTIONS.test(folded) ? ['instruction_like_text'] : [],
    };
  }
}

function readRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) return undefined;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !('value' in field)) return undefined;
    result[key] = field.value;
  }
  return required.every((key) => Object.hasOwn(result, key)) ? result : undefined;
}

function readList<T>(value: unknown, max: number, accepts: (entry: unknown) => entry is T): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > max ||
      Reflect.ownKeys(value).length !== length + 1) return undefined;
  const result: T[] = [];
  for (let index = 0; index < length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, index);
    if (!entry?.enumerable || !('value' in entry) || !accepts(entry.value)) return undefined;
    result.push(entry.value);
  }
  return result;
}

const isIntent = (value: unknown): value is SupportIntent => INTENTS.some((intent) => intent === value);
const isFlag = (value: unknown): value is Flag => value === 'instruction_like_text';

export function parseClassification(raw: unknown): { ok: true; value: Classification } | { ok: false } {
  const bad = { ok: false } as const;
  try {
    const fields = readRecord(raw, ['intent', 'entities', 'ambiguous', 'candidateIntents', 'needsInformation', 'ruleId', 'flags']);
    if (!fields) return bad;
    const { intent, ambiguous, needsInformation, ruleId } = fields;
    const entities = readRecord(fields.entities, [], ['orderCode']);
    const candidateIntents = readList(fields.candidateIntents, 6, isIntent);
    const flags = readList(fields.flags, 1, isFlag);
    if (!isIntent(intent) || !entities || typeof ambiguous !== 'boolean' || typeof needsInformation !== 'boolean' ||
        !candidateIntents || !flags || typeof ruleId !== 'string' || ruleId.length > 40 || !/^[a-z0-9_.-]{1,40}$/u.test(ruleId)) return bad;
    const { orderCode } = entities;
    if (Object.hasOwn(entities, 'orderCode') &&
        (typeof orderCode !== 'string' || orderCode.length > 32 || !ORDER_CODE.test(orderCode))) return bad;
    const value: Classification = {
      intent, entities: typeof orderCode === 'string' ? { orderCode } : {}, ambiguous,
      candidateIntents, needsInformation, ruleId, flags,
    };
    return JSON.stringify(value).length <= 1000 ? { ok: true, value } : bad;
  } catch {
    return bad;
  }
}
