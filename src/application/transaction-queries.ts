import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { WagerTransaction } from '../entities/wager-transaction.entity';
import { NotFoundError, ValidationError } from './errors';
import { toTransactionView } from './views';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TransactionQueries {
  constructor(private readonly em: EntityManager) {}

  async byId(id: string) {
    const em = this.em.fork();
    const tx = UUID.test(id) ? await em.findOne(WagerTransaction, { id }) : null;
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    return toTransactionView(em, tx);
  }

  async byExternalId(provider: string | undefined, externalId: string | undefined) {
    if (!provider || !externalId) {
      throw new ValidationError('INVALID_QUERY', 'provider and externalId query parameters are required');
    }
    const em = this.em.fork();
    const tx = await em.findOne(WagerTransaction, { provider, externalId });
    if (!tx) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transaction not found');
    return toTransactionView(em, tx);
  }
}
