import { Entity, PrimaryKey, Property } from '@mikro-orm/core';
import type { DomainEvent, EventEnvelope } from '../domain/events';

/**
 * Written in the same SQL transaction as the financial change, published
 * later by the outbox relay. `seq` (identity column, not mapped) gives the
 * publishing order.
 */
@Entity({ tableName: 'outbox_events' })
export class OutboxEvent {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string' })
  eventType!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'json' })
  payload!: EventEnvelope;

  @Property({ type: 'datetime' })
  createdAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  publishedAt!: Date | null;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({ type: 'text', nullable: true })
  lastError!: string | null;

  static from(event: DomainEvent<object>): OutboxEvent {
    const row = new OutboxEvent();
    row.id = event.eventId;
    row.eventType = event.eventType;
    row.aggregateId = event.aggregateId;
    row.payload = event.toEnvelope();
    row.createdAt = event.occurredAt;
    row.publishedAt = null;
    row.attempts = 0;
    row.lastError = null;
    return row;
  }
}
