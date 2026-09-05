import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { PollingLoop } from '@/infrastructure/workers/polling-loop';
import type { JsonLogger } from './json-logger';
import type { OperationalMetricsSource } from './operational-metrics';
import type { PrometheusMetrics } from './prometheus-metrics';

const TICK_MS = 15_000;

// Runs on every role, because the gauges describe cluster-wide state and a
// process that publishes or consumes has to stay scrapeable on its own. The
// three series are identical across instances, so PromQL reads them with max().
export class OperationalMetricsCollector implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(source: OperationalMetricsSource, metrics: PrometheusMetrics, logger: JsonLogger) {
    this.loop = new PollingLoop(
      'operational-metrics',
      async () => {
        const [outbox, dlqVisibleMessages] = await Promise.all([
          source.outboxState(),
          source.dlqVisibleMessages(),
        ]);

        metrics.observeOperationalState({ ...outbox, dlqVisibleMessages });
        return false;
      },
      logger,
      { enabled: true, idleDelayMs: TICK_MS, errorDelayMs: TICK_MS },
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }
}
