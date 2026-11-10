import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import type { Movement } from '../domain/decide';
import type { Direction } from '../domain/wager';
import type { Wallet } from './wallet.entity';

/** Append-only. The database rejects UPDATE/DELETE/TRUNCATE on this table. */
@Entity({ tableName: 'ledger_entries' })
export class LedgerEntry {
  /** bigint identity, returned as a string to avoid precision loss. */
  @PrimaryKey({ type: 'bigint', autoincrement: true })
  id!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'string' })
  direction!: Direction;

  @Property({ type: 'decimal', precision: 18, scale: 2 })
  amount!: string;

  @Property({ type: 'decimal', precision: 18, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'integer' })
  walletVersion!: number;

  @Property({ type: 'datetime' })
  createdAt!: Date;

  /** Call right after `wallet.apply(movement)`: captures the new balance and version. */
  static record(wallet: Wallet, transactionId: string, movement: Movement, now = new Date()): LedgerEntry {
    const entry = new LedgerEntry();
    entry.walletId = wallet.id;
    entry.transactionId = transactionId;
    entry.direction = movement.direction;
    entry.amount = movement.amount.toString();
    entry.balanceAfter = wallet.balance;
    entry.walletVersion = wallet.version;
    entry.createdAt = now;
    return entry;
  }
}
