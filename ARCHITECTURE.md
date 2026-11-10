# Architecture

A wagering transaction processor whose first priority is financial correctness under at-least-once delivery, concurrency and crashes. The general rule: **every invariant that matters is enforced by PostgreSQL**, and the application code is written so that it never has to rely on luck.

## Layout

```
src/
  domain/        Pure rules, no I/O: Money, decide(), retry policy, events, failure codes
  entities/      MikroORM entities (Wallet, WagerTransaction, LedgerEntry, OutboxEvent, InboxMessage)
  application/   Use cases: process wager, settle, wallets, reconciliation, validation
  http/          Controllers, error→status mapping, correlation id, auth extension point
  workers/       SQS consumer, outbox publisher, PENDING_REFERENCE retry worker
  infra/         Config, logger, metrics, SQS client, worker loop
  migrations/    Reversible SQL migrations
test/integration Real PostgreSQL + LocalStack SQS, no mocks
```

`decide()` (domain) answers *what should happen* to a transaction given the wallet and the reference. `settleTransaction()` (application) persists that answer: status, balance, ledger entry and outbox events. HTTP, the queue consumer, wallet opening and the retry worker all go through these two functions, so there is a single implementation of the rules.

## Money

`Money` stores amounts as a `bigint` number of cents. Input and output are decimal strings with scale 2 (`"10.00"`), which is also how PostgreSQL returns `NUMERIC(18,2)`. Numbers are rejected at the boundary (`"amount": 10` → 400), so there is no floating-point arithmetic anywhere. Operations between currencies throw.

## Data model and database guarantees

