import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { WALLET_LOCK_TIMEOUT } from '../application/process-wager';
import { settleTransaction } from '../application/settlement';
import { WagerTransaction } from '../entities/wager-transaction.entity';
import { Wallet } from '../entities/wallet.entity';
import { logger } from '../infra/logger';
import { metrics } from '../infra/metrics';

/**
 * Re-evaluates REFUND/ROLLBACK transactions whose reference had not arrived.
 * Backoff and the attempt limit live in the domain retry policy; after the
 * last attempt the transaction is REJECTED with REFERENCE_NOT_FOUND.
 *
 * Safe with many instances: each retry locks the wallet and re-reads the
 * transaction, so only one instance acts on a given due attempt.
 */
@Injectable()
export class PendingReferenceWorker {
  constructor(private readonly em: EntityManager) {}

  /** Returns how many due transactions were found. */
  async runOnce(limit = 20): Promise<number> {
    const due = (await this.em.fork().execute(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_attempt_at <= now()
        order by next_attempt_at limit ${Number(limit)}`,
    )) as Array<{ id: string }>;

    for (const { id } of due) {
      try {
        await this.retry(id);
      } catch (error) {
        logger.warn({ err: error, transactionId: id }, 'pending reference retry failed, will try again');
      }
    }
    return due.length;
  }

  private async retry(id: string): Promise<void> {
    await this.em.fork().transactional(async (em) => {
      await em.execute(`set local lock_timeout = '${WALLET_LOCK_TIMEOUT}'`);
      const peek = await em.findOne(WagerTransaction, { id });
      if (!peek?.walletId || peek.status !== 'PENDING_REFERENCE') return;

      const wallet = await em.findOne(Wallet, { id: peek.walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      // Re-read under the wallet lock: another instance may have handled it meanwhile.
      const tx = await em.findOne(WagerTransaction, { id }, { refresh: true });
      const now = new Date();
      if (!tx || tx.status !== 'PENDING_REFERENCE' || (tx.nextAttemptAt && tx.nextAttemptAt > now)) return;

      metrics.inc('wager_reference_retries_total');
      const decision = await settleTransaction(em, tx, wallet, now);
      if (decision.status !== 'PENDING_REFERENCE') metrics.inc('wager_transactions_total', { status: decision.status });
      logger.info(
        { transactionId: tx.id, walletId: tx.walletId, provider: tx.provider, status: tx.status, attempts: tx.attempts },
        'pending reference re-evaluated',
      );
    });
  }
}
