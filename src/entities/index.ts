import { InboxMessage } from './inbox-message.entity';
import { LedgerEntry } from './ledger-entry.entity';
import { OutboxEvent } from './outbox-event.entity';
import { WagerTransaction } from './wager-transaction.entity';
import { Wallet } from './wallet.entity';

export { InboxMessage, LedgerEntry, OutboxEvent, WagerTransaction, Wallet };
export const ENTITIES = [Wallet, WagerTransaction, LedgerEntry, OutboxEvent, InboxMessage];
