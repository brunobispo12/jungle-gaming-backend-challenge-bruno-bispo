import type { EventContext } from '@/application/events/integration-event';
import { WagerTransactionRejected } from '@/application/events/wager-events';
import {
  NOOP_METRICS,
  type Clock,
  type IdGenerator,
  type MetricsPort,
  type Repositories,
  type UnitOfWork,
} from '@/application/ports';
import { FailureCode } from '@/domain/failure-code';
import type { WagerTransaction, WagerTransactionStatus } from '@/domain/wager-transaction';
import type { SubmitWagerTransactionUseCase } from './submit-wager-transaction';

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;
const MAX_ATTEMPTS = 100;

export function pendingReferenceBackoffMs(attempts: number, jitter: number): number {
  const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempts - 1));
  return Math.round(delay * (0.8 + jitter * 0.4));
}

export type PendingReferenceOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'rescheduled'; readonly transactionId: string; readonly attempts: number }
  | {
      readonly kind: 'settled';
      readonly transactionId: string;
      readonly status: WagerTransactionStatus;
      readonly failureCode?: FailureCode | undefined;
    };

export class ResolvePendingReferenceUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly submitWager: SubmitWagerTransactionUseCase,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly jitter: () => number,
    private readonly isTransientFailure: (error: unknown) => boolean,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {}

  async run(): Promise<PendingReferenceOutcome> {
    let attempted: string | undefined;
    let attemptedKind: string | undefined;
    const startedAt = performance.now();

    try {
      const outcome = await this.unitOfWork.transactional<PendingReferenceOutcome>(
        async (repositories) => {
          const now = this.clock.now();
          const pending = await repositories.wagerTransactions.lockDuePendingReference(now);
          if (pending === undefined) {
            return { kind: 'idle' };
          }
          attempted = pending.id;
          attemptedKind = pending.kind;

          const reference = await this.findReference(repositories, pending);
          if (reference === undefined && !isExhausted(pending, now)) {
            return this.reschedule(repositories, pending, now);
          }

          return this.settle(repositories, pending, now);
        },
      );
      this.observe(outcome, attemptedKind, startedAt);
      return outcome;
    } catch (error: unknown) {
      if (attempted === undefined || this.isTransientFailure(error)) {
        if (attempted !== undefined) {
          this.metrics.recordPendingReference('failed');
          this.metrics.recordRetry('pending-reference', 'transient-error');
        }
        throw error;
      }
      const outcome = await this.recordFailure(attempted, error);
      this.observe(outcome, attemptedKind, startedAt);
      return outcome;
    }
  }

  private observe(
    outcome: PendingReferenceOutcome,
    kind: string | undefined,
    startedAt: number,
  ): void {
    if (outcome.kind === 'idle') {
      return;
    }

    const metricOutcome =
      outcome.kind === 'rescheduled'
        ? 'rescheduled'
        : outcome.status === 'FAILED'
          ? 'failed'
          : 'settled';
    this.metrics.recordPendingReference(metricOutcome);
    if (outcome.kind === 'rescheduled') {
      this.metrics.recordRetry('pending-reference', 'reference-missing');
    }
    this.metrics.observeWager({
      source: 'pending-reference',
      kind: kind ?? 'UNKNOWN',
      outcome: outcome.kind === 'settled' ? outcome.status : outcome.kind,
      status: outcome.kind === 'settled' ? outcome.status : undefined,
      durationSeconds: (performance.now() - startedAt) / 1_000,
    });
  }

  // A deterministic failure would repeat every tick until the TTL and then be
  // reported as REFERENCE_NOT_FOUND, blaming the provider for our own defect.
  private async recordFailure(
    transactionId: string,
    error: unknown,
  ): Promise<PendingReferenceOutcome> {
    return this.unitOfWork.transactional(async (repositories) => {
      const now = this.clock.now();
      const pending = await repositories.wagerTransactions.lockById(transactionId);
      const wallet =
        pending === undefined ? undefined : await repositories.wallets.lockById(pending.walletId);

      if (pending === undefined || wallet === undefined || pending.isTerminal()) {
        throw error;
      }

      pending.fail({ resultBalance: wallet.balance, at: now });
      return this.rejected(repositories, pending, now, {
        eventId: this.ids.next(),
        correlationId: pending.correlationId,
        causationId: pending.id,
        occurredAt: now,
      });
    });
  }

  private findReference(
    repositories: Repositories,
    pending: WagerTransaction,
  ): Promise<WagerTransaction | undefined> {
    return repositories.wagerTransactions.findByExternalId(
      pending.providerId,
      pending.referenceExternalTransactionId ?? '',
    );
  }

  // A reschedule moves no money, so it never takes the wallet lock: an unrelated
  // pending must not queue behind whoever is spending that wallet right now.
  private async reschedule(
    repositories: Repositories,
    pending: WagerTransaction,
    now: Date,
  ): Promise<PendingReferenceOutcome> {
    const delay = pendingReferenceBackoffMs(pending.attempts + 1, this.jitter());
    pending.scheduleRetry({ nextAttemptAt: new Date(now.getTime() + delay) });
    await repositories.wagerTransactions.update(pending);

    return { kind: 'rescheduled', transactionId: pending.id, attempts: pending.attempts };
  }

  private async settle(
    repositories: Repositories,
    pending: WagerTransaction,
    now: Date,
  ): Promise<PendingReferenceOutcome> {
    const context: EventContext = {
      eventId: this.ids.next(),
      correlationId: pending.correlationId,
      causationId: pending.id,
      occurredAt: now,
    };

    const wallet = await repositories.wallets.lockById(pending.walletId);
    if (wallet === undefined) {
      pending.reject({ code: FailureCode.WalletNotFound, at: now });
      return this.rejected(repositories, pending, now, context);
    }

    // Re-read under the wallet lock: the reference may have landed while this
    // tick waited, and an expired pending still deserves the normal processing.
    const reference = await this.findReference(repositories, pending);
    if (reference === undefined) {
      pending.reject({
        code: FailureCode.ReferenceNotFound,
        resultBalance: wallet.balance,
        at: now,
      });
      return this.rejected(repositories, pending, now, context);
    }

    const result = await this.submitWager.applyResolvedReversal(
      repositories,
      pending,
      reference,
      wallet,
      now,
      context,
    );

    return {
      kind: 'settled',
      transactionId: result.transactionId,
      status: result.status,
      failureCode: result.failureCode,
    };
  }

  private async rejected(
    repositories: Repositories,
    pending: WagerTransaction,
    now: Date,
    context: EventContext,
  ): Promise<PendingReferenceOutcome> {
    await repositories.wagerTransactions.update(pending);
    await repositories.outbox.enqueue([WagerTransactionRejected.from(pending, context)], now);

    return {
      kind: 'settled',
      transactionId: pending.id,
      status: pending.status,
      failureCode: pending.failureCode,
    };
  }
}

function isExhausted(pending: WagerTransaction, now: Date): boolean {
  if (pending.attempts >= MAX_ATTEMPTS) {
    return true;
  }
  return pending.expiresAt !== undefined && now.getTime() >= pending.expiresAt.getTime();
}
