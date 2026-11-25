export const REVIEW_STATES = ['pending_review', 'edited', 'blocked', 'approved_internal', 'rejected'] as const;
export type ReviewState = typeof REVIEW_STATES[number];

export const REJECT_REASONS = ['inaccurate', 'unsafe_disclosure', 'out_of_scope', 'duplicate', 'other'] as const;
export type RejectReason = typeof REJECT_REASONS[number];

const transitions: Readonly<Record<ReviewState, readonly ReviewState[]>> = {
  pending_review: ['edited', 'blocked', 'approved_internal', 'rejected'],
  edited: ['edited', 'blocked', 'approved_internal', 'rejected'],
  blocked: ['edited', 'blocked', 'rejected'],
  approved_internal: [],
  rejected: [],
};

export function canTransition(from: ReviewState, to: ReviewState): boolean {
  return transitions[from].includes(to);
}

export function isTerminal(state: ReviewState): boolean {
  return state === 'approved_internal' || state === 'rejected';
}

export function isReviewState(value: unknown): value is ReviewState {
  return REVIEW_STATES.some((state) => state === value);
}

export function isRejectReason(value: unknown): value is RejectReason {
  return REJECT_REASONS.some((reason) => reason === value);
}