| Guarantee | Enforcement |
|---|---|
| No negative balance | `CHECK (balance >= 0)` on `wallets` |
| No duplicated debit/credit | `UNIQUE (wallet_id, transaction_id)` on `ledger_entries` |
| One ledger entry per balance change | `UNIQUE (wallet_id, wallet_version)` |
| Ledger is auditable | trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` on `ledger_entries` |
| Idempotency | `UNIQUE (idempotency_key)` and `UNIQUE (provider, external_id)` |
| One reversal per reference and kind | partial unique index on `(reference_transaction_id, kind) WHERE status = 'PROCESSED'` |
| Terminal transactions are final | trigger rejects updates once `PROCESSED / REJECTED / FAILED`, and changes to identity fields |
| Queue dedup | primary key on `inbox_messages.message_id` |

**Wallet version.** A wallet is created at version 1 with balance 0. An initial balance is applied as an `OPENING` transaction in the same SQL transaction, moving it to version 2. So `version - 1 = number of ledger entries` always, which reconciliation checks.

Rejected transactions and `LOSS` produce no ledger entry and do not change the version.

## Concurrency

**Strategy: pessimistic row lock on the wallet** (`SELECT ... FOR UPDATE`), inside the same SQL transaction that reads the balance, decides and writes.

- The unit of concurrency is the wallet: writers on the same wallet are serialized, writers on different wallets run in parallel. There is no global lock.
- The lock lives in PostgreSQL, so it is correct with any number of application instances.
- A transaction touches exactly one wallet, so there is no lock-ordering problem and no deadlock between wallets.
- `lock_timeout = 5s`: a request that waits too long fails with 503 `WALLET_BUSY` (retry with the same key) instead of piling up.

Why not optimistic locking? Wallets in a casino are hot: the same player fires many bets per second. Under contention optimistic locking turns into retry storms, while a row lock simply queues writers. The read-calculate-update is safe because it happens under the lock, and the `CHECK` and `UNIQUE (wallet_id, wallet_version)` constraints are a second line of defense if a bug ever bypasses it.

The required scenario (balance 100.00, two concurrent 80.00 bets) is covered by an integration test: the second bet waits for the lock, then sees 20.00 and is rejected with `INSUFFICIENT_FUNDS`.

## Idempotency

`POST /wagering/transactions` requires an `Idempotency-Key`. The payload is normalized (amount `"10"` → `"10.00"`), serialized as canonical JSON (sorted keys) and hashed with SHA-256.

Two identities are checked:
- **Idempotency-Key**: same key and same hash → the stored result is returned (200, `replayed: true`). Same key and different hash → 409 `IDEMPOTENCY_KEY_REUSED`.
- **(provider, externalId)**: a provider retrying the same operation with a new key gets a replay too, and a different payload is a 409 `EXTERNAL_ID_REUSED`.

Checks happen before the lock (cheap fast path) and again after acquiring it (a concurrent duplicate may have committed meanwhile). When there is no row to lock (unknown wallet), the unique indexes decide and the loser replays the winner's result. Nothing is kept in memory.

A replay returns the original result, including `balanceAfter` taken from the immutable ledger entry, not the current balance.

## Business rules

- `REFUND` can only reverse a `BET`; `ROLLBACK` can reverse a `BET`, `WIN` or `REFUND`.
- The reference must match provider, player, wallet, currency and round; amounts must match exactly.
- **Decision beyond the statement:** once a transaction has *any* processed reversal, it cannot be reversed again. The statement says "once per operation type", which read literally would allow a `REFUND` **and** a `ROLLBACK` of the same `BET`, crediting the stake twice. A `ROLLBACK` of a `REFUND` is still allowed (it targets the refund, not the bet).
- A reversal that would make the balance negative is rejected with `INSUFFICIENT_FUNDS_FOR_REVERSAL`, distinct from `INSUFFICIENT_FUNDS`.
- A reversal whose reference has not arrived becomes `PENDING_REFERENCE`. The retry worker re-evaluates it with exponential backoff (1s, 2s, 4s… capped at 5 min) and rejects it with `REFERENCE_NOT_FOUND` after 10 attempts.

Failure codes (stable, machine-readable): `WALLET_NOT_FOUND`, `INSUFFICIENT_FUNDS`, `INSUFFICIENT_FUNDS_FOR_REVERSAL`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_MISMATCH`, `REFERENCE_NOT_REVERSIBLE`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH`.

## HTTP status contract

| Status | Meaning |
|---|---|
| 201 | Processed |
| 200 | Idempotent replay |
| 202 | Accepted, `PENDING_REFERENCE` |
| 400 | Invalid payload, header or JSON |
| 409 | Idempotency conflict |
| 422 | Business rejection (`transaction.failureCode`) |
| 503 | Transient failure (lock timeout, DB/queue down); safe to retry with the same key |

## Queue processing

`wager-transactions.fifo` carries the same payload as HTTP plus `idempotencyKey`. The consumer calls the same use case.

- **Inbox**: the SQS `MessageId` is stored in `inbox_messages` in the same SQL transaction as the financial change. A redelivered message is answered from the inbox.
- **Ack after commit**: `DeleteMessage` only runs after the commit. If the worker dies between commit and ack, the redelivery hits the inbox and is acked without re-applying (integration test).
- **Error classes**:
  - *business* (a `REJECTED` transaction) → ack, it is a valid outcome;
  - *permanent* (invalid JSON, invalid payload, idempotency conflict) → sent to `wager-transactions-dlq.fifo` with a `reason` attribute, then acked;
  - *transient / unknown* (DB down, lock timeout) → not acked, visibility timeout grows (2^receiveCount s, max 60s), and SQS redrive moves it to the DLQ after 5 receives.
- FIFO is **not** relied on for consistency: ordering only helps throughput; correctness comes from the wallet lock and idempotency.
- **Graceful shutdown**: on SIGTERM the loops stop polling, finish the message in hand and only then the DB pool closes; `/health/ready` returns 503 while shutting down.

## Outbox

Events (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) are written to `outbox_events` in the same SQL transaction as the change, so nothing is published before commit and no committed event is lost.

The publisher claims batches with `FOR UPDATE SKIP LOCKED` (safe with many concurrent publishers, tested), sends to `wager-events.fifo` (group = aggregate id, dedup id = event id) and marks them published. A crash after commit but before publish just leaves rows to be picked up later. A crash after publish but before marking re-sends the event: delivery is **at-least-once** and consumers must dedupe on `eventId`.

Events share an abstract `DomainEvent` envelope (`eventId`, `eventType`, `eventVersion`, `occurredAt`, `aggregateId`, `payload`); monetary values are decimal strings. `WalletBalanceChanged` is only emitted when the balance actually changes.

## Reconciliation

`POST /wallets/:id/reconciliation` rebuilds the balance from the ledger in one SQL statement (one consistent snapshot) and reports `BALANCE_MISMATCH`, `VERSION_MISMATCH`, `LAST_ENTRY_VERSION_MISMATCH` or `LAST_BALANCE_AFTER_MISMATCH`. It never corrects anything silently. Every integration test ends by asserting it reports no divergence.

## Observability

- **Logs**: pino JSON lines with `correlationId` (from `X-Correlation-Id` or generated), `messageId` for queue work, plus `transactionId`, `walletId`, `provider`. No payloads or balance history are logged.
- **Metrics** (`GET /metrics`, Prometheus text): transactions by status, duplicates, reference retries, queue retries, DLQ by reason, lock timeouts, outbox published, outbox lag, processing latency.
- **Health**: `/health/live` (process up, no dependencies) and `/health/ready` (DB and SQS reachable, not shutting down).

## Authentication

Optional in the challenge and **not implemented**. `src/http/auth.guard.ts` is a global guard that currently allows everything; it is where a JWT from an external provider (Keycloak, Zitadel) would be validated, keeping `/health/*` open and binding each client to the `provider` values it may submit.

## Testing

- Unit (`bun run test`): Money, Wallet invariants, every transaction kind, currency mismatch, divergent payload hashing, validation.
- Integration (`bun run test:integration`, real PostgreSQL + LocalStack): balance race, 50 identical parallel bets, 10 wallets in parallel, reversal before reference + retry worker, reversal rules, atomicity of wallet + OPENING + ledger + outbox, DB-level guards, queue processing, duplicate delivery, worker killed between commit and ack, DLQ, outbox crash recovery, two concurrent publishers, **three app instances as separate processes**, restart consistency, migrations.

## Limitations and trade-offs

- **Hot wallets serialize.** A single very hot wallet is limited by one row lock; that is the price of simple, provable correctness.
- **Outbox publishing holds a DB transaction during the SQS call.** Simple and safe, but a slow SQS slows a batch. A claim-then-publish design (lease column) would avoid it.
- **Metrics are per process** and reset on restart; a Prometheus server would aggregate them.
- **Retry worker polls** every second instead of reacting when the reference arrives; a pending reversal resolves within its backoff window.
- **Reconciliation is on demand** per wallet; a scheduled job over all wallets would be the next step.
- Migration reversibility is verified manually (`migration:down` / `migration:up`), not inside the integration suite, because `down` drops the data other tests use.
- No load test (`test:load`) was done.
