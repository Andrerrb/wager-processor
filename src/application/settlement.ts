import type { EntityManager } from '@mikro-orm/postgresql';
import { type Decision, decide, type ReferenceView } from '../domain/decide';
import {
  type DomainEvent,
  type TransactionEventPayload,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events';
import { DEFAULT_RETRY_POLICY, nextAttemptAt, type RetryPolicy } from '../domain/retry-policy';
import { FailureCode, REVERSAL_KINDS } from '../domain/wager';
import { LedgerEntry } from '../entities/ledger-entry.entity';
import { OutboxEvent } from '../entities/outbox-event.entity';
import { WagerTransaction } from '../entities/wager-transaction.entity';
import type { Wallet } from '../entities/wallet.entity';

/**
 * Decides and persists the outcome of one transaction: status, balance,
 * ledger entry and outbox events, all through `em` (which must be inside a
 * SQL transaction that holds the wallet's row lock).
 *
 * Shared by the HTTP/queue use case, wallet opening and the
 * PENDING_REFERENCE retry worker, so every path follows the same rules.
 */
export async function settleTransaction(
  em: EntityManager,
  tx: WagerTransaction,
  wallet: Wallet | null,
  now: Date,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<Decision> {
  const reference = await loadReference(em, tx);
  const referenceAlreadyReversed = reference ? await hasProcessedReversal(em, reference.id) : false;

  let decision = decide({
    kind: tx.kind,
    amount: tx.amountMoney,
    playerId: tx.playerId,
    currency: tx.currency,
    roundId: tx.roundId,
    wallet: wallet ? { id: wallet.id, balance: wallet.balanceMoney } : null,
    reference: reference ? toReferenceView(reference) : null,
    referenceAlreadyReversed,
  });

  if (decision.status === 'PENDING_REFERENCE' && tx.attempts + 1 >= policy.maxAttempts) {
    decision = { status: 'REJECTED', failureCode: FailureCode.REFERENCE_NOT_FOUND };
  }

  const isFirstEvaluation = tx.status === 'PENDING';
  const referenceId = reference?.id ?? null;
  switch (decision.status) {
    case 'PROCESSED':
      tx.markProcessed(now, referenceId);
      break;
    case 'REJECTED':
      tx.markRejected(decision.failureCode, now, referenceId);
      break;
    case 'PENDING_REFERENCE':
      tx.markPendingReference(nextAttemptAt(tx.attempts, now, policy), now);
      break;
  }

  // The transaction row must exist before the ledger entry references it (FK).
  em.persist(tx);
  await em.flush();

  const events: DomainEvent<object>[] = [];
  const payload = toEventPayload(tx);
  if (decision.status === 'PROCESSED') {
    events.push(new WagerTransactionProcessed(payload, now));
    if (decision.movement && wallet) {
      const balanceBefore = wallet.balance;
      wallet.apply(decision.movement, now);
      em.persist(LedgerEntry.record(wallet, tx.id, decision.movement, now));
      events.push(
        new WalletBalanceChanged(
          {
            walletId: wallet.id,
            transactionId: tx.id,
            currency: wallet.currency,
            direction: decision.movement.direction,
            amount: decision.movement.amount.toString(),
            balanceBefore,
            balanceAfter: wallet.balance,
            walletVersion: wallet.version,
          },
          now,
        ),
      );
    }
  } else if (decision.status === 'REJECTED') {
    events.push(new WagerTransactionRejected(payload, now));
  } else if (isFirstEvaluation) {
    // Retries that are still pending do not re-announce the same state.
    events.push(new WagerTransactionPendingReference({ ...payload, nextAttemptAt: tx.nextAttemptAt!.toISOString() }, now));
  }

  for (const event of events) em.persist(OutboxEvent.from(event));
  await em.flush();
  return decision;
}

async function loadReference(em: EntityManager, tx: WagerTransaction): Promise<WagerTransaction | null> {
  if (!tx.referenceExternalId) return null;
  return em.findOne(WagerTransaction, { provider: tx.provider, externalId: tx.referenceExternalId });
}

/**
 * Business rule: once a transaction has a PROCESSED reversal, it cannot be
 * reversed again by any kind (prevents REFUND + ROLLBACK of the same BET,
 * which would credit the stake twice). The partial unique index in the
 * database is the last line of defense for the same-kind case.
 */
async function hasProcessedReversal(em: EntityManager, referenceId: string): Promise<boolean> {
  const count = await em.count(WagerTransaction, {
    referenceTransactionId: referenceId,
    status: 'PROCESSED',
    kind: { $in: [...REVERSAL_KINDS] },
  });
  return count > 0;
}

function toReferenceView(ref: WagerTransaction): ReferenceView {
  return {
    kind: ref.kind,
    status: ref.status,
    amount: ref.amountMoney,
    playerId: ref.playerId,
    walletId: ref.walletId,
    currency: ref.currency,
    roundId: ref.roundId,
  };
}

function toEventPayload(tx: WagerTransaction): TransactionEventPayload {
  return {
    transactionId: tx.id,
    provider: tx.provider,
    externalId: tx.externalId,
    kind: tx.kind,
    status: tx.status,
    failureCode: tx.failureCode,
    walletId: tx.walletId,
    playerId: tx.playerId,
    currency: tx.currency,
    roundId: tx.roundId,
    amount: tx.amount,
    referenceTransactionId: tx.referenceTransactionId,
  };
}
