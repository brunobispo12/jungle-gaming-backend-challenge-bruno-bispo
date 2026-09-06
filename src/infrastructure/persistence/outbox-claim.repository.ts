import { MikroORM, raw } from '@mikro-orm/postgresql';

import type { OutboxClaim, OutboxClaimRepository } from '@/application/ports';
import { outboxMessageSchema } from './rows';

interface ClaimableRow {
  id: string;
  event_id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

// The NOT EXISTS holds a FIFO group behind its oldest pending message: without
// it two publishers send the same wallet out of order, and MessageGroupId stops
// meaning anything.
const CLAIMABLE_SQL = `
  SELECT m.id, m.event_id, m.event_type, m.aggregate_id, m.payload, m.attempts
  FROM outbox_message m
  WHERE m.published_at IS NULL
    AND m.abandoned_at IS NULL
    AND m.next_attempt_at <= ?
    AND (m.claimed_until IS NULL OR m.claimed_until <= ?)
    AND NOT EXISTS (
      SELECT 1
      FROM outbox_message older
      WHERE older.aggregate_id = m.aggregate_id
        AND older.published_at IS NULL
        AND older.abandoned_at IS NULL
        AND (older.occurred_at, older.id) < (m.occurred_at, m.id)
    )
  ORDER BY m.occurred_at ASC, m.id ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
`;

export class MikroOutboxClaimRepository implements OutboxClaimRepository {
  constructor(private readonly orm: MikroORM) {}

  async claim(publisherId: string, now: Date, leaseUntil: Date): Promise<OutboxClaim | undefined> {
    return this.orm.em.fork().transactional(async (em) => {
      const [row] = await em.getConnection().execute<ClaimableRow[]>(
        CLAIMABLE_SQL,
        [now, now],
        'all',
        em.getTransactionContext(),
      );

      if (row === undefined) {
        return undefined;
      }

      await em.nativeUpdate(
        outboxMessageSchema,
        { id: row.id },
        { claimedBy: publisherId, claimedUntil: leaseUntil },
      );

      return {
        id: row.id,
        eventId: row.event_id,
        eventType: row.event_type,
        aggregateId: row.aggregate_id,
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

  async abandon(
    id: string,
    publisherId: string,
    abandonedAt: Date,
    lastError: string,
  ): Promise<boolean> {
    const affected = await this.orm.em
      .fork()
      .nativeUpdate(
        outboxMessageSchema,
        { id, claimedBy: publisherId },
        { abandonedAt, lastError, claimedBy: null, claimedUntil: null },
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
