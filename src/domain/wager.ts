export const WAGER_KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof WAGER_KINDS)[number];

/** Kinds a provider may send. OPENING is internal (wallet creation only). */
export const EXTERNAL_WAGER_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const satisfies readonly WagerKind[];
export type ExternalWagerKind = (typeof EXTERNAL_WAGER_KINDS)[number];

export const REVERSAL_KINDS = ['REFUND', 'ROLLBACK'] as const satisfies readonly WagerKind[];

/** Which original kinds each reversal may target. */
export const REVERSIBLE_TARGETS: Record<(typeof REVERSAL_KINDS)[number], readonly WagerKind[]> = {
  REFUND: ['BET'],
  ROLLBACK: ['BET', 'WIN', 'REFUND'],
};

export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export const TERMINAL_STATUSES: readonly WagerStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];

export const INTERNAL_PROVIDER = 'internal';

/**
 * Stable, machine-readable failure taxonomy. Never rename a code: clients
 * and providers depend on it.
 */
export const FailureCode = {
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  /** A ROLLBACK of a WIN/REFUND would push the balance below zero. */
  INSUFFICIENT_FUNDS_FOR_REVERSAL: 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
  /** The referenced transaction never arrived within the retry budget. */
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  /** The referenced transaction exists but was rejected or failed. */
  REFERENCE_NOT_PROCESSED: 'REFERENCE_NOT_PROCESSED',
  /** Player, wallet, currency or round differs from the reference. */
  REFERENCE_MISMATCH: 'REFERENCE_MISMATCH',
  /** e.g. REFUND of a WIN, or ROLLBACK of a LOSS. */
  REFERENCE_NOT_REVERSIBLE: 'REFERENCE_NOT_REVERSIBLE',
  REFERENCE_ALREADY_REVERSED: 'REFERENCE_ALREADY_REVERSED',
  /** Partial reversals are not allowed. */
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export type Direction = 'CREDIT' | 'DEBIT';
