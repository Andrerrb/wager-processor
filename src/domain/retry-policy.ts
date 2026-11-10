export interface RetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** After this many evaluations without a reference, the transaction is rejected. */
  readonly maxAttempts: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  maxAttempts: 10,
};

/** Exponential backoff: base * 2^attempts, capped. */
export function nextAttemptAt(attemptsSoFar: number, now: Date, policy: RetryPolicy = DEFAULT_RETRY_POLICY): Date {
  const delay = Math.min(policy.baseDelayMs * 2 ** attemptsSoFar, policy.maxDelayMs);
  return new Date(now.getTime() + delay);
}
