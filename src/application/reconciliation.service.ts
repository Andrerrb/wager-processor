import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { Money } from '../domain/money';
import { NotFoundError } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  balance: string;
  version: number;
  currency: string;
  ledger_balance: string;
  entries: string;
  last_balance_after: string | null;
  last_version: number | null;
}

/**
 * Rebuilds the balance from the ledger and compares it with the stored one.
 * Reports divergences; never corrects anything (a human must investigate).
 * One SQL statement = one consistent snapshot, no locks taken.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly em: EntityManager) {}

  async reconcile(walletId: string) {
    if (!UUID.test(walletId)) throw new NotFoundError('WALLET_NOT_FOUND', 'Wallet not found');
    const [row] = (await this.em.fork().execute(
      `select w.balance, w.version, w.currency,
              coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as ledger_balance,
              count(l.id) as entries,
              (select balance_after from ledger_entries where wallet_id = w.id order by wallet_version desc limit 1) as last_balance_after,
              max(l.wallet_version) as last_version
         from wallets w
         left join ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    )) as Row[];
    if (!row) throw new NotFoundError('WALLET_NOT_FOUND', 'Wallet not found');

    const stored = Money.of(row.balance, row.currency);
    const entries = Number(row.entries);
    const divergences: Array<{ code: string; expected: string; actual: string }> = [];

    // A negative rebuilt balance cannot be parsed as Money: compare as text first.
    const rebuilt = normalize(row.ledger_balance);
    if (rebuilt !== stored.toString()) {
      divergences.push({ code: 'BALANCE_MISMATCH', expected: rebuilt, actual: stored.toString() });
    }
    if (row.version - 1 !== entries) {
      divergences.push({ code: 'VERSION_MISMATCH', expected: String(entries + 1), actual: String(row.version) });
    }
    if (entries > 0 && row.last_version !== row.version) {
      divergences.push({ code: 'LAST_ENTRY_VERSION_MISMATCH', expected: String(row.version), actual: String(row.last_version) });
    }
    if (row.last_balance_after !== null && normalize(row.last_balance_after) !== stored.toString()) {
      divergences.push({ code: 'LAST_BALANCE_AFTER_MISMATCH', expected: normalize(row.last_balance_after), actual: stored.toString() });
    }

    return {
      walletId,
      currency: row.currency,
      consistent: divergences.length === 0,
      storedBalance: stored.toString(),
      ledgerBalance: rebuilt,
      version: row.version,
      ledgerEntries: entries,
      divergences,
      checkedAt: new Date().toISOString(),
    };
  }
}

/** "20" / "20.5" / "-3.00" -> "20.00" / "20.50" / "-3.00" (no floats involved). */
function normalize(decimal: string): string {
  const negative = decimal.startsWith('-');
  const [int = '0', frac = ''] = decimal.replace('-', '').split('.');
  return `${negative ? '-' : ''}${BigInt(int)}.${frac.padEnd(2, '0').slice(0, 2)}`;
}
