import { sanitizeText, type Fact } from '../agent/grounding.js';
import type { SourceRef } from '../agent/types.js';
import type { Classification } from './classifier.js';
import { collectSupportEvidence, ORDER_STATUS, type EvidenceStatus } from './draft.js';
import { foldForMatching } from './normalize.js';

export type Language = 'tr' | 'en';

type OwnershipInput = { orgId: string; actorId: string; orderCode: string };

export interface OwnershipVerifier {
  readonly name: string;
  verify(input: OwnershipInput): Promise<'unverified' | 'verified'>;
}

export class NoOwnershipVerifier implements OwnershipVerifier {
  readonly name = 'none';

  async verify(input: OwnershipInput): Promise<'unverified'> {
    void input;
    return 'unverified';
  }
}

export type InternalEvidence =
  | { kind: 'order_status'; order_code: string; status: keyof typeof ORDER_STATUS; status_updated_date: string; source: SourceRef }
  | { kind: 'low_stock'; items: { sku: string; name: string; available_stock: number; source: SourceRef }[];
      count: number; threshold_applied: number; omitted_count: number }
  | { kind: 'policy'; topic: string; version: number; quote: string; truncated: boolean; source: SourceRef };

type RestrictedField =
  | { field: 'order_code' | 'order_status' | 'order_update_date'; reason: 'ownership_unverified' }
  | { field: 'inventory_items' | 'inventory_quantity'; reason: 'internal_inventory' };

export interface DisclosureDecision {
  ownership_status: 'unverified';
  customer_specific_details_allowed: false;
  send_enabled: false;
  ownership_verifier: string;
  restricted_fields: RestrictedField[];
}

export function buildInternalEvidence(facts: readonly Fact[], classification: Classification) {
  return collectSupportEvidence(facts, classification);
}

const COPY = {
  en: {
    order: 'Order enquiries require identity verification. A team member will follow up with you.',
    stock: 'A team member will confirm product availability.',
    policy: (version: number, quote: string) => `Verified policy text (version ${version}): “${quote}”`,
    policyShortened: '[text shortened]',
    policyMissing: 'We could not verify the requested policy.',
    acknowledge: 'Thank you for reaching out. A team member will review your request.',
  },
  tr: {
    order: 'Sipariş sorguları için kimlik doğrulaması gerekir. Ekibimizden biri sizinle iletişime geçecek.',
    stock: 'Ekibimizden biri ürünün mevcut olup olmadığını doğrulayacak.',
    policy: (version: number, quote: string) => `Doğrulanan politika metni (sürüm ${version}): “${quote}”`,
    policyShortened: '[metin kısaltıldı]',
    policyMissing: 'İlgili politikayı doğrulayamadık.',
    acknowledge: 'Bize ulaştığınız için teşekkür ederiz. Ekibimizden biri talebinizi inceleyecek.',
  },
};

export function buildCustomerSafeDraft({ language, classification, evidenceStatus, internalEvidence }: {
  language: Language; classification: Classification; evidenceStatus: EvidenceStatus; internalEvidence: readonly InternalEvidence[];
}): { language: Language; text: string } {
  const copy = COPY[language];
  const { intent, ambiguous } = classification;
  if (ambiguous) return { language, text: copy.acknowledge };
  if (intent === 'order_status') return { language, text: copy.order };
  if (intent === 'low_stock') return { language, text: copy.stock };
  if (intent === 'shipping_delay' || intent === 'returns' || intent === 'warranty') {
    const policy = evidenceStatus === 'verified'
      ? internalEvidence.find((entry) => entry.kind === 'policy' && entry.topic === intent) : undefined;
    if (policy?.kind !== 'policy') return { language, text: copy.policyMissing };
    // Policy excerpts have no locale metadata. Keep the original excerpt in operator evidence.
    if (language === 'tr') return { language, text: copy.acknowledge };
    return { language, text: copy.policy(policy.version, policy.quote) + (policy.truncated ? ` ${copy.policyShortened}` : '') };
  }
  return { language, text: copy.acknowledge };
}

