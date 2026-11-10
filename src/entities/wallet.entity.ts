import { randomUUID } from 'node:crypto';
import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import type { Movement } from '../domain/decide';
import { Money } from '../domain/money';

export class InsufficientFundsError extends Error {
  override readonly name = 'InsufficientFundsError';
}

/**
 * One wallet per (player, currency).
 * Invariants: balance >= 0; version starts at 1 and increments exactly once
 * per balance change; every balance change has exactly one ledger entry
 * (so version - 1 === number of ledger entries).
 */
@Entity({ tableName: 'wallets' })
export class Wallet {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string' })
  playerId!: string;

  @Property({ type: 'string', columnType: 'char(3)' })
  currency!: string;

  /** NUMERIC(18,2) as a decimal string. Only change it through `apply`. */
  @Property({ type: 'decimal', precision: 18, scale: 2 })
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'datetime' })
  createdAt!: Date;

  @Property({ type: 'datetime' })
  updatedAt!: Date;

  static open(playerId: string, currency: string, now = new Date()): Wallet {
    const wallet = new Wallet();
    wallet.id = randomUUID();
    wallet.playerId = playerId;
    wallet.currency = Money.parseCurrency(currency);
    wallet.balance = '0.00';
    wallet.version = 1;
    wallet.createdAt = now;
    wallet.updatedAt = now;
    return wallet;
  }

  get balanceMoney(): Money {
    return Money.of(this.balance, this.currency);
  }

  /** Applies a credit or debit. Throws instead of ever going negative. */
  apply(movement: Movement, now = new Date()): void {
    if (movement.amount.isZero()) throw new Error('Zero movements must not touch the wallet');
    const current = this.balanceMoney;
    let next: Money;
    if (movement.direction === 'CREDIT') {
      next = current.add(movement.amount);
    } else {
      if (!current.canSubtract(movement.amount)) throw new InsufficientFundsError(`Wallet ${this.id} has insufficient funds`);
      next = current.subtract(movement.amount);
    }
    this.balance = next.toString();
    this.version += 1;
    this.updatedAt = now;
  }
}
