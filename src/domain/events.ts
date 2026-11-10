import { randomUUID } from 'node:crypto';
import type { Direction, WagerKind, WagerStatus } from './wager';

/** What actually goes on the wire. Monetary values are always decimal strings. */
export interface EventEnvelope<P extends object = object> {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly occurredAt: string;
  readonly aggregateId: string;
  readonly payload: P;
}

export abstract class DomainEvent<P extends object> {
  abstract readonly eventType: string;
  readonly eventVersion: number = 1;
  readonly eventId: string = randomUUID();

  protected constructor(
    readonly aggregateId: string,
    readonly payload: P,
    readonly occurredAt: Date,
  ) {}

  toEnvelope(): EventEnvelope<P> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      eventVersion: this.eventVersion,
      occurredAt: this.occurredAt.toISOString(),
      aggregateId: this.aggregateId,
      payload: this.payload,
    };
  }
}

export interface TransactionEventPayload {
  readonly transactionId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly kind: WagerKind;
  readonly status: WagerStatus;
  readonly failureCode: string | null;
  readonly walletId: string | null;
  readonly playerId: string;
  readonly currency: string;
  readonly roundId: string | null;
  readonly amount: string;
  readonly referenceTransactionId: string | null;
}

export class WagerTransactionProcessed extends DomainEvent<TransactionEventPayload> {
  override readonly eventType = 'WagerTransactionProcessed';
  constructor(payload: TransactionEventPayload, occurredAt: Date) {
    super(payload.transactionId, payload, occurredAt);
  }
}

export class WagerTransactionRejected extends DomainEvent<TransactionEventPayload> {
  override readonly eventType = 'WagerTransactionRejected';
  constructor(payload: TransactionEventPayload, occurredAt: Date) {
    super(payload.transactionId, payload, occurredAt);
  }
}

export class WagerTransactionPendingReference extends DomainEvent<TransactionEventPayload & { nextAttemptAt: string }> {
  override readonly eventType = 'WagerTransactionPendingReference';
  constructor(payload: TransactionEventPayload & { nextAttemptAt: string }, occurredAt: Date) {
    super(payload.transactionId, payload, occurredAt);
  }
}

export interface WalletBalanceChangedPayload {
  readonly walletId: string;
  readonly transactionId: string;
  readonly currency: string;
  readonly direction: Direction;
  readonly amount: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly walletVersion: number;
}

/** Emitted only when the balance actually changes. */
export class WalletBalanceChanged extends DomainEvent<WalletBalanceChangedPayload> {
  override readonly eventType = 'WalletBalanceChanged';
  constructor(payload: WalletBalanceChangedPayload, occurredAt: Date) {
    super(payload.walletId, payload, occurredAt);
  }
}
