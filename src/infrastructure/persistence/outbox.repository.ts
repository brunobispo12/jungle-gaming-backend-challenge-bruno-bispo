import type { EntityManager } from '@mikro-orm/postgresql';

import type { IntegrationEvent } from '@/application/events/integration-event';
import type { OutboxRepository } from '@/application/ports';
import { outboxMessageSchema, type OutboxMessageRow } from './rows';

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(events: readonly IntegrationEvent<unknown>[], now: Date): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const rows: OutboxMessageRow[] = events.map((event) => ({
      id: event.eventId,
      eventId: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      // The event freezes its own data; the driver mutates the params it receives.
      payload: structuredClone(event.toJSON()) as unknown as Record<string, unknown>,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: now,
      claimedBy: null,
      claimedUntil: null,
      lastError: null,
      publishedAt: null,
      abandonedAt: null,
    }));

    await this.em.insertMany(outboxMessageSchema, rows);
  }
}
