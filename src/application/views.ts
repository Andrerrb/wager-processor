import type { EntityManager } from '@mikro-orm/postgresql';
import { LedgerEntry } from '../entities/ledger-entry.entity';
import type { WagerTransaction } from '../entities/wager-transaction.entity';
import type { Wallet } from '../entities/wallet.entity';

export interface TransactionView {
  id: string;
  provider: string;
  externalId: string;
  kind: string;
  status: string;
  failureCode: string | null;
  walletId: string | null;
  playerId: string;
  currency: string;
  roundId: string | null;
  amount: string;
  referenceExternalId: string | null;
  referenceTransactionId: string | null;
  /** From the (immutable) ledger entry, so a replay returns exactly the original result. */
  balanceAfter: string | null;
  walletVersion: number | null;
  attempts: number;
  nextAttemptAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface WagerResult {
  replayed: boolean;
  transaction: TransactionView;
}

export async function toTransactionView(em: EntityManager, tx: WagerTransaction): Promise<TransactionView> {
  const entry = tx.status === 'PROCESSED' ? await em.findOne(LedgerEntry, { transactionId: tx.id }) : null;
  return {
    id: tx.id,
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
    referenceExternalId: tx.referenceExternalId,
    referenceTransactionId: tx.referenceTransactionId,
    balanceAfter: entry?.balanceAfter ?? null,
    walletVersion: entry?.walletVersion ?? null,
    attempts: tx.attempts,
    nextAttemptAt: tx.nextAttemptAt?.toISOString() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export function toWalletView(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance,
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function toLedgerEntryView(entry: LedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}
