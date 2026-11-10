import {
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ProcessWagerTransaction } from '../../src/application/process-wager';
import { parseWagerCommand } from '../../src/application/wager-command';
import { config } from '../../src/infra/config';
import { OutboxPublisher } from '../../src/workers/outbox.publisher';
import { SqsConsumer } from '../../src/workers/sqs.consumer';
import { type Client, client, createWallet, expectConsistent, startApp, uid, wager } from './helpers';

let app: INestApplication;
let api: Client;
let sqs: SQSClient;
let consumer: SqsConsumer;

const send = (body: unknown, groupId: string) =>
  sqs.send(
    new SendMessageCommand({
      QueueUrl: config.sqs.queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );

/** Polls the consumer until the queue is drained (short polls). */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if ((await consumer.pollOnce(undefined, 1)) === 0) return;
  }
}

beforeAll(async () => {
  const started = await startApp();
  app = started.app;
  api = client(started.url);
  sqs = app.get(SQSClient);
  consumer = app.get(SqsConsumer);
  for (const url of [config.sqs.queueUrl, config.sqs.dlqUrl]) await sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
});
afterAll(async () => app.close());

describe('queue processing (real LocalStack SQS)', () => {
  test('a queued BET is processed through the same use case as HTTP', async () => {
    const player = uid('q-happy');
    const walletId = await createWallet(api, player, '20.00');
    await send({ ...wager(player, 'q-bet', '5.00'), idempotencyKey: uid('q-bet') }, player);
    await drain();
    const tx = await api.get(`/wagering/transactions?provider=acme&externalId=${uid('q-bet')}`);
    expect(tx.body.status).toBe('PROCESSED');
    expect((await api.get(`/wallets/${walletId}`)).body.balance).toBe('15.00');
  });

  test('the same transaction delivered twice is applied once', async () => {
    const player = uid('q-twice');
    const walletId = await createWallet(api, player, '20.00');
    const body = { ...wager(player, 'q-twice-bet', '5.00'), idempotencyKey: uid('q-twice-bet') };
    await send(body, player);
    await send(body, player);
    await drain();
    expect((await api.get(`/wallets/${walletId}`)).body.balance).toBe('15.00');
    await expectConsistent(api, walletId);
  });

  test('worker killed between commit and ack: redelivery is acked without double debit', async () => {
    const player = uid('q-crash');
    const walletId = await createWallet(api, player, '20.00');
    await send({ ...wager(player, 'q-crash-bet', '5.00'), idempotencyKey: uid('q-crash-bet') }, player);

    // "Crashing" worker: receives, commits, and dies before DeleteMessage.
    const received = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: config.sqs.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2, VisibilityTimeout: 1 }),
    );
    const message = received.Messages![0]!;
    const { idempotencyKey, ...payload } = JSON.parse(message.Body!);
    await app.get(ProcessWagerTransaction).execute(parseWagerCommand(payload, idempotencyKey), {
      messageId: message.MessageId!,
      source: 'sqs',
    });

    // Message becomes visible again; a healthy worker picks it up.
    await Bun.sleep(1_500);
    await drain();

    expect((await api.get(`/wallets/${walletId}`)).body.balance).toBe('15.00');
    const [row] = (await app.get(EntityManager).fork().execute(
      'select count(*) as n from inbox_messages where message_id = ?',
      [message.MessageId],
    )) as Array<{ n: string }>;
    expect(Number(row!.n)).toBe(1);
    await expectConsistent(api, walletId);
  });

  test('a permanently invalid message goes to the DLQ', async () => {
    await send('{not json', uid('q-bad'));
    await send({ provider: 'acme', kind: 'BET' }, uid('q-bad'));
    await drain();
    const dead = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: config.sqs.dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, MessageAttributeNames: ['All'] }),
    );
    const reasons = (dead.Messages ?? []).map((m) => m.MessageAttributes?.reason?.StringValue);
    expect(reasons).toContain('INVALID_JSON');
    expect(reasons).toContain('INVALID_PAYLOAD');
  });
});

describe('outbox', () => {
  test('events committed but not yet published are published later (crash recovery)', async () => {
    const player = uid('ob-recovery');
    const walletId = await createWallet(api, player, '5.00');
    const em = app.get(EntityManager).fork();
    const pending = (await em.execute('select id from outbox_events where aggregate_id = ? and published_at is null', [
      walletId,
    ])) as Array<{ id: string }>;
    expect(pending.length).toBeGreaterThan(0);

    const outbox = app.get(OutboxPublisher);
    while ((await outbox.runOnce()).length > 0) {
      // drain everything
    }
    const left = (await em.execute('select id from outbox_events where aggregate_id = ? and published_at is null', [
      walletId,
    ])) as unknown[];
    expect(left).toHaveLength(0);
  });

  test('two concurrent publishers never publish the same event', async () => {
    const player = uid('ob-concurrent');
    await createWallet(api, player, '100.00');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        api.post('/wagering/transactions', wager(player, `ob-${i}`, '1.00'), uid(`ob-${i}`)),
      ),
    );

    const outbox = app.get(OutboxPublisher);
    const [a, b] = await Promise.all([outbox.runOnce(10), outbox.runOnce(10)]);
    expect(a.length + b.length).toBeGreaterThan(0);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });
});
