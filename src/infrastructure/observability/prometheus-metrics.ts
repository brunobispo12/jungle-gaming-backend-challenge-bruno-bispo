import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import type {
  MetricsExporter,
  MetricsPort,
  WagerMetricObservation,
} from '@/application/ports';
import type { OperationalMetricsSource } from './operational-metrics';

const PROCESSING_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const LOCK_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20];

export class PrometheusMetrics implements MetricsPort, MetricsExporter {
  private readonly registry = new Registry();
  private readonly transactions: Counter<'status' | 'kind' | 'source'>;
  private readonly duplicates: Counter<'layer'>;
  private readonly retries: Counter<'component' | 'reason'>;
  private readonly dlqRouted: Counter<'reason'>;
  private readonly lockWait: Histogram<'outcome'>;
  private readonly lockConflicts: Counter<'reason'>;
  private readonly processingDuration: Histogram<'source' | 'kind' | 'outcome'>;
  private readonly outboxPublishDuration: Histogram<'outcome'>;
  private readonly pendingReferenceAttempts: Counter<'outcome'>;
  private readonly reconciliationDivergences: Counter;
  private readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  private readonly httpRequestDuration: Histogram<'method' | 'route'>;

  constructor(source: OperationalMetricsSource) {
    const registers = [this.registry];

    this.transactions = new Counter({
      name: 'wager_transactions_total',
      help: 'Business transaction state transitions, excluding idempotent replays.',
      labelNames: ['status', 'kind', 'source'] as const,
      registers,
    });
    this.duplicates = new Counter({
      name: 'wager_duplicates_total',
      help: 'Duplicate deliveries detected by the persistent business or inbox identity.',
      labelNames: ['layer'] as const,
      registers,
    });
    this.retries = new Counter({
      name: 'wager_retries_total',
      help: 'Retries scheduled by asynchronous components.',
      labelNames: ['component', 'reason'] as const,
      registers,
    });
    this.dlqRouted = new Counter({
      name: 'sqs_dlq_routed_total',
      help: 'Messages explicitly routed to the dead-letter queue.',
      labelNames: ['reason'] as const,
      registers,
    });
    this.lockWait = new Histogram({
      name: 'wallet_lock_wait_seconds',
      help: 'Time spent acquiring the pessimistic wallet row lock.',
      labelNames: ['outcome'] as const,
      buckets: LOCK_BUCKETS,
      registers,
    });
    this.lockConflicts = new Counter({
      name: 'wallet_lock_conflicts_total',
      help: 'Wallet lock attempts aborted by PostgreSQL contention handling.',
      labelNames: ['reason'] as const,
      registers,
    });
    this.processingDuration = new Histogram({
      name: 'wager_processing_duration_seconds',
      help: 'End-to-end wager processing latency by entry channel and outcome.',
      labelNames: ['source', 'kind', 'outcome'] as const,
      buckets: PROCESSING_BUCKETS,
      registers,
    });
    this.outboxPublishDuration = new Histogram({
      name: 'outbox_publish_duration_seconds',
      help: 'Duration of an outbox publication attempt after a claim.',
      labelNames: ['outcome'] as const,
      buckets: PROCESSING_BUCKETS,
      registers,
    });
    this.pendingReferenceAttempts = new Counter({
      name: 'pending_reference_attempts_total',
      help: 'Pending-reference worker attempts by outcome.',
      labelNames: ['outcome'] as const,
      registers,
    });
    this.reconciliationDivergences = new Counter({
      name: 'wallet_reconciliation_divergences_total',
      help: 'Wallet reconciliations that found a materialized balance divergence.',
      registers,
    });
    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'HTTP responses by method, matched route and status code.',
      labelNames: ['method', 'route', 'status'] as const,
      registers,
    });
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency by method and matched route.',
      labelNames: ['method', 'route'] as const,
      buckets: PROCESSING_BUCKETS,
      registers,
    });

    const outboxPending = new Gauge({
      name: 'outbox_pending_messages',
      help: 'Current number of committed outbox messages awaiting publication.',
      registers,
      async collect() {
        this.set((await source.outboxState()).pending);
      },
    });
    const outboxOldestAge = new Gauge({
      name: 'outbox_oldest_pending_age_seconds',
      help: 'Age of the oldest committed outbox message awaiting publication.',
      registers,
      async collect() {
        this.set((await source.outboxState()).oldestAgeSeconds);
      },
    });
    const dlqVisible = new Gauge({
      name: 'sqs_dlq_visible_messages',
      help: 'Approximate number of messages currently visible in the wager DLQ.',
      registers,
      async collect() {
        this.set(await source.dlqVisibleMessages());
      },
    });

    void outboxPending;
    void outboxOldestAge;
    void dlqVisible;
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  exposition(): Promise<string> {
    return this.registry.metrics();
  }

  observeWager(observation: WagerMetricObservation): void {
    this.processingDuration
      .labels(observation.source, observation.kind, observation.outcome)
      .observe(observation.durationSeconds);

    if (observation.idempotentReplay === true) {
      this.recordDuplicate('business');
      return;
    }
    if (observation.status !== undefined) {
      this.transactions
        .labels(observation.status, observation.kind, observation.source)
        .inc();
    }
  }

  recordDuplicate(layer: 'business' | 'inbox'): void {
    this.duplicates.labels(layer).inc();
  }

  recordRetry(
    component: 'sqs-consumer' | 'pending-reference' | 'outbox',
    reason: string,
  ): void {
    this.retries.labels(component, reason).inc();
  }

  recordDlq(reason: string): void {
    this.dlqRouted.labels(reason).inc();
  }

  observeWalletLock(
    durationSeconds: number,
    outcome: 'acquired' | 'not_found' | 'lock_timeout' | 'deadlock' | 'error',
  ): void {
    this.lockWait.labels(outcome).observe(durationSeconds);
  }

  recordLockConflict(reason: 'lock_timeout' | 'deadlock'): void {
    this.lockConflicts.labels(reason).inc();
  }

  observeOutboxPublish(outcome: string, durationSeconds: number): void {
    this.outboxPublishDuration.labels(outcome).observe(durationSeconds);
  }

  recordPendingReference(outcome: string): void {
    this.pendingReferenceAttempts.labels(outcome).inc();
  }

  recordReconciliation(consistent: boolean): void {
    if (!consistent) {
      this.reconciliationDivergences.inc();
    }
  }

  observeHttp(method: string, route: string, status: number, durationSeconds: number): void {
    this.httpRequests.labels(method, route, String(status)).inc();
    this.httpRequestDuration.labels(method, route).observe(durationSeconds);
  }
}
