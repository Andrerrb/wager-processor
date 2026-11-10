import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { IdempotencyConflictError, ValidationError } from '../application/errors';
import { ProcessWagerTransaction } from '../application/process-wager';
import { isPlainObject, parseWagerCommand, type WagerCommand } from '../application/wager-command';
import { config } from '../infra/config';
import { logger } from '../infra/logger';
import { metrics } from '../infra/metrics';
import { runWithContext } from '../infra/request-context';

export type HandleOutcome = 'acked' | 'retry' | 'dead-lettered';

/**
 * Consumes wager-transactions.fifo. Message body = the HTTP payload plus
 * an `idempotencyKey` field.
 *
 * Error classification:
 * - business rejection (REJECTED transaction): it is a valid outcome -> ack
 * - permanent (invalid message, idempotency conflict) -> DLQ + ack
 * - transient / unknown (DB down, lock timeout) -> no ack; the message comes
 *   back after a growing visibility timeout, and SQS redrive moves it to the
 *   DLQ after maxReceiveCount deliveries.
 *
 * The ack (DeleteMessage) only happens after the SQL commit. If the process
 * dies between commit and ack, the redelivered message hits the inbox (or
 * the idempotency key) and is acked without being applied twice.
 */
@Injectable()
export class SqsConsumer {
  constructor(
    private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransaction,
  ) {}

  /** One long poll. Returns how many messages were received. */
  async pollOnce(signal?: AbortSignal, waitSeconds = 10): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: config.sqs.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      signal ? { abortSignal: signal } : {},
    );
    const messages = response.Messages ?? [];
    // Sequential on purpose: FIFO groups must be handled in order.
    for (const message of messages) await this.handle(message);
    return messages.length;
  }

  async handle(message: Message): Promise<HandleOutcome> {
    const messageId = message.MessageId ?? 'unknown';
    return runWithContext({ correlationId: messageId, messageId }, async () => {
      let command: WagerCommand;
      try {
        const body: unknown = JSON.parse(message.Body ?? '');
        if (!isPlainObject(body)) throw new ValidationError('INVALID_MESSAGE', 'Message body must be a JSON object');
        const { idempotencyKey, ...payload } = body;
        command = parseWagerCommand(payload, idempotencyKey);
      } catch (error) {
        const reason = error instanceof ValidationError ? error.code : 'INVALID_JSON';
        await this.deadLetter(message, reason);
        return 'dead-lettered';
      }

      try {
        const result = await this.processWager.execute(command, { messageId, source: 'sqs' });
        await this.ack(message);
        logger.info(
          { transactionId: result.transaction.id, walletId: result.transaction.walletId, provider: command.provider, status: result.transaction.status, replayed: result.replayed },
          'queue message processed',
        );
        return 'acked';
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          await this.deadLetter(message, error.code);
          return 'dead-lettered';
        }
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
        metrics.inc('wager_queue_retries_total');
        logger.warn({ err: error, receiveCount }, 'transient failure, message will be redelivered');
        await this.sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: config.sqs.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: Math.min(2 ** receiveCount, 60),
            }),
          )
          .catch(() => undefined);
        return 'retry';
      }
    });
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: config.sqs.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async deadLetter(message: Message, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: config.sqs.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: { reason: { DataType: 'String', StringValue: reason } },
      }),
    );
    await this.ack(message);
    metrics.inc('wager_dlq_total', { reason });
    logger.warn({ reason }, 'message moved to dead-letter queue');
  }
}
