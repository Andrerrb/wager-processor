import {
  ConnectionException,
  DeadlockException,
  LockMode,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { InboxMessage } from '../entities/inbox-message.entity';
import { WagerTransaction } from '../entities/wager-transaction.entity';
import { Wallet } from '../entities/wallet.entity';
import { logger } from '../infra/logger';
import { metrics } from '../infra/metrics';
import { IdempotencyConflictError, TransientError } from './errors';
import { settleTransaction } from './settlement';
import { toTransactionView, type WagerResult } from './views';
import { type WagerCommand, wagerPayloadHash } from './wager-command';

/** How long a request waits for a busy wallet before failing with a retryable 503. */
export const WALLET_LOCK_TIMEOUT = '5s';

/** Set when the command came from the queue: recorded in the inbox in the same SQL transaction. */
export interface InboxRef {
  messageId: string;
  source: string;
}

/**
 * Processes one wager transaction. Used by both the HTTP endpoint and the
 * SQS consumer.
 *
 * Concurrency strategy: pessimistic row lock on the single wallet involved
 * (SELECT ... FOR UPDATE). Writers on the same wallet are serialized by
 * PostgreSQL, writers on different wallets run fully in parallel, and it
 * works across any number of application instances because the lock lives
 * in the database. Since a transaction touches exactly one wallet there is
 * no lock ordering problem (no deadlocks between wallets).
 */
@Injectable()
export class ProcessWagerTransaction {
  constructor(private readonly em: EntityManager) {}

  async execute(command: WagerCommand, inbox?: InboxRef): Promise<WagerResult> {
    const startedAt = performance.now();
    try {
      const result = await this.executeOnce(command, inbox);
      if (result.replayed) metrics.inc('wager_duplicates_total');
      else metrics.inc('wager_transactions_total', { status: result.transaction.status });
      return result;
    } catch (error) {
      if (error instanceof LockWaitTimeoutException) {
        metrics.inc('wallet_lock_timeouts_total');
        throw new TransientError('WALLET_BUSY', 'Wallet is busy, retry with the same Idempotency-Key');
      }
      if (error instanceof DeadlockException || error instanceof ConnectionException) {
        throw new TransientError('TRANSIENT_FAILURE', 'Temporary failure, retry with the same Idempotency-Key');
      }
      throw error;
    } finally {
      metrics.observe('wager_processing_seconds', (performance.now() - startedAt) / 1000);
    }
  }

  private async executeOnce(command: WagerCommand, inbox?: InboxRef): Promise<WagerResult> {
    const hash = wagerPayloadHash(command);

    // Fast paths for duplicates: no lock needed to replay a stored result.
    const em = this.em.fork();
    if (inbox) {
      const seen = await em.findOne(InboxMessage, { messageId: inbox.messageId });
      const seenTx = seen?.transactionId ? await em.findOne(WagerTransaction, { id: seen.transactionId }) : null;
      if (seenTx) return { replayed: true, transaction: await toTransactionView(em, seenTx) };
    }
    const existing = await this.findExisting(em, command, hash);
    if (existing) return existing;

    try {
      return await this.em.fork().transactional((tx) => this.processLocked(tx, command, hash, inbox));
    } catch (error) {
      // Two identical requests raced past every check (e.g. wallet does not
      // exist, so there was no row to lock): the unique index decided, so the
      // loser simply replays the winner's result.
      if (error instanceof UniqueConstraintViolationException) {
        const replay = await this.findExisting(this.em.fork(), command, hash);
        if (replay) return replay;
      }
      throw error;
    }
  }

  private async processLocked(
    em: EntityManager,
    command: WagerCommand,
    hash: string,
    inbox?: InboxRef,
  ): Promise<WagerResult> {
    await em.execute(`set local lock_timeout = '${WALLET_LOCK_TIMEOUT}'`);

    const wallet = await em.findOne(
      Wallet,
      { playerId: command.playerId, currency: command.currency },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    // Re-check now that we are serialized on this wallet: a concurrent
    // duplicate may have committed while we were waiting for the lock.
    const replay = await this.findExisting(em, command, hash);
    if (replay) return replay;

    const now = new Date();
    const tx = WagerTransaction.create(
      {
        idempotencyKey: command.idempotencyKey,
        payloadHash: hash,
        provider: command.provider,
        externalId: command.externalId,
        kind: command.kind,
        playerId: command.playerId,
        currency: command.currency,
        roundId: command.roundId,
        amount: command.amount,
        referenceExternalId: command.referenceExternalId,
        walletId: wallet?.id ?? null,
      },
      now,
    );

    const decision = await settleTransaction(em, tx, wallet, now);
    if (inbox) {
      em.persist(InboxMessage.record(inbox.messageId, inbox.source, tx.id, now));
      await em.flush();
    }
    logger.info(
      {
        transactionId: tx.id,
        walletId: tx.walletId,
        provider: tx.provider,
        kind: tx.kind,
        status: decision.status,
        failureCode: tx.failureCode,
      },
      'wager transaction settled',
    );
    return { replayed: false, transaction: await toTransactionView(em, tx) };
  }

  /**
   * Idempotency is checked on two keys:
   * - Idempotency-Key: same key + different payload = conflict.
   * - (provider, externalId): the provider's own identity for the operation;
   *   a retry with a new key but the same payload is still a replay.
   */
  private async findExisting(em: EntityManager, command: WagerCommand, hash: string): Promise<WagerResult | null> {
    const byKey = await em.findOne(WagerTransaction, { idempotencyKey: command.idempotencyKey });
    if (byKey) return this.replayOrConflict(em, byKey, hash, 'IDEMPOTENCY_KEY_REUSED');

    const byExternalId = await em.findOne(WagerTransaction, {
      provider: command.provider,
      externalId: command.externalId,
    });
    if (byExternalId) return this.replayOrConflict(em, byExternalId, hash, 'EXTERNAL_ID_REUSED');
    return null;
  }

  private async replayOrConflict(
    em: EntityManager,
    tx: WagerTransaction,
    hash: string,
    conflictCode: string,
  ): Promise<WagerResult> {
    if (tx.payloadHash !== hash) {
      throw new IdempotencyConflictError(conflictCode, 'This key was already used with a different payload');
    }
    logger.info({ transactionId: tx.id, walletId: tx.walletId, provider: tx.provider }, 'duplicate wager replayed');
    return { replayed: true, transaction: await toTransactionView(em, tx) };
  }
}
