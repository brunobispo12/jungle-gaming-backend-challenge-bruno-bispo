import type { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';

import type { Clock, MetricsPort, UnitOfWork } from '@/application/ports';
import { ConsumeWagerMessageUseCase } from '@/application/use-cases/consume-wager-message';
import { SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import type { AppEnv } from '@/bootstrap/env';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { isTransientDatabaseFailure } from '@/infrastructure/persistence/postgres-errors';
import { APP_ENV, CLOCK, LOGGER, METRICS, SQS_CLIENT, UNIT_OF_WORK } from '@/infrastructure/tokens';
import { WageringModule } from '@/interface/http/wagering.module';
import { CONSUMER_NAME } from './envelope';
import { WagerConsumerWorker } from './wager-consumer.worker';

// Long polling at the SQS maximum: an idle consumer costs one request every 20 s
// instead of a busy loop, and a message arriving mid-wait is delivered at once.
const WAIT_TIME_SECONDS = 20;
const BATCH_SIZE = 10;

// Matches the VisibilityTimeout the queue is created with; the consumer restarts
// this window per message so a slow batch never hands a message back mid flight.
const VISIBILITY_TIMEOUT_SECONDS = 60;

// The reserve between the two is what pays for returning the visibility of a
// message the grace did not finish.
const IN_FLIGHT_GRACE_MS = 25_000;
const SHUTDOWN_WINDOW_MS = 30_000;

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: ConsumeWagerMessageUseCase,
      inject: [UNIT_OF_WORK, SubmitWagerTransactionUseCase, CLOCK, METRICS],
      useFactory: (
        unitOfWork: UnitOfWork,
        submitWager: SubmitWagerTransactionUseCase,
        clock: Clock,
        metrics: MetricsPort,
      ): ConsumeWagerMessageUseCase =>
        new ConsumeWagerMessageUseCase(
          unitOfWork,
          submitWager,
          clock,
          isTransientDatabaseFailure,
          metrics,
        ),
    },
    {
      provide: WagerConsumerWorker,
      inject: [SQS_CLIENT, ConsumeWagerMessageUseCase, LOGGER, APP_ENV, METRICS],
      useFactory: (
        sqs: SQSClient,
        consume: ConsumeWagerMessageUseCase,
        logger: JsonLogger,
        env: AppEnv,
        metrics: MetricsPort,
      ): WagerConsumerWorker =>
        new WagerConsumerWorker(sqs, consume, logger.child({ worker: 'sqs-consumer' }), {
          enabled: env.roles.includes('consumer'),
          consumerName: CONSUMER_NAME,
          inputQueue: env.queues.input,
          dlqQueue: env.queues.dlq,
          batchSize: BATCH_SIZE,
          waitTimeSeconds: WAIT_TIME_SECONDS,
          visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
          inFlightGraceMs: IN_FLIGHT_GRACE_MS,
          shutdownWindowMs: SHUTDOWN_WINDOW_MS,
        }, metrics),
    },
  ],
})
export class SqsModule {}
