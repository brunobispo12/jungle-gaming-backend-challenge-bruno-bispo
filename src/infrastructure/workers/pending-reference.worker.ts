import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import type { ResolvePendingReferenceUseCase } from '@/application/use-cases/resolve-pending-reference';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { PollingLoop } from './polling-loop';

export interface PendingReferenceWorkerOptions {
  readonly enabled: boolean;
  readonly tickDelayMs: number;
  readonly errorDelayMs: number;
}

export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly loop: PollingLoop;

  constructor(
    resolve: ResolvePendingReferenceUseCase,
    logger: JsonLogger,
    options: PendingReferenceWorkerOptions,
  ) {
    this.loop = new PollingLoop(
      'pending-reference',
      async () => {
        const outcome = await resolve.run();
        if (outcome.kind === 'idle') {
          return false;
        }
        logger.write('info', 'pending reference attempted', {
          transactionId: outcome.transactionId,
          walletId: outcome.walletId,
          providerId: outcome.providerId,
          correlationId: outcome.correlationId,
          outcome: outcome.kind,
          ...(outcome.kind === 'settled'
            ? { status: outcome.status, failureCode: outcome.failureCode }
            : { attempts: outcome.attempts }),
        });
        return true;
      },
      logger,
      {
        enabled: options.enabled,
        idleDelayMs: options.tickDelayMs,
        errorDelayMs: options.errorDelayMs,
      },
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }
}
