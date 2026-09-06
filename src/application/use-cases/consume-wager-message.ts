import { ApplicationError, ErrorCode } from '@/application/errors';
import {
  NOOP_METRICS,
  type Clock,
  type InboxKey,
  type MetricsPort,
  type Repositories,
  type UnitOfWork,
} from '@/application/ports';
import { DomainError } from '@/domain/domain-error';
import type {
  SubmitWagerCommand,
  SubmitWagerResult,
  SubmitWagerTransactionUseCase,
} from './submit-wager-transaction';

export interface InboxDelivery {
  readonly consumerName: string;
  readonly providerId: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly brokerMessageId?: string | undefined;
}

export type ConsumeOutcome =
  | { readonly kind: 'processed'; readonly result: SubmitWagerResult }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'permanent'; readonly reason: string }
  | { readonly kind: 'transient'; readonly reason: string };

const PERMANENT_CODES = new Set<ErrorCode>([
  ErrorCode.InvalidPayload,
  ErrorCode.MissingIdempotencyKey,
  ErrorCode.IdempotencyKeyConflict,
  ErrorCode.ExternalTransactionIdReused,
  ErrorCode.ReferenceRequired,
  ErrorCode.AmountNotPositive,
  ErrorCode.ReservedProviderId,
]);

export class ConsumeWagerMessageUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly submitWager: SubmitWagerTransactionUseCase,
    private readonly clock: Clock,
    private readonly isTransientFailure: (error: unknown) => boolean,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {}

  async consume(delivery: InboxDelivery, command: SubmitWagerCommand): Promise<ConsumeOutcome> {
    const startedAt = performance.now();
    try {
      const outcome = await this.unitOfWork.transactional<ConsumeOutcome>(async (repositories) => {
        const reserved = await repositories.inbox.reserve({
          ...delivery,
          receivedAt: this.clock.now(),
        });

        if (reserved === undefined) {
          return this.classifyRedelivery(repositories, delivery);
        }

        const result = await this.submitWager.executeWithin(repositories, command);
        await repositories.inbox.markProcessed(keyOf(delivery), this.clock.now());

        return { kind: 'processed', result };
      });
      this.observe(outcome, command, startedAt);
      return outcome;
    } catch (error: unknown) {
      const outcome = this.classifyFailure(error);
      this.observe(outcome, command, startedAt);
      return outcome;
    }
  }

  private observe(
    outcome: ConsumeOutcome,
    command: SubmitWagerCommand,
    startedAt: number,
  ): void {
    if (outcome.kind === 'duplicate') {
      this.metrics.recordDuplicate('inbox');
    }

    this.metrics.observeWager({
      source: 'sqs',
      kind: command.kind,
      outcome: outcome.kind === 'processed' ? outcome.result.status : outcome.kind,
      status: outcome.kind === 'processed' ? outcome.result.status : undefined,
      idempotentReplay:
        outcome.kind === 'processed' ? outcome.result.idempotentReplay : undefined,
      durationSeconds: (performance.now() - startedAt) / 1_000,
    });
  }

  private async classifyRedelivery(
    repositories: Repositories,
    delivery: InboxDelivery,
  ): Promise<ConsumeOutcome> {
    const existing = await repositories.inbox.find(keyOf(delivery));

    if (existing === undefined) {
      return { kind: 'transient', reason: 'the inbox row disappeared after a lost reservation' };
    }
    if (existing.payloadHash !== delivery.payloadHash) {
      return { kind: 'permanent', reason: 'the messageId was already delivered with another payload' };
    }
    // Reserved but never finished: the owner either crashed mid-transaction or is
    // still running. Retrying is safe; acking would drop the delivery for good.
    if (existing.processedAt === undefined) {
      return { kind: 'transient', reason: 'the inbox row is reserved but not processed' };
    }

    return { kind: 'duplicate' };
  }

  private classifyFailure(error: unknown): ConsumeOutcome {
    if (this.isTransientFailure(error)) {
      return { kind: 'transient', reason: messageOf(error) };
    }
    if (error instanceof ApplicationError) {
      return PERMANENT_CODES.has(error.code)
        ? { kind: 'permanent', reason: `${error.code}: ${error.message}` }
        : { kind: 'transient', reason: `${error.code}: ${error.message}` };
    }

    if (error instanceof DomainError) {
      return { kind: 'permanent', reason: `${error.name}: ${error.message}` };
    }

    return { kind: 'transient', reason: messageOf(error) };
  }
}

function keyOf(delivery: InboxDelivery): InboxKey {
  return {
    consumerName: delivery.consumerName,
    providerId: delivery.providerId,
    messageId: delivery.messageId,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
