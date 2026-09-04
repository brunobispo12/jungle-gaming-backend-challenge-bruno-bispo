import { LockMode, MikroORM, raw } from '@mikro-orm/postgresql';

import type { OutboxClaim, OutboxClaimRepository } from '@/application/ports';
import { outboxMessageSchema } from './rows';

export class MikroOutboxClaimRepository implements OutboxClaimRepository {
  constructor(private readonly orm: MikroORM) {}

  // FOR UPDATE SKIP LOCKED, so a publisher racing for the same row moves to the
  // next one instead of blocking behind a lease it would fail to take anyway.
  async claim(publisherId: string, now: Date, leaseUntil: Date): Promise<OutboxClaim | undefined> {
    return this.orm.em.fork().transactional(async (em) => {
      const row = await em.findOne(
        outboxMessageSchema,
        {
          publishedAt: null,
          nextAttemptAt: { $lte: now },
          $or: [{ claimedUntil: null }, { claimedUntil: { $lte: now } }],
        },
        {
          orderBy: { occurredAt: 'asc', id: 'asc' },
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
          refresh: true,
        },
      );

      if (row === null) {
        return undefined;
      }

      await em.nativeUpdate(
        outboxMessageSchema,
        { id: row.id },
        { claimedBy: publisherId, claimedUntil: leaseUntil },
      );

      return {
        id: row.id,
        eventId: row.eventId,
        eventType: row.eventType,
        aggregateId: row.aggregateId,
        payload: row.payload,
        attempts: row.attempts,
      };
    });
  }

  async markPublished(id: string, publisherId: string, publishedAt: Date): Promise<boolean> {
    const affected = await this.orm.em
      .fork()
      .nativeUpdate(
        outboxMessageSchema,
        { id, claimedBy: publisherId },
        { publishedAt, claimedBy: null, claimedUntil: null },
      );

    return affected === 1;
  }

  async reschedule(
    id: string,
    publisherId: string,
    nextAttemptAt: Date,
    lastError: string,
  ): Promise<boolean> {
    const affected = await this.orm.em.fork().nativeUpdate(
      outboxMessageSchema,
      { id, claimedBy: publisherId },
      {
        attempts: raw('attempts + 1') as unknown as number,
        nextAttemptAt,
        lastError,
        claimedBy: null,
        claimedUntil: null,
      },
    );

    return affected === 1;
  }
}
