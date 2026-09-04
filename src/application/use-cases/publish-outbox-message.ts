import {
  NOOP_METRICS,
  type Clock,
  type EventPublisher,
  type MetricsPort,
  type OutboxClaimRepository,
} from '@/application/ports';

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export function outboxBackoffMs(attempts: number, jitter: number): number {
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
  return Math.round(delay * (0.8 + jitter * 0.4));
}

export type OutboxPublishOutcome = 'idle' | 'published' | 'retry-scheduled' | 'lease-lost';

export interface OutboxPublisherOptions {
  readonly publisherId: string;
  readonly leaseMs: number;
}

export class PublishOutboxMessageUseCase {
  constructor(
    private readonly outbox: OutboxClaimRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: OutboxPublisherOptions,
    private readonly jitter: () => number,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {}

  async run(): Promise<OutboxPublishOutcome> {
    const claimedAt = this.clock.now();
    const claim = await this.outbox.claim(
      this.options.publisherId,
      claimedAt,
      new Date(claimedAt.getTime() + this.options.leaseMs),
    );

    if (claim === undefined) {
      return 'idle';
    }

    const startedAt = performance.now();
    try {
      try {
        await this.publisher.publish(claim);
      } catch (error: unknown) {
        const delay = outboxBackoffMs(claim.attempts + 1, this.jitter());
        const rescheduled = await this.outbox.reschedule(
          claim.id,
          this.options.publisherId,
          new Date(this.clock.now().getTime() + delay),
          error instanceof Error ? error.message : String(error),
        );
        const outcome = rescheduled ? 'retry-scheduled' : 'lease-lost';
        if (rescheduled) {
          this.metrics.recordRetry('outbox', 'publish-failed');
        }
        this.metrics.observeOutboxPublish(
          outcome,
          (performance.now() - startedAt) / 1_000,
        );
        return outcome;
      }

      // A lost lease means another publisher already owns the row and will send the
      // same eventId again. The send is at-least-once by design, so losing here is
      // a duplicate, never a lost event.
      const marked = await this.outbox.markPublished(
        claim.id,
        this.options.publisherId,
        this.clock.now(),
      );
      const outcome = marked ? 'published' : 'lease-lost';
      this.metrics.observeOutboxPublish(
        outcome,
        (performance.now() - startedAt) / 1_000,
      );

      return outcome;
    } catch (error: unknown) {
      this.metrics.observeOutboxPublish('error', (performance.now() - startedAt) / 1_000);
      throw error;
    }
  }
}
