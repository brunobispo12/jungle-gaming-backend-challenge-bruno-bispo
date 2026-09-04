import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import { PublishOutboxMessageUseCase } from '@/application/use-cases/publish-outbox-message';
import type { MetricsPort } from '@/application/ports';
import type { AppEnv } from '@/bootstrap/env';
import { SystemClock } from '@/infrastructure/adapters';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { MikroOutboxClaimRepository } from '@/infrastructure/persistence/outbox-claim.repository';
import { APP_ENV, LOGGER, METRICS, ORM, SQS_CLIENT } from '@/infrastructure/tokens';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { SqsEventPublisher } from './sqs-event-publisher';

// The send timeout stays well below the lease so a publisher gives up on a stuck
// call while it still owns the row, instead of racing whoever took it over.
const LEASE_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;
const IDLE_DELAY_MS = 500;
const ERROR_DELAY_MS = 2_000;

@Module({
  providers: [
    {
      provide: PublishOutboxMessageUseCase,
      inject: [ORM, SQS_CLIENT, APP_ENV, METRICS],
      useFactory: (
        orm: MikroORM,
        sqs: SQSClient,
        env: AppEnv,
        metrics: MetricsPort,
      ): PublishOutboxMessageUseCase =>
        new PublishOutboxMessageUseCase(
          new MikroOutboxClaimRepository(orm),
          new SqsEventPublisher(sqs, env.queues.events, SEND_TIMEOUT_MS),
          new SystemClock(),
          { publisherId: env.instanceId, leaseMs: LEASE_MS },
          Math.random,
          metrics,
        ),
    },
    {
      provide: OutboxPublisherWorker,
      inject: [PublishOutboxMessageUseCase, LOGGER, APP_ENV],
      useFactory: (
        publish: PublishOutboxMessageUseCase,
        logger: JsonLogger,
        env: AppEnv,
      ): OutboxPublisherWorker =>
        new OutboxPublisherWorker(publish, logger.child({ worker: 'outbox-publisher' }), {
          enabled: env.roles.includes('outbox-publisher'),
          idleDelayMs: IDLE_DELAY_MS,
          errorDelayMs: ERROR_DELAY_MS,
        }),
    },
  ],
})
export class MessagingModule {}
