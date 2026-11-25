import type { Fact } from '../agent/grounding.js';
import { runAgent, type ExecuteFn, type RunLimits } from '../agent/orchestrator.js';
import type { ExecutedTool, ModelAdapter } from '../agent/types.js';
import { recordAudit } from '../tools/audit.js';
import { executeTool, type GatewayDeps, type Identity } from '../tools/gateway.js';
import { registry as defaultRegistry } from '../tools/registry.js';
import type { ToolRegistry } from '../tools/types.js';
import { detectLanguage, MockSupportClassifier, parseClassification, type Classification, type SupportClassifier } from './classifier.js';
import {
  buildCustomerSafeDraft, buildDisclosureDecision, buildInternalEvidence, internalOperatorNotes,
  NoOwnershipVerifier, type Language, type OwnershipVerifier,
} from './disclosure.js';
import { supportLookup, SupportPlanAdapter } from './plan.js';

export interface SupportServiceDeps {
  pool: GatewayDeps['pool'];
  classifier?: SupportClassifier;
  adapterFactory?: (classification: Classification) => ModelAdapter;
  registry?: ToolRegistry;
  execute?: ExecuteFn;
  limits?: Partial<RunLimits>;
  ownershipVerifier?: OwnershipVerifier;
}

export function createSupportService(deps: SupportServiceDeps) {
  const classifier = deps.classifier ?? new MockSupportClassifier();
  const registry = deps.registry ?? defaultRegistry;
  const verifier = deps.ownershipVerifier ?? new NoOwnershipVerifier();

  return async ({ message, language = detectLanguage(message), identity, runId, traceId }: {
    message: string; language?: Language; identity: Identity; runId: string; traceId: string;
  }) => {
    let classification: Classification;
    try {
      const parsed = parseClassification(classifier.classify(message));
      if (!parsed.ok) return { ok: false, status: 'invalid_model_output', errorCode: 'CLASSIFIER_ERROR' } as const;
      classification = parsed.value;
    } catch {
      return { ok: false, status: 'invalid_model_output', errorCode: 'CLASSIFIER_ERROR' } as const;
    }

    let facts: readonly Fact[] = [];
    let executedTools: ExecutedTool[] = [];
    const lookup = supportLookup(classification);
    if (lookup) {
      const adapter = deps.adapterFactory ? deps.adapterFactory(structuredClone(classification)) : new SupportPlanAdapter(classification);
      const outcome = await runAgent({
        adapter, execute: deps.execute ?? executeTool, tools: Object.keys(registry),
        gateway: { pool: deps.pool, registry },
        audit: (event) => recordAudit(deps.pool, event),
        ...(deps.limits ? { limits: deps.limits } : {}),
      }, identity, { request: 'support_preview', runId, traceId });
      if (outcome.status !== 'completed' && outcome.status !== 'unverified') {
        return { ok: false, status: outcome.status, errorCode: outcome.errorCode ?? 'INVALID_MODEL_OUTPUT' } as const;
      }
      facts = outcome.facts;
      executedTools = outcome.executedTools;
    }

    const orderCode = classification.entities.orderCode;
    if (lookup?.tool === 'get_order_status' && orderCode) {
      try {
        await verifier.verify({ orgId: identity.org, actorId: identity.sub, orderCode });
      } catch {
        // Advisory verification failures leave the T6 disclosure policy in force.
      }
    }
    const evidence = buildInternalEvidence(facts, classification);
    const { evidenceStatus, internalEvidence } = evidence;
    return {
      ok: true, classification, ...evidence, executedTools,
      customerDraft: buildCustomerSafeDraft({ language, classification, evidenceStatus, internalEvidence }),
      disclosure: buildDisclosureDecision(classification, internalEvidence, verifier.name),
      operatorNotes: internalOperatorNotes(classification, internalEvidence, evidenceStatus),
      status: evidenceStatus === 'verified' ? 'draft' : 'abstained',
    } as const;
  };
}
