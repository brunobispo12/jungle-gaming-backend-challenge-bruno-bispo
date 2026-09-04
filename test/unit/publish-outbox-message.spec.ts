import { describe, expect, test } from 'bun:test';

import type {
  Clock,
  EventPublisher,
  OutboxClaim,
  OutboxClaimRepository,
  PublishableMessage,
} from '@/application/ports';
import {
  outboxBackoffMs,
  PublishOutboxMessageUseCase,
} from '@/application/use-cases/publish-outbox-message';

const AT = new Date('2026-07-29T15:00:00.000Z');
const PUBLISHER_ID = 'instance-1';
const LEASE_MS = 30_000;

class FixedClock implements Clock {
  constructor(private readonly at: Date) {}

  now(): Date {
    return this.at;
  }
}

interface ClaimCall {
  readonly publisherId: string;
  readonly now: Date;
  readonly leaseUntil: Date;
}

interface PublishedCall {
  readonly id: string;
  readonly publisherId: string;
  readonly publishedAt: Date;
}

interface RescheduleCall {
  readonly id: string;
  readonly publisherId: string;
  readonly nextAttemptAt: Date;
  readonly lastError: string;
}

class FakeOutbox implements OutboxClaimRepository {
  readonly claimCalls: ClaimCall[] = [];
  readonly publishedCalls: PublishedCall[] = [];
  readonly rescheduleCalls: RescheduleCall[] = [];

  constructor(
    private readonly pending: OutboxClaim | undefined,
    private readonly leaseHeld = true,
  ) {}

  async claim(publisherId: string, now: Date, leaseUntil: Date): Promise<OutboxClaim | undefined> {
    this.claimCalls.push({ publisherId, now, leaseUntil });
    return this.pending;
  }

  async markPublished(id: string, publisherId: string, publishedAt: Date): Promise<boolean> {
    this.publishedCalls.push({ id, publisherId, publishedAt });
    return this.leaseHeld;
  }

  async reschedule(
    id: string,
    publisherId: string,
    nextAttemptAt: Date,
    lastError: string,
  ): Promise<boolean> {
    this.rescheduleCalls.push({ id, publisherId, nextAttemptAt, lastError });
    return this.leaseHeld;
  }
}

class RecordingPublisher implements EventPublisher {
  readonly sent: PublishableMessage[] = [];

  constructor(private readonly failure?: Error) {}

  async publish(message: PublishableMessage): Promise<void> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.sent.push(message);
  }
}

function pendingClaim(overrides: Partial<OutboxClaim> = {}): OutboxClaim {
  return {
    id: '0192f291-27dd-7d3f-8071-5f8685deef37',
    eventId: '0192f291-27dd-7d3f-8071-5f8685deef38',
    eventType: 'WagerTransactionProcessed',
    aggregateId: '0192f291-27dd-7d3f-8071-5f8685deef39',
    payload: { eventType: 'WagerTransactionProcessed' },
    attempts: 0,
    ...overrides,
  };
}

function useCaseOf(
  outbox: OutboxClaimRepository,
  publisher: EventPublisher,
  jitter = 0.5,
): PublishOutboxMessageUseCase {
  return new PublishOutboxMessageUseCase(
    outbox,
    publisher,
    new FixedClock(AT),
    { publisherId: PUBLISHER_ID, leaseMs: LEASE_MS },
    () => jitter,
  );
}

describe('outboxBackoffMs', () => {
  test('primeira tentativa espera um segundo sem jitter', () => {
    expect(outboxBackoffMs(1, 0.5)).toBe(1_000);
  });

  test('dobra a cada tentativa', () => {
    expect(outboxBackoffMs(2, 0.5)).toBe(2_000);
    expect(outboxBackoffMs(3, 0.5)).toBe(4_000);
    expect(outboxBackoffMs(6, 0.5)).toBe(32_000);
  });

  test('satura em sessenta segundos', () => {
    expect(outboxBackoffMs(7, 0.5)).toBe(60_000);
    expect(outboxBackoffMs(64, 0.5)).toBe(60_000);
  });

  test('aplica jitter entre 0.8x e 1.2x', () => {
    expect(outboxBackoffMs(1, 0)).toBe(800);
    expect(outboxBackoffMs(1, 1)).toBe(1_200);
    expect(outboxBackoffMs(7, 0)).toBe(48_000);
  });
});

describe('PublishOutboxMessageUseCase', () => {
  test('sem mensagem elegível não publica nada', async () => {
    const outbox = new FakeOutbox(undefined);
    const publisher = new RecordingPublisher();

    expect(await useCaseOf(outbox, publisher).run()).toBe('idle');
    expect(publisher.sent).toEqual([]);
    expect(outbox.publishedCalls).toEqual([]);
  });

  test('reclama com o lease contado a partir do relógio', async () => {
    const outbox = new FakeOutbox(undefined);

    await useCaseOf(outbox, new RecordingPublisher()).run();

    expect(outbox.claimCalls).toEqual([
      { publisherId: PUBLISHER_ID, now: AT, leaseUntil: new Date(AT.getTime() + LEASE_MS) },
    ]);
  });

  test('publica a mensagem reclamada e marca a publicação', async () => {
    const claim = pendingClaim();
    const outbox = new FakeOutbox(claim);
    const publisher = new RecordingPublisher();

    expect(await useCaseOf(outbox, publisher).run()).toBe('published');
    expect(publisher.sent).toEqual([claim]);
    expect(outbox.publishedCalls).toEqual([
      { id: claim.id, publisherId: PUBLISHER_ID, publishedAt: AT },
    ]);
    expect(outbox.rescheduleCalls).toEqual([]);
  });

  test('falha no envio agenda nova tentativa com backoff e registra o erro', async () => {
    const claim = pendingClaim({ attempts: 2 });
    const outbox = new FakeOutbox(claim);
    const publisher = new RecordingPublisher(new Error('sqs unavailable'));

    expect(await useCaseOf(outbox, publisher).run()).toBe('retry-scheduled');
    expect(outbox.publishedCalls).toEqual([]);
    expect(outbox.rescheduleCalls).toEqual([
      {
        id: claim.id,
        publisherId: PUBLISHER_ID,
        nextAttemptAt: new Date(AT.getTime() + outboxBackoffMs(3, 0.5)),
        lastError: 'sqs unavailable',
      },
    ]);
  });

  test('lease perdido durante o envio não conta como publicado', async () => {
    const outbox = new FakeOutbox(pendingClaim(), false);

    expect(await useCaseOf(outbox, new RecordingPublisher()).run()).toBe('lease-lost');
  });

  test('lease perdido ao agendar nova tentativa não conta como reagendado', async () => {
    const outbox = new FakeOutbox(pendingClaim(), false);
    const publisher = new RecordingPublisher(new Error('sqs unavailable'));

    expect(await useCaseOf(outbox, publisher).run()).toBe('lease-lost');
  });
});
