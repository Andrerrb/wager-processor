import { EntityManager } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PendingReferenceWorker } from '../../src/workers/pending-reference.worker';
import { type Client, client, createWallet, expectConsistent, startApp, uid, wager } from './helpers';

let app: INestApplication;
let api: Client;

beforeAll(async () => {
  const started = await startApp();
  app = started.app;
  api = client(started.url);
});
afterAll(async () => app.close());

describe('wagering (real PostgreSQL)', () => {
  test('balance race: 100.00 and two concurrent 80.00 bets -> one processed, one rejected, 20.00, one debit', async () => {
    const player = uid('race');
    const walletId = await createWallet(api, player, '100.00');

    const results = await Promise.all([
      api.post('/wagering/transactions', wager(player, 'race-a', '80.00'), uid('race-a')),
      api.post('/wagering/transactions', wager(player, 'race-b', '80.00'), uid('race-b')),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.status === 422)!.body.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    const wallet = await api.get(`/wallets/${walletId}`);
    expect(wallet.body.balance).toBe('20.00');
    const ledger = await api.get(`/wallets/${walletId}/ledger`);
    expect(ledger.body.items.filter((e: any) => e.direction === 'DEBIT')).toHaveLength(1);
    await expectConsistent(api, walletId);
  });

  test('50 identical bets in parallel -> exactly one debit, 49 replays', async () => {
    const player = uid('dup');
    const walletId = await createWallet(api, player, '100.00');
    const body = wager(player, 'dup-bet', '1.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => api.post('/wagering/transactions', body, uid('dup-key'))));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && r.body.replayed)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transaction.id)).size).toBe(1);
    expect((await api.get(`/wallets/${walletId}`)).body.balance).toBe('99.00');
    await expectConsistent(api, walletId);
  });

  test('same key with a different payload is a 409 conflict, not a replay', async () => {
    const player = uid('conflict');
    await createWallet(api, player, '10.00');
    expect((await api.post('/wagering/transactions', wager(player, 'c1', '1.00'), uid('c1'))).status).toBe(201);
    const conflict = await api.post('/wagering/transactions', wager(player, 'c1', '2.00'), uid('c1'));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('parallel wallets do not block or corrupt each other', async () => {
    const players = Array.from({ length: 10 }, (_, i) => uid(`par-${i}`));
    const walletIds = await Promise.all(players.map((p) => createWallet(api, p, '50.00')));

    await Promise.all(
      players.flatMap((player, w) =>
        Array.from({ length: 10 }, (_, i) =>
          api.post('/wagering/transactions', wager(player, `par-${w}-${i}`, '7.00'), uid(`par-${w}-${i}`)),
        ),
      ),
    );

    for (const walletId of walletIds) {
      const wallet = (await api.get(`/wallets/${walletId}`)).body;
      expect(wallet.balance).toBe('1.00'); // 7 bets of 7.00 fit in 50.00, the other 3 are rejected
      await expectConsistent(api, walletId);
    }
  });

  test('reversal before its reference: PENDING_REFERENCE, then processed by the retry worker', async () => {
    const player = uid('early');
    const walletId = await createWallet(api, player, '100.00');

    const early = await api.post(
      '/wagering/transactions',
      wager(player, 'early-refund', '30.00', { kind: 'REFUND', referenceExternalId: uid('late-bet') }),
      uid('early-refund'),
    );
    expect(early.status).toBe(202);
    expect(early.body.transaction.status).toBe('PENDING_REFERENCE');

    expect((await api.post('/wagering/transactions', wager(player, 'late-bet', '30.00'), uid('late-bet'))).status).toBe(201);
    expect((await api.get(`/wallets/${walletId}`)).body.balance).toBe('70.00');

    await Bun.sleep(1_100); // first backoff step is 1s
    await app.get(PendingReferenceWorker).runOnce();

    const refund = await api.get(`/wagering/transactions/${early.body.transaction.id}`);
    expect(refund.body.status).toBe('PROCESSED');
    expect((await api.get(`/wallets/${walletId}`)).body.balance).toBe('100.00');
    await expectConsistent(api, walletId);
  });

  test('reversal rules: no double reversal, no partial refund, negative reversal rejected with its own code', async () => {
    const player = uid('rules');
    const walletId = await createWallet(api, player, '10.00');
    const post = (id: string, amount: string, extra = {}) =>
      api.post('/wagering/transactions', wager(player, id, amount, extra), uid(id));

    expect((await post('r-bet', '10.00')).status).toBe(201);
    expect((await post('r-refund', '10.00', { kind: 'REFUND', referenceExternalId: uid('r-bet') })).status).toBe(201);
    const twice = await post('r-rollback', '10.00', { kind: 'ROLLBACK', referenceExternalId: uid('r-bet') });
    expect(twice.body.transaction.failureCode).toBe('REFERENCE_ALREADY_REVERSED');

    expect((await post('r-bet2', '4.00')).status).toBe(201);
    const partial = await post('r-partial', '1.00', { kind: 'REFUND', referenceExternalId: uid('r-bet2') });
    expect(partial.body.transaction.failureCode).toBe('AMOUNT_MISMATCH');

    expect((await post('r-win', '50.00', { kind: 'WIN' })).status).toBe(201); // 56.00
    expect((await post('r-spend', '56.00')).status).toBe(201); // 0.00
    const negative = await post('r-rb-win', '50.00', { kind: 'ROLLBACK', referenceExternalId: uid('r-win') });
    expect(negative.status).toBe(422);
    expect(negative.body.transaction.failureCode).toBe('INSUFFICIENT_FUNDS_FOR_REVERSAL');
    expect((await api.get(`/wallets/${walletId}`)).body.balance).toBe('0.00');
    await expectConsistent(api, walletId);
  });

  test('atomicity: wallet, OPENING, ledger and outbox are written in the same commit', async () => {
    const player = uid('atomic');
    const walletId = await createWallet(api, player, '25.00');
    const em = app.get(EntityManager).fork();
    const [counts] = (await em.execute(
      `select
         (select count(*) from wager_transactions where wallet_id = ? and kind = 'OPENING' and status = 'PROCESSED') as openings,
         (select count(*) from ledger_entries where wallet_id = ?) as entries,
         (select count(*) from outbox_events where aggregate_id = ?) as balance_events`,
      [walletId, walletId, walletId],
    )) as Array<Record<string, string>>;
    expect(Number(counts!.openings)).toBe(1);
    expect(Number(counts!.entries)).toBe(1);
    expect(Number(counts!.balance_events)).toBe(1);
    await expectConsistent(api, walletId);
  });

  test('the database itself rejects ledger mutation and negative balances', async () => {
    const em = app.get(EntityManager).fork();
    await expect(
      em.execute('update ledger_entries set amount = amount where id = (select min(id) from ledger_entries)'),
    ).rejects.toThrow(/append-only/);
    await expect(em.execute(`update wallets set balance = -1 where id = (select id from wallets limit 1)`)).rejects.toThrow(
      /balance_check/,
    );
  });
});
