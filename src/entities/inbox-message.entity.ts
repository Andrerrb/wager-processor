import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

/** Persistent dedup of queue deliveries (SQS is at-least-once). */
@Entity({ tableName: 'inbox_messages' })
export class InboxMessage {
  @PrimaryKey({ type: 'string' })
  messageId!: string;

  @Property({ type: 'string' })
  source!: string;

  @Property({ type: 'uuid', nullable: true })
  transactionId!: string | null;

  @Property({ type: 'datetime' })
  receivedAt!: Date;

  static record(messageId: string, source: string, transactionId: string, now = new Date()): InboxMessage {
    const row = new InboxMessage();
    row.messageId = messageId;
    row.source = source;
    row.transactionId = transactionId;
    row.receivedAt = now;
    return row;
  }
}
