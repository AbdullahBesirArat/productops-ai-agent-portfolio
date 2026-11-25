import { asSource, sanitizeText, type Fact } from '../agent/grounding.js';
import type { SourceRef } from '../agent/types.js';
import { ORDER_CODE, type Classification } from './classifier.js';
import type { InternalEvidence } from './disclosure.js';
import { supportLookup } from './plan.js';

export type EvidenceStatus = 'verified' | 'not_found' | 'unverified' | 'contradictory' | 'needs_information' | 'not_required';
type OrderEvidence = Extract<InternalEvidence, { kind: 'order_status' }>;
type PolicyEvidence = Extract<InternalEvidence, { kind: 'policy' }>;
type StockEvidence = Extract<InternalEvidence, { kind: 'low_stock' }>;
type StockItem = StockEvidence['items'][number];
type VerifiedClaim = { key: string; value: string } & (
  { kind: 'entry'; entry: OrderEvidence | PolicyEvidence; source: SourceRef } |
  { kind: 'item'; item: StockItem; source: SourceRef } |
  { kind: 'empty' }
);

export const ORDER_STATUS = {
  pending: 'beklemede', paid: '\u00f6dendi', shipped: 'kargoya verildi', cancelled: 'iptal edildi',
};

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isGatewayTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};

function verifiedClaims(fact: Extract<Fact, { outcome: 'ok' }>): VerifiedClaim[] {
  const data = fact.data;
  if (fact.tool === 'get_order_status') {
    const { order_code: code, status, status_updated_at: updated } = data;
    const source = asSource(data.source);
    if (source?.entity !== 'order' || typeof code !== 'string' || !ORDER_CODE.test(code) ||
        typeof status !== 'string' || !Object.hasOwn(ORDER_STATUS, status) ||
        !isGatewayTimestamp(updated)) return [];
    return [{
      kind: 'entry', key: code, value: JSON.stringify([status, updated]), source,
      entry: { kind: 'order_status', order_code: code, status: status as keyof typeof ORDER_STATUS,
        status_updated_date: updated.slice(0, 10), source },
    }];
  }
  if (fact.tool === 'get_policy_snippet') {
    const { topic, version, snippet } = data;
    const source = asSource(data.source);
    if (source?.entity !== 'policy_snippet' || typeof topic !== 'string' || !isCount(version) || typeof snippet !== 'string') return [];
    const sanitized = sanitizeText(snippet, ' ');
    let quote = sanitized.slice(0, 500).trim();
    const last = quote.charCodeAt(quote.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) quote = quote.slice(0, -1);
    const truncated = data.truncated === true || sanitized.length > 500;
    return quote ? [{
      kind: 'entry', key: topic, value: JSON.stringify([version, snippet, data.truncated === true]), source,
      entry: { kind: 'policy', topic, version, quote, truncated, source },
    }] : [];
  }
  if (!Array.isArray(data.items) || !isCount(data.threshold_applied)) return [];
  if (data.items.length === 0) return [{ kind: 'empty', key: '', value: String(data.threshold_applied) }];
  return data.items.flatMap((raw: unknown): VerifiedClaim[] => {
    if (typeof raw !== 'object' || raw === null) return [];
    const item = raw as Record<string, unknown>;
    const source = asSource(item.source);
    const { sku, name, available_stock: stock } = item;
    if (source?.entity !== 'product' || typeof sku !== 'string' || typeof name !== 'string' || !isCount(stock)) return [];
    const label = sanitizeText(sku, '').trim();
    return label ? [{
      kind: 'item', key: sku, value: JSON.stringify([stock, name]), source,
      item: { sku: label, name: sanitizeText(name, ' ').trim(), available_stock: stock, source },
    }] : [];
  });
}

export function collectSupportEvidence(facts: readonly Fact[], classification: Classification): {
  evidenceStatus: EvidenceStatus; internalEvidence: InternalEvidence[]; sources: SourceRef[]; reviewNotes: string[];
} {
  const { intent, ambiguous, needsInformation, flags } = classification;
  const reviewNotes = ['draft_only_not_sent'];
  if (intent === 'order_status') reviewNotes.push('order_ownership_not_verified');
  if (intent === 'low_stock') reviewNotes.push('internal_inventory_information');
  if (flags.includes('instruction_like_text')) reviewNotes.push('instruction_like_text_ignored');
  if (ambiguous) reviewNotes.push('ambiguous_intent');
  const abstain = (evidenceStatus: Exclude<EvidenceStatus, 'verified'>) =>
    ({ evidenceStatus, internalEvidence: [], sources: [], reviewNotes: [...reviewNotes, 'evidence_insufficient'] });

  const lookup = supportLookup(classification);
  if (!lookup) {
    return abstain(!ambiguous && intent === 'order_status' && (needsInformation || !classification.entities.orderCode)
      ? 'needs_information' : 'not_required');
  }

  const claims = new Map<string, VerifiedClaim>();
  const bySource = new Map<string, VerifiedClaim>();
  let notFound = false;
  let stockCount = 0;
  let threshold: number | undefined;
  for (const fact of facts) {
    if (fact.tool !== lookup.tool) continue;
    if (fact.outcome === 'not_found') {
      notFound = true;
      continue;
    }
    const verified = verifiedClaims(fact);
    if (fact.tool === 'list_low_stock_products' && verified.length) {
      const { count, items, threshold_applied } = fact.data;
      if (Array.isArray(items) && isCount(threshold_applied)) {
        if (threshold !== undefined && threshold !== threshold_applied) return abstain('contradictory');
        threshold = threshold_applied;
        stockCount = Math.max(stockCount, items.length, isCount(count) ? count : 0);
      }
    }
    for (const claim of verified) {
      const prior = claims.get(claim.key);
      const priorSource = claim.kind === 'empty' ? undefined : bySource.get(claim.source.id);
      if ((prior && prior.value !== claim.value) ||
          (priorSource && (priorSource.key !== claim.key || priorSource.value !== claim.value))) {
        return abstain('contradictory');
      }
      if (!prior) claims.set(claim.key, claim);
      if (claim.kind !== 'empty') bySource.set(claim.source.id, claim);
    }
  }
  if (claims.has('') && claims.size > 1) return abstain('contradictory');
  const requestedKey = intent === 'order_status' ? classification.entities.orderCode : intent;
  const rendered = [...claims.values()].filter(({ key }) => intent === 'low_stock' || key === requestedKey).slice(0, 10);
  if (!rendered.length) return abstain(notFound ? 'not_found' : 'unverified');

  const internalEvidence: InternalEvidence[] = rendered.flatMap((claim) => claim.kind === 'entry' ? [claim.entry] : []);
  if (threshold !== undefined) {
    const items = rendered.flatMap((claim) => claim.kind === 'item' ? [claim.item] : []);
    const count = claims.has('') ? 0 : Math.max(stockCount, claims.size);
    internalEvidence.push({ kind: 'low_stock', items, count, threshold_applied: threshold, omitted_count: count - items.length });
  }
  if (internalEvidence.some((entry) => entry.kind === 'policy' && entry.truncated)) reviewNotes.push('policy_text_truncated');
  return {
    evidenceStatus: 'verified', internalEvidence,
    sources: rendered.flatMap((claim) => claim.kind === 'empty' ? [] : [claim.source]), reviewNotes,
  };
}