export function buildDisclosureDecision(
  classification: Classification, internalEvidence: readonly InternalEvidence[], verifierName: string,
): DisclosureDecision {
  const restricted_fields: RestrictedField[] = [];
  if (classification.intent === 'order_status' && internalEvidence.some((entry) => entry.kind === 'order_status')) {
    for (const field of ['order_code', 'order_status', 'order_update_date'] as const) {
      restricted_fields.push({ field, reason: 'ownership_unverified' });
    }
  }
  if (classification.intent === 'low_stock' && internalEvidence.some((entry) => entry.kind === 'low_stock')) {
    for (const field of ['inventory_items', 'inventory_quantity'] as const) {
      restricted_fields.push({ field, reason: 'internal_inventory' });
    }
  }
  // Verifier results are advisory. A verified disclosure path requires a separately reviewed policy.
  return { ownership_status: 'unverified', customer_specific_details_allowed: false, send_enabled: false,
    ownership_verifier: verifierName, restricted_fields };
}

export function internalOperatorNotes(
  classification: Classification, internalEvidence: readonly InternalEvidence[], evidenceStatus?: EvidenceStatus,
): string[] {
  const notes: string[] = [];
  if (classification.intent === 'order_status') {
    notes.push('order_ownership_unverified', 'verify_customer_identity_before_sharing_order_details');
  }
  if (classification.intent === 'low_stock') notes.push('internal_inventory_not_for_customers');
  if (internalEvidence.some((entry) => entry.kind === 'low_stock' && entry.items.length > 0)) notes.push('low_stock_items_present');
  if (evidenceStatus && evidenceStatus !== 'verified') notes.push(`evidence_${evidenceStatus}`);
  return notes;
}

const normalizeForValidation = (text: string) =>
  foldForMatching(sanitizeText(text, '').normalize('NFKC')).replace(/\s+/gu, ' ');
const statusWords = [...Object.keys(ORDER_STATUS), ...Object.values(ORDER_STATUS)].map(normalizeForValidation);
const statusPatterns = statusWords.map((word) => new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'u'));
const numbers = (text: string) => text.match(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu) ?? [];

// This heuristic cannot prove free-text edits safe. Human review remains mandatory.
export function validateCustomerText(
  text: string, internalEvidence: readonly InternalEvidence[], language: Language,
): { ok: true } | { ok: false; codes: string[] } {
  // Both status dictionaries apply regardless of the draft language.
  const codes: string[] = [];
  if (text.length > 1500) codes.push('text_too_long');
  const sanitized = sanitizeText(text, '');
  if (!sanitized.trim()) codes.push('text_empty');
  const normalized = normalizeForValidation(text);
  if (sanitized !== text || sanitizeText(text.normalize('NFKC'), '') !== text.normalize('NFKC')) {
    codes.push('unsafe_characters');
  }
  if (/[<>@]|http|www\.|\p{Nd}{7}/u.test(normalized)) codes.push('markup_or_contact');
  if (/ord-[\p{L}\p{N}]/u.test(normalized)) codes.push('order_code');
  if (/sku-[\p{L}\p{N}]/u.test(normalized)) codes.push('sku');

  const quotes = internalEvidence.flatMap((entry) => entry.kind === 'policy' ? [normalizeForValidation(entry.quote)] : []);
  if (statusPatterns.some((pattern) => pattern.test(normalized) && !quotes.some((quote) => pattern.test(quote)))) {
    codes.push('order_status');
  }
  const restrictedValues = internalEvidence.flatMap((entry) => {
    if (entry.kind === 'order_status') return [entry.order_code];
    return entry.kind === 'low_stock' ? entry.items.flatMap(({ sku, name }) => [sku, name]) : [];
  }).map(normalizeForValidation);
  if (restrictedValues.some((value) => value && normalized.includes(value))) codes.push('internal_value');

  const policyNumbers = new Set(quotes.flatMap(numbers));
  const generatedPolicy = internalEvidence.find((entry) => entry.kind === 'policy'
    && text === COPY[language].policy(entry.version, entry.quote) + (entry.truncated ? ` ${COPY[language].policyShortened}` : ''));
  const numericText = generatedPolicy?.kind === 'policy' ? normalizeForValidation(generatedPolicy.quote) : normalized;
  if (numbers(numericText).some((number) => !policyNumbers.has(number))) codes.push('unverified_number');
  return codes.length ? { ok: false, codes } : { ok: true };
}
