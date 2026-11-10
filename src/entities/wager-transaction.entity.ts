import { randomUUID } from 'node:crypto';
import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import { Money } from '../domain/money';
import { type FailureCode, TERMINAL_STATUSES, type WagerKind, type WagerStatus } from '../domain/wager';

export interface NewWagerTransaction {
  idempotencyKey: string;
  payloadHash: string;
  provider: string;
  externalId: string;
  kind: WagerKind;
  playerId: string;
  currency: string;
  roundId: string | null;
  amount: Money;
  referenceExternalId: string | null;
  walletId: string | null;
}

@Entity({ tableName: 'wager_transactions' })
export class WagerTransaction {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string' })
  idempotencyKey!: string;

  @Property({ type: 'string', columnType: 'char(64)' })
  payloadHash!: string;

  @Property({ type: 'string' })
  provider!: string;

  @Property({ type: 'string' })
  externalId!: string;

  @Property({ type: 'string' })
  kind!: WagerKind;

  @Property({ type: 'string' })
  status!: WagerStatus;

  @Property({ type: 'uuid', nullable: true })
  walletId!: string | null;

  @Property({ type: 'string' })
  playerId!: string;

  @Property({ type: 'string', columnType: 'char(3)' })
  currency!: string;

  @Property({ type: 'string', nullable: true })
  roundId!: string | null;

  @Property({ type: 'decimal', precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: 'string', nullable: true })
  referenceExternalId!: string | null;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId!: string | null;

  @Property({ type: 'string', nullable: true })
  failureCode!: FailureCode | null;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ type: 'datetime', nullable: true })
  nextAttemptAt!: Date | null;

  @Property({ type: 'datetime' })
  createdAt!: Date;

  @Property({ type: 'datetime' })
  updatedAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  processedAt!: Date | null;

  static create(data: NewWagerTransaction, now = new Date()): WagerTransaction {
    const tx = new WagerTransaction();
    tx.id = randomUUID();
    tx.idempotencyKey = data.idempotencyKey;
    tx.payloadHash = data.payloadHash;
    tx.provider = data.provider;
    tx.externalId = data.externalId;
    tx.kind = data.kind;
    tx.status = 'PENDING';
    tx.walletId = data.walletId;
    tx.playerId = data.playerId;
    tx.currency = data.currency;
    tx.roundId = data.roundId;
    tx.amount = data.amount.toString();
    tx.referenceExternalId = data.referenceExternalId;
    tx.referenceTransactionId = null;
    tx.failureCode = null;
    tx.attempts = 0;
    tx.nextAttemptAt = null;
    tx.createdAt = now;
    tx.updatedAt = now;
    tx.processedAt = null;
    return tx;
  }

  get amountMoney(): Money {
    return Money.of(this.amount, this.currency);
  }

  get isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this.status);
  }

  markProcessed(now: Date, referenceTransactionId: string | null): void {
    this.assertNotTerminal();
    this.status = 'PROCESSED';
    this.referenceTransactionId = referenceTransactionId;
    this.nextAttemptAt = null;
    this.processedAt = now;
    this.updatedAt = now;
  }

  markRejected(code: FailureCode, now: Date, referenceTransactionId: string | null): void {
    this.assertNotTerminal();
    this.status = 'REJECTED';
    this.failureCode = code;
    this.referenceTransactionId = referenceTransactionId;
    this.nextAttemptAt = null;
    this.processedAt = now;
    this.updatedAt = now;
  }

  /** Counts this evaluation as one attempt and schedules the next one. */
  markPendingReference(nextAttemptAt: Date, now: Date): void {
    this.assertNotTerminal();
    this.status = 'PENDING_REFERENCE';
    this.attempts += 1;
    this.nextAttemptAt = nextAttemptAt;
    this.updatedAt = now;
  }

  private assertNotTerminal(): void {
    if (this.isTerminal) throw new Error(`Transaction ${this.id} is already ${this.status}`);
  }
}
