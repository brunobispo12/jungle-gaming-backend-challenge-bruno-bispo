import type { EntityManager } from '@mikro-orm/postgresql';

import type { InboxKey, InboxMessage, InboxRepository } from '@/application/ports';
import { inboxMessageSchema, type InboxMessageRow } from './rows';
import { StaleWriteError } from './stale-write-error';

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  // A concurrent delivery of the same messageId blocks here until the other
  // transaction ends, so the loser always sees the winner's committed row.
  async reserve(message: InboxMessage): Promise<InboxMessage | undefined> {
    const inserted = await this.em
      .createQueryBuilder(inboxMessageSchema)
      .insert(toRow(message))
      .onConflict()
      .ignore()
      .returning('*')
      .execute<InboxMessageRow[]>('all');

    return inserted[0] ? toMessage(inserted[0]) : undefined;
  }

  async find(key: InboxKey): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(inboxMessageSchema, { ...key }, { refresh: true });
    return row ? toMessage(row) : undefined;
  }

  async markProcessed(key: InboxKey, processedAt: Date): Promise<void> {
    const affected = await this.em.nativeUpdate(inboxMessageSchema, { ...key }, { processedAt });

    if (affected !== 1) {
      throw new StaleWriteError(
        'inbox_message',
        `${key.consumerName}/${key.providerId}/${key.messageId}`,
        affected,
      );
    }
  }
}

function toRow(message: InboxMessage): InboxMessageRow {
  return {
    consumerName: message.consumerName,
    providerId: message.providerId,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    brokerMessageId: message.brokerMessageId ?? null,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

function toMessage(row: InboxMessageRow): InboxMessage {
  return {
    consumerName: row.consumerName,
    providerId: row.providerId,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    brokerMessageId: row.brokerMessageId ?? undefined,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  };
}
