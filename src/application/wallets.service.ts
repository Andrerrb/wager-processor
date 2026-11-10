import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { InvalidMoneyError, Money } from '../domain/money';
import { INTERNAL_PROVIDER } from '../domain/wager';
import { LedgerEntry } from '../entities/ledger-entry.entity';
import { WagerTransaction } from '../entities/wager-transaction.entity';
import { Wallet } from '../entities/wallet.entity';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { settleTransaction } from './settlement';
import { toLedgerEntryView, toWalletView } from './views';
import { isPlainObject, type WagerCommand, wagerPayloadHash } from './wager-command';

const PLAYER_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE = 100;

export interface CreateWalletCommand {
  playerId: string;
  currency: string;
  initialBalance: Money | null;
}

export function parseCreateWallet(body: unknown): CreateWalletCommand {
  if (!isPlainObject(body)) throw new ValidationError('INVALID_PAYLOAD', 'Body must be a JSON object');
  const errors: Record<string, string> = {};
  for (const key of Object.keys(body)) {
    if (!['playerId', 'currency', 'initialBalance'].includes(key)) errors[key] = 'unknown field';
  }
  if (typeof body.playerId !== 'string' || !PLAYER_ID.test(body.playerId)) {
    errors.playerId = 'must match [A-Za-z0-9._:-]{1,128}';
  }
  let currency: string | null = null;
  try {
    currency = Money.parseCurrency(body.currency);
  } catch {
    errors.currency = 'must be an ISO 4217 code such as "BRL"';
  }
  let initialBalance: Money | null = null;
  if (body.initialBalance !== undefined && currency !== null) {
    try {
      initialBalance = Money.of(body.initialBalance, currency);
    } catch (error) {
      errors.initialBalance = error instanceof InvalidMoneyError ? error.message : 'invalid amount';
    }
  }
  if (Object.keys(errors).length > 0) throw new ValidationError('INVALID_PAYLOAD', 'Invalid wallet payload', errors);
  return { playerId: body.playerId as string, currency: currency!, initialBalance };
}

/** Opaque cursor: base64url of the last ledger entry id seen. */
function encodeCursor(lastId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, after: lastId })).toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (isPlainObject(parsed) && parsed.v === 1 && typeof parsed.after === 'string' && /^\d{1,19}$/.test(parsed.after)) {
      return parsed.after;
    }
  } catch {
    // fall through
  }
  throw new ValidationError('INVALID_CURSOR', 'Cursor is invalid');
}

@Injectable()
export class WalletsService {
  constructor(private readonly em: EntityManager) {}

  /**
   * Creates the wallet and, if an initial balance is given, an OPENING
   * transaction + ledger entry + outbox events in the SAME SQL transaction.
   * The wallet starts at version 1 with balance 0; the opening credit moves
   * it to version 2, keeping "version - 1 = ledger entries" always true.
   */
  async create(command: CreateWalletCommand) {
    try {
      return await this.em.fork().transactional(async (em) => {
        const now = new Date();
        const wallet = Wallet.open(command.playerId, command.currency, now);
        em.persist(wallet);
        await em.flush();

        if (command.initialBalance && !command.initialBalance.isZero()) {
          const opening: WagerCommand = {
            idempotencyKey: `opening:${wallet.id}`,
            provider: INTERNAL_PROVIDER,
            externalId: `opening:${wallet.id}`,
            kind: 'OPENING',
            playerId: wallet.playerId,
            currency: wallet.currency,
            roundId: null,
            amount: command.initialBalance,
            referenceExternalId: null,
          };
          const tx = WagerTransaction.create(
            { ...opening, payloadHash: wagerPayloadHash(opening), walletId: wallet.id },
            now,
          );
          await settleTransaction(em, tx, wallet, now);
        }
        return toWalletView(wallet);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictError('WALLET_ALREADY_EXISTS', 'This player already has a wallet in this currency');
      }
      throw error;
    }
  }

  async get(walletId: string) {
    return toWalletView(await this.findOrFail(walletId));
  }

  async ledger(walletId: string, cursor: string | undefined, limitParam: string | undefined) {
    const limit = limitParam === undefined ? 50 : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw new ValidationError('INVALID_LIMIT', `limit must be an integer between 1 and ${MAX_PAGE}`);
    }
    const after = cursor ? decodeCursor(cursor) : null;
    const em = this.em.fork();
    await this.findOrFail(walletId, em);

    const rows = await em.find(
      LedgerEntry,
      { walletId, ...(after ? { id: { $gt: after } } : {}) },
      { orderBy: { id: 'asc' }, limit: limit + 1 },
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toLedgerEntryView),
      nextCursor: rows.length > limit && last ? encodeCursor(last.id) : null,
    };
  }

  private async findOrFail(walletId: string, em: EntityManager = this.em.fork()): Promise<Wallet> {
    const wallet = UUID.test(walletId) ? await em.findOne(Wallet, { id: walletId }) : null;
    if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', 'Wallet not found');
    return wallet;
  }
}
