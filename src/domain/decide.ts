import type { Money } from './money';
import { type Direction, FailureCode, REVERSIBLE_TARGETS, type WagerKind, type WagerStatus } from './wager';

export interface Movement {
  readonly direction: Direction;
  readonly amount: Money;
}

export type Decision =
  | { readonly status: 'PROCESSED'; readonly movement: Movement | null }
  | { readonly status: 'REJECTED'; readonly failureCode: FailureCode }
  | { readonly status: 'PENDING_REFERENCE' };

export interface WalletView {
  readonly id: string;
  readonly balance: Money;
}

export interface ReferenceView {
  readonly kind: WagerKind;
  readonly status: WagerStatus;
  readonly amount: Money;
  readonly playerId: string;
  readonly walletId: string | null;
  readonly currency: string;
  readonly roundId: string | null;
}

export interface DecisionInput {
  readonly kind: WagerKind;
  readonly amount: Money;
  readonly playerId: string;
  readonly currency: string;
  readonly roundId: string | null;
  /** The player's wallet in that currency, already locked by the caller. */
  readonly wallet: WalletView | null;
  /** Only for REFUND/ROLLBACK: the referenced transaction, or null if it has not arrived yet. */
  readonly reference?: ReferenceView | null;
  /** True if the reference already has a PROCESSED REFUND or ROLLBACK. */
  readonly referenceAlreadyReversed?: boolean;
}

const processed = (movement: Movement | null): Decision => ({ status: 'PROCESSED', movement });
const rejected = (failureCode: FailureCode): Decision => ({ status: 'REJECTED', failureCode });
const PENDING: Decision = { status: 'PENDING_REFERENCE' };

/**
 * Pure business decision for one wager transaction. No I/O: the caller is
 * responsible for holding the wallet lock while it calls this and applies
 * the result, which is what makes read-calculate-update safe.
 */
export function decide(input: DecisionInput): Decision {
  const { kind, amount, wallet } = input;
  if (!wallet) return rejected(FailureCode.WALLET_NOT_FOUND);

  switch (kind) {
    case 'OPENING':
    case 'WIN':
      return processed(amount.isZero() ? null : { direction: 'CREDIT', amount });
    case 'LOSS':
      // The stake was already debited by the BET; a LOSS only closes the round.
      return processed(null);
    case 'BET':
      if (amount.isZero()) return processed(null);
      return wallet.balance.canSubtract(amount)
        ? processed({ direction: 'DEBIT', amount })
        : rejected(FailureCode.INSUFFICIENT_FUNDS);
    case 'REFUND':
    case 'ROLLBACK':
      return decideReversal(input, wallet, kind);
  }
}

function decideReversal(input: DecisionInput, wallet: WalletView, kind: 'REFUND' | 'ROLLBACK'): Decision {
  const ref = input.reference;
  if (!ref) return PENDING;
  if (ref.status === 'PENDING' || ref.status === 'PENDING_REFERENCE') return PENDING;
  if (ref.status !== 'PROCESSED') return rejected(FailureCode.REFERENCE_NOT_PROCESSED);

  if (
    ref.playerId !== input.playerId ||
    ref.walletId !== wallet.id ||
    ref.currency !== input.currency ||
    ref.roundId !== input.roundId
  ) {
    return rejected(FailureCode.REFERENCE_MISMATCH);
  }
  if (!REVERSIBLE_TARGETS[kind].includes(ref.kind)) return rejected(FailureCode.REFERENCE_NOT_REVERSIBLE);
  if (!ref.amount.equals(input.amount)) return rejected(FailureCode.AMOUNT_MISMATCH);
  if (input.referenceAlreadyReversed) return rejected(FailureCode.REFERENCE_ALREADY_REVERSED);

  if (input.amount.isZero()) return processed(null);
  // Reversing a debit (BET) credits it back; reversing a credit (WIN, REFUND) debits it.
  if (ref.kind === 'BET') return processed({ direction: 'CREDIT', amount: input.amount });
  return wallet.balance.canSubtract(input.amount)
    ? processed({ direction: 'DEBIT', amount: input.amount })
    : rejected(FailureCode.INSUFFICIENT_FUNDS_FOR_REVERSAL);
}
