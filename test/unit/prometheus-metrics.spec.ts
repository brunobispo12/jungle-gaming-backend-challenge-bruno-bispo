import { describe, expect, test } from 'bun:test';

import type { OperationalMetricsSource } from '@/infrastructure/observability/operational-metrics';
import { PrometheusMetrics } from '@/infrastructure/observability/prometheus-metrics';

class FixedOperationalMetrics implements OperationalMetricsSource {
  async outboxState(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    return { pending: 2, oldestAgeSeconds: 7.5 };
  }

  async dlqVisibleMessages(): Promise<number> {
    return 3;
  }
}

describe('PrometheusMetrics', () => {
  test('expõe todas as famílias obrigatórias com labels de cardinalidade fechada', async () => {
    const metrics = new PrometheusMetrics(new FixedOperationalMetrics());

    metrics.observeWager({
      source: 'http',
      kind: 'BET',
      outcome: 'PROCESSED',
      status: 'PROCESSED',
      durationSeconds: 0.025,
    });
    metrics.observeWager({
      source: 'sqs',
      kind: 'BET',
      outcome: 'PROCESSED',
      status: 'PROCESSED',
      idempotentReplay: true,
      durationSeconds: 0.01,
    });
    metrics.recordDuplicate('inbox');
    metrics.recordRetry('sqs-consumer', 'transient');
    metrics.recordRetry('pending-reference', 'reference-missing');
    metrics.recordRetry('outbox', 'publish-failed');
    metrics.recordDlq('permanent');
    metrics.observeWalletLock(0.05, 'acquired');
    metrics.recordLockConflict('lock_timeout');
    metrics.observeOutboxPublish('published', 0.02);
    metrics.recordPendingReference('settled');
    metrics.recordReconciliation(false);
    metrics.observeHttp('POST', '/wagering/transactions', 201, 0.03);

    const exposition = await metrics.exposition();

    for (const name of [
      'wager_transactions_total',
      'wager_duplicates_total',
      'wager_retries_total',
      'sqs_dlq_routed_total',
      'sqs_dlq_visible_messages',
      'wallet_lock_wait_seconds',
      'wallet_lock_conflicts_total',
      'outbox_pending_messages',
      'outbox_oldest_pending_age_seconds',
      'outbox_publish_duration_seconds',
      'wager_processing_duration_seconds',
      'pending_reference_attempts_total',
      'wallet_reconciliation_divergences_total',
      'http_requests_total',
      'http_request_duration_seconds',
    ]) {
      expect(exposition).toContain(name);
    }

    expect(exposition).toContain('outbox_pending_messages 2');
    expect(exposition).toContain('outbox_oldest_pending_age_seconds 7.5');
    expect(exposition).toContain('sqs_dlq_visible_messages 3');
    expect(exposition).not.toContain('25.00');
  });
});
