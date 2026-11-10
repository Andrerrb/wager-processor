import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '../domain/events';
import { OutboxEvent } from '../entities/outbox-event.entity';
import { config } from '../infra/config';
import { logger } from '../infra/logger';
import { metrics } from '../infra/metrics';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  payload: EventEnvelope | string;
}

/**
 * Publishes committed outbox events to the events FIFO queue.
 *
 * - Concurrent publishers (threads or instances) are safe: rows are claimed
 *   with FOR UPDATE SKIP LOCKED, so each row is handled by one publisher.
 * - Crash after commit / before publish: the row stays unpublished and is
 *   picked up by the next run.
 * - Crash after publish / before marking: the event is sent again
 *   (at-least-once). The SQS deduplication id is the event id, and consumers
 *   must dedupe on eventId anyway.
 */
@Injectable()
export class OutboxPublisher {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
  ) {}

  /** Publishes one batch and returns the ids of the events it published. */
  async runOnce(batchSize = 50): Promise<string[]> {
    return this.em.fork().transactional(async (em) => {
      const rows = (await em.execute(
        `select id, aggregate_id, payload from outbox_events
          where published_at is null
          order by seq limit ${Number(batchSize)}
          for update skip locked`,
      )) as OutboxRow[];

      const published: string[] = [];
      for (const row of rows) {
        const envelope: EventEnvelope = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: config.sqs.eventsQueueUrl,
              MessageBody: JSON.stringify(envelope),
              MessageGroupId: row.aggregate_id,
              MessageDeduplicationId: row.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: envelope.eventType } },
            }),
          );
          published.push(row.id);
        } catch (error) {
          await em.execute('update outbox_events set attempts = attempts + 1, last_error = ? where id = ?', [
            String(error).slice(0, 500),
            row.id,
          ]);
          logger.warn({ err: error, eventId: row.id }, 'outbox publish failed, will retry');
          break; // keep order: do not publish later events before this one
        }
      }

      if (published.length > 0) {
        await em.nativeUpdate(OutboxEvent, { id: { $in: published } }, { publishedAt: new Date() });
        metrics.inc('outbox_published_total', {}, published.length);
      }
      return published;
    });
  }

  async lagSeconds(): Promise<number> {
    const [row] = (await this.em.fork().execute(
      `select coalesce(extract(epoch from now() - min(created_at)), 0) as lag
         from outbox_events where published_at is null`,
    )) as Array<{ lag: string | number }>;
    return Number(row?.lag ?? 0);
  }
}
