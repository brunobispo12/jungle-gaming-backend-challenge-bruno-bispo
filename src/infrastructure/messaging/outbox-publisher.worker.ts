import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import type { PublishOutboxMessageUseCase } from '@/application/use-cases/publish-outbox-message';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { PollingLoop } from '@/infrastructure/workers/polling-loop';

export interface OutboxPublisherWorkerOptions {
  readonly enabled: boolean;
  readonly idleDelayMs: number;
  readonly errorDelayMs: number;
}

export class OutboxPublisherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    publish: PublishOutboxMessageUseCase,
    logger: JsonLogger,
    options: OutboxPublisherWorkerOptions,
  ) {
    this.loop = new PollingLoop(
      'outbox-publisher',
      async () => (await publish.run()) !== 'idle',
      logger,
      options,
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }
}
