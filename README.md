# Wager Processor

Distributed wagering transaction processor (Jungle Gaming backend challenge).

Stack: Bun 1.x · TypeScript (strict) · NestJS · PostgreSQL 16 · MikroORM · AWS SQS (LocalStack) · Docker Compose.

Design decisions, trade-offs and limitations: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Requirements

- Docker with Docker Compose
- [Bun](https://bun.sh) 1.1+ (only to run locally or run the tests)

## Run everything with Docker

```bash
docker compose up --build
```

Starts PostgreSQL, LocalStack (with the SQS queues) and the app on `http://localhost:3000`. The app applies migrations on start.

## Run locally

```bash
bun install
cp .env.example .env
bun run infra:up          # PostgreSQL + LocalStack only
bun run migration:up
bun run dev
```

## Commands

| Command | What it does |
|---|---|
| `bun run test` | Unit tests |
| `bun run test:integration` | Integration and concurrency tests against real PostgreSQL + LocalStack (needs `infra:up`) |
| `bun run typecheck` | `tsc --noEmit` (strict) |
| `bun run migration:up` / `migration:down` / `migration:status` | Apply / revert last / list migrations |
| `bun run infra:down` | Stop containers and delete volumes |

## HTTP API

| Method | Path | Notes |
|---|---|---|
| POST | `/wallets` | `{ playerId, currency, initialBalance? }` |
| GET | `/wallets/:walletId` | |
| GET | `/wallets/:walletId/ledger?cursor=&limit=` | Opaque cursor pagination |
| POST | `/wallets/:walletId/reconciliation` | Reports divergences, never corrects |
| POST | `/wagering/transactions` | Requires `Idempotency-Key` header |
| GET | `/wagering/transactions/:id` | |
| GET | `/wagering/transactions?provider=&externalId=` | |
| GET | `/health/live`, `/health/ready` | |
| GET | `/metrics` | Prometheus text format |

`POST /wagering/transactions` answers 201 processed · 200 replay · 202 pending reference · 400 invalid · 409 idempotency conflict · 422 business rejection (`transaction.failureCode`) · 503 transient, retry with the same key.

Example:

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"p1","currency":"BRL","initialBalance":"100.00"}'

curl -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: acme-bet-1' \
  -d '{"provider":"acme","externalId":"bet-1","kind":"BET","playerId":"p1","currency":"BRL","roundId":"r1","amount":"80.00"}'
```

## Queue

Send the same payload plus `idempotencyKey` to `wager-transactions.fifo` (use the player as `MessageGroupId`):

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id p1 --message-deduplication-id m1 \
  --message-body '{"idempotencyKey":"acme-bet-2","provider":"acme","externalId":"bet-2","kind":"BET","playerId":"p1","currency":"BRL","roundId":"r1","amount":"5.00"}'
```

Invalid messages go to `wager-transactions-dlq.fifo`. Domain events are published to `wager-events.fifo`.
